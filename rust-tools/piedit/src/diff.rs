//! Byte-identical Rust port of the diff/patch rendering the built-in `edit`
//! tool performs in TypeScript (`dist/core/tools/edit-diff.js`), which is a
//! thin layer over the bundled jsdiff v8:
//!
//!   - `tokenize` (line mode): `value.split(/(\n|\r\n)/)`, separators kept
//!     and appended to the preceding line, one trailing `""` piece dropped.
//!   - `Diff#diffWithOptionsObj`: the greedy Myers walk with jsdiff's exact
//!     tie-break (`!canRemove || (canAdd && removePath.oldPos < addPath.oldPos)`),
//!     component coalescing in `addToPath`, `extractCommon` sliding, and the
//!     `minDiagonalToConsider`/`maxDiagonalToConsider` pruning. Components
//!     live in an arena; `previousComponent` chains are the linked list.
//!   - `generate_diff_string`: pi's numbered display diff (`+N line`,
//!     `-N line`, ` N line`, ` ...` elision, `firstChangedLine`).
//!   - `generate_unified_patch`: jsdiff `structuredPatch` (context=4, the
//!     `{value:"",lines:[]}` sentinel, hunk close rules) + `formatPatch` with
//!     `FILE_HEADERS_ONLY` (`--- path` / `+++ path` headers, `\ No newline
//!     at end of file` markers).
//!
//! Parity is pinned by `tests/piedit-parity.test.mjs` (deterministic corpus +
//! seeded differential fuzz against the exported TS helpers) — that suite is
//! the arbiter, per spec R2. Inputs are always LF-normalized upstream, so
//! `\r` never reaches here in practice; the tokenizer still mirrors the
//! `\r\n` separator semantics exactly.

// ---- jsdiff line tokenizer ----

/// jsdiff `LineDiff` `tokenize`: pieces of `value.split(/(\n|\r\n)/)` with the
/// separator pieces appended to the preceding line. Tokens are `"line\n"`
/// except possibly the last (no trailing newline); an empty input yields no
/// tokens (the trailing `""` piece is popped). A `\r` before a `\n` joins
/// its line token either way, so one pass over `\n` boundaries is exact.
fn tokenize_lines(value: &str) -> Vec<&str> {
    // A plain byte loop measured fastest here (the char-pattern searchers
    // decode UTF-8 as they scan; ~0.5 ms per 590 KB for this loop).
    let bytes = value.as_bytes();
    let mut tokens: Vec<&str> = Vec::with_capacity(bytes.len() / 8 + 2);
    let mut start = 0;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            tokens.push(&value[start..i + 1]);
            start = i + 1;
        }
    }
    if start < value.len() {
        tokens.push(&value[start..]);
    }
    // `removeEmpty`: line tokens are never empty (empty content only ever
    // precedes its separator, and a trailing `""` was popped), but mirror it.
    tokens.retain(|t| !t.is_empty());
    tokens
}

// ---- jsdiff Myers core ----

/// One component in the diff path chain (jsdiff `lastComponent`).
#[derive(Debug, Clone, Copy)]
struct Component {
    count: usize,
    added: bool,
    removed: bool,
    prev: Option<usize>,
}

/// A path head on one diagonal (jsdiff `bestPath[diagonal]`).
#[derive(Debug, Clone, Copy)]
struct Path {
    old_pos: isize,
    last: Option<usize>,
}

/// One output part (jsdiff change object; equal parts have both flags false).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinePart {
    pub value: String,
    pub added: bool,
    pub removed: bool,
}

/// jsdiff `extractCommon`: slide over equal tokens, then append one equal
/// component (only when something was common). Returns the new `newPos`.
fn extract_common(
    path: &mut Path,
    new_tokens: &[&str],
    old_tokens: &[&str],
    diagonal: isize,
    arena: &mut Vec<Component>,
) -> isize {
    let new_len = new_tokens.len() as isize;
    let old_len = old_tokens.len() as isize;
    let mut old_pos = path.old_pos;
    let mut new_pos = old_pos - diagonal;
    let mut common = 0usize;
    while new_pos + 1 < new_len
        && old_pos + 1 < old_len
        && old_tokens[(old_pos + 1) as usize] == new_tokens[(new_pos + 1) as usize]
    {
        new_pos += 1;
        old_pos += 1;
        common += 1;
    }
    if common > 0 {
        let idx = arena.len();
        arena.push(Component { count: common, added: false, removed: false, prev: path.last });
        path.last = Some(idx);
    }
    path.old_pos = old_pos;
    new_pos
}

/// jsdiff `addToPath`: extend the previous component when it has the same
/// `added`/`removed` flags (chaining to its own `previousComponent`), else
/// push a fresh one.
fn add_to_path(
    arena: &mut Vec<Component>,
    path: &Path,
    added: bool,
    removed: bool,
    old_pos_inc: isize,
) -> Path {
    if let Some(last) = path.last {
        let c = &arena[last];
        if c.added == added && c.removed == removed {
            let prev = c.prev;
            let count = c.count + 1;
            arena.push(Component { count, added, removed, prev });
            return Path { old_pos: path.old_pos + old_pos_inc, last: Some(arena.len() - 1) };
        }
    }
    let prev = path.last;
    arena.push(Component { count: 1, added, removed, prev });
    Path { old_pos: path.old_pos + old_pos_inc, last: Some(arena.len() - 1) }
}

/// jsdiff `buildValues`: walk the component chain (newest → oldest), reverse,
/// then assign values from the token slices in document order.
fn build_values(
    arena: Vec<Component>,
    last: Option<usize>,
    new_tokens: &[&str],
    old_tokens: &[&str],
) -> Vec<LinePart> {
    let mut chain: Vec<usize> = Vec::new();
    let mut cur = last;
    while let Some(i) = cur {
        chain.push(i);
        cur = arena[i].prev;
    }
    chain.reverse();

    let mut parts: Vec<LinePart> = Vec::with_capacity(chain.len());
    let mut new_pos = 0usize;
    let mut old_pos = 0usize;
    for ci in chain {
        let c = arena[ci];
        if c.removed {
            parts.push(LinePart {
                value: old_tokens[old_pos..old_pos + c.count].concat(),
                added: false,
                removed: true,
            });
            old_pos += c.count;
        } else {
            parts.push(LinePart {
                value: new_tokens[new_pos..new_pos + c.count].concat(),
                added: c.added,
                removed: false,
            });
            new_pos += c.count;
            if !c.added {
                old_pos += c.count;
            }
        }
    }
    parts
}

/// jsdiff `diffLines(oldStr, newStr)` with default options: line tokens,
/// strict equality, no callback, no timeout. Returns the ordered parts.
pub fn diff_lines(old: &str, new: &str) -> Vec<LinePart> {
    let old_tokens = tokenize_lines(old);
    let new_tokens = tokenize_lines(new);
    let old_len = old_tokens.len();
    let new_len = new_tokens.len();
    let max_edit = old_len + new_len;

    let mut arena: Vec<Component> = Vec::new();
    // Index by `diagonal + offset`; diagonals span [-max_edit-1, max_edit+1].
    let offset = max_edit as isize + 1;
    let mut best: Vec<Option<Path>> = vec![None; 2 * max_edit + 3];

    // Initial path on diagonal 0.
    let mut p0 = Path { old_pos: -1, last: None };
    let new_pos = extract_common(&mut p0, &new_tokens, &old_tokens, 0, &mut arena);
    best[offset as usize] = Some(p0);
    if p0.old_pos + 1 >= old_len as isize && new_pos + 1 >= new_len as isize {
        return build_values(arena, p0.last, &new_tokens, &old_tokens);
    }

    let mut min_diag = isize::MIN;
    let mut max_diag = isize::MAX;
    let mut terminal: Option<usize> = None;
    'outer: for edit_length in 1..=max_edit {
        let el = edit_length as isize;
        let mut d = min_diag.max(-el);
        let d_hi = max_diag.min(el);
        while d <= d_hi {
            let idx = (d + offset) as usize;
            let remove_path = best[idx - 1].take(); // read, then clear
            let add_path = best[idx + 1];

            let can_add = add_path.is_some_and(|ap| {
                let n = ap.old_pos - d;
                (0..new_len as isize).contains(&n)
            });
            let can_remove = remove_path.is_some_and(|rp| rp.old_pos + 1 < old_len as isize);
            if !can_add && !can_remove {
                best[idx] = None;
                d += 2;
                continue;
            }
            let mut base = if !can_remove
                || (can_add
                    && remove_path.unwrap().old_pos < add_path.unwrap().old_pos)
            {
                add_to_path(&mut arena, add_path.as_ref().unwrap(), true, false, 0)
            } else {
                add_to_path(&mut arena, remove_path.as_ref().unwrap(), false, true, 1)
            };
            let new_pos = extract_common(&mut base, &new_tokens, &old_tokens, d, &mut arena);
            if base.old_pos + 1 >= old_len as isize && new_pos + 1 >= new_len as isize {
                terminal = base.last;
                break 'outer;
            }
            best[idx] = Some(base);
            if base.old_pos + 1 >= old_len as isize {
                max_diag = max_diag.min(d - 1);
            }
            if new_pos + 1 >= new_len as isize {
                min_diag = min_diag.max(d + 1);
            }
            d += 2;
        }
    }
    // maxEditLength = old_len + new_len always suffices for termination.
    build_values(arena, Some(terminal.expect("Myers terminates by maxEditLength")), &new_tokens, &old_tokens)
}

// ---- pi `generateDiffString` ----

/// Mirror of the exported TS helper (context = 4): the numbered display diff
/// plus the first changed line number in the NEW content. TS-mirror API for
/// the test suite; production renders via `render_details`.
#[cfg(test)]
pub fn generate_diff_string(old_content: &str, new_content: &str) -> (String, Option<usize>) {
    let parts = diff_lines(old_content, new_content);
    generate_diff_string_from_parts(&parts, old_content, new_content)
}

/// `generate_diff_string` over precomputed parts (shares one `diff_lines`
/// run with `generate_unified_patch_from_parts`).
fn generate_diff_string_from_parts(
    parts: &[LinePart],
    old_content: &str,
    new_content: &str,
) -> (String, Option<usize>) {
    const CONTEXT: usize = 4;
    let old_lines_len = old_content.split('\n').count();
    let new_lines_len = new_content.split('\n').count();
    let line_num_width = old_lines_len.max(new_lines_len).to_string().len();

    let pad = |n: usize| format!("{n:>line_num_width$}");

    let mut output: Vec<String> = Vec::new();
    let mut old_line_num = 1usize;
    let mut new_line_num = 1usize;
    let mut last_was_change = false;
    let mut first_changed_line: Option<usize> = None;

    for i in 0..parts.len() {
        let part = &parts[i];
        if part.added || part.removed {
            if first_changed_line.is_none() {
                first_changed_line = Some(new_line_num);
            }
            for line in raw_lines(&part.value) {
                if part.added {
                    output.push(format!("+{} {}", pad(new_line_num), line));
                    new_line_num += 1;
                } else {
                    output.push(format!("-{} {}", pad(old_line_num), line));
                    old_line_num += 1;
                }
            }
            last_was_change = true;
            continue;
        }

        let next_part_is_change =
            i + 1 < parts.len() && (parts[i + 1].added || parts[i + 1].removed);
        let has_leading_change = last_was_change;
        let has_trailing_change = next_part_is_change;

        // Context (equal) parts only ever surface their first/last CONTEXT
        // lines (or all ≤ 2·CONTEXT of them) plus a count — a 60k-line part
        // must not cost a 60k-slice vector.
        let view = RawLinesView::new(&part.value);
        let len = view.len();
        if has_leading_change && has_trailing_change {
            if len <= CONTEXT * 2 {
                for line in view.all() {
                    output.push(format!(" {} {}", pad(old_line_num), line));
                    old_line_num += 1;
                    new_line_num += 1;
                }
            } else {
                let leading = view.head(CONTEXT);
                let trailing = view.tail(CONTEXT);
                let skipped = len - leading.len() - trailing.len();
                for line in leading {
                    output.push(format!(" {} {}", pad(old_line_num), line));
                    old_line_num += 1;
                    new_line_num += 1;
                }
                output.push(format!("{} ...", pad_spaces(line_num_width)));
                old_line_num += skipped;
                new_line_num += skipped;
                for line in trailing {
                    output.push(format!(" {} {}", pad(old_line_num), line));
                    old_line_num += 1;
                    new_line_num += 1;
                }
            }
        } else if has_leading_change {
            let shown = view.head(len.min(CONTEXT));
            let skipped = len - shown.len();
            for line in shown {
                output.push(format!(" {} {}", pad(old_line_num), line));
                old_line_num += 1;
                new_line_num += 1;
            }
            if skipped > 0 {
                output.push(format!("{} ...", pad_spaces(line_num_width)));
                old_line_num += skipped;
                new_line_num += skipped;
            }
        } else if has_trailing_change {
            let skipped = len.saturating_sub(CONTEXT);
            if skipped > 0 {
                output.push(format!("{} ...", pad_spaces(line_num_width)));
                old_line_num += skipped;
                new_line_num += skipped;
            }
            for line in view.tail(len - skipped) {
                output.push(format!(" {} {}", pad(old_line_num), line));
                old_line_num += 1;
                new_line_num += 1;
            }
        } else {
            old_line_num += len;
            new_line_num += len;
        }
        last_was_change = false;
    }

    (output.join("\n"), first_changed_line)
}

/// `value.split('\n')` with one trailing `""` element popped — the `raw`
/// array of the TS render loop. Used for change parts (small).
fn raw_lines(value: &str) -> Vec<&str> {
    let mut raw: Vec<&str> = value.split('\n').collect();
    if raw.last() == Some(&"") {
        raw.pop();
    }
    raw
}

/// Equal-part `raw` without materializing it: the line count plus the first
/// and last `K = 2·CONTEXT` line boundaries (the render only ever shows
/// `CONTEXT` from either end, or everything when the part is short — short
/// parts are fully covered by `head`, which collects up to K starts).
struct RawLinesView<'a> {
    value: &'a str,
    len: usize,
    /// Byte offsets of the first ≤ K line starts.
    head_starts: [usize; 8],
    head_n: usize,
    /// Byte offsets of the last ≤ K newlines, newest first.
    tail_nls: [usize; 8],
    tail_n: usize,
}

impl<'a> RawLinesView<'a> {
    fn new(value: &'a str) -> Self {
        const K: usize = 8;
        let bytes = value.as_bytes();
        let mut len = 0usize;
        let mut head_starts = [0usize; K];
        let mut head_n = 0usize;
        let mut start = 0usize;
        for (i, &b) in bytes.iter().enumerate() {
            if b == b'\n' {
                if head_n < K {
                    head_starts[head_n] = start;
                    head_n += 1;
                }
                len += 1;
                start = i + 1;
            }
        }
        if start < value.len() {
            if head_n < K {
                head_starts[head_n] = start;
                head_n += 1;
            }
            len += 1;
        }
        let mut tail_nls = [0usize; K];
        let mut tail_n = 0usize;
        let mut i = bytes.len();
        while tail_n < K && i > 0 {
            i -= 1;
            if bytes[i] == b'\n' {
                tail_nls[tail_n] = i;
                tail_n += 1;
            }
        }
        Self { value, len, head_starts, head_n, tail_nls, tail_n }
    }

    fn len(&self) -> usize {
        self.len
    }

    /// Lines `0..n` (callers request at most `2·CONTEXT = 8`).
    fn head(&self, n: usize) -> Vec<&'a str> {
        let n = n.min(self.head_n);
        let mut out: Vec<&'a str> = Vec::with_capacity(n);
        for k in 0..n {
            let s = self.head_starts[k];
            let e = if k + 1 < self.head_n {
                self.head_starts[k + 1] - 1
            } else {
                // last collected start: scan forward to its newline
                self.value[s..].find('\n').map_or(self.value.len(), |p| s + p)
            };
            out.push(&self.value[s..e]);
        }
        out
    }

    /// The last `n` lines (callers request at most `2·CONTEXT = 8`). The
    /// window starts after the newline ending line `len-n-1` — newline
    /// `idx` counted from the end — so the split yields exactly `n` lines.
    fn tail(&self, n: usize) -> Vec<&'a str> {
        let n = n.min(self.len);
        if n == 0 {
            return Vec::new();
        }
        let idx = if self.value.ends_with('\n') { n } else { n - 1 };
        let start = if self.len - n >= 1 && idx < self.tail_n {
            self.tail_nls[idx] + 1
        } else {
            0
        };
        let mut v: Vec<&str> = self.value[start..].split('\n').collect();
        if v.last() == Some(&"") {
            v.pop();
        }
        debug_assert_eq!(v.len(), n, "tail window must hold exactly n lines");
        v
    }

    /// All lines (only called when `len <= 2·CONTEXT`).
    fn all(&self) -> Vec<&'a str> {
        self.head(self.len)
    }
}

/// The elision line: `" "` + `lineNumWidth` spaces + `" ..."` (JS template
/// `` ` ${"".padStart(width, " ")} ...` ``).
fn pad_spaces(width: usize) -> String {
    format!(" {}", " ".repeat(width))
}

// ---- jsdiff `splitLines` (used by structuredPatch) ----

/// `text.split("\n").map(l => l + "\n")`, dropping the trailing empty piece
/// when the text ends with `\n`, else the last piece loses its `\n`.
/// Empty input yields `[""]` (mirroring the JS exactly; unreachable for real
/// parts, which never have empty values).
fn split_lines_keep_end(value: &str) -> Vec<&str> {
    if value.is_empty() {
        return vec![""];
    }
    let bytes = value.as_bytes();
    let has_trailing_nl = bytes[bytes.len() - 1] == b'\n';
    let mut out: Vec<&str> = Vec::new();
    let mut start = 0;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            out.push(&value[start..i + 1]);
            start = i + 1;
        }
    }
    if !has_trailing_nl {
        out.push(&value[start..]);
    }
    out
}

// ---- jsdiff `structuredPatch` + `formatPatch` (FILE_HEADERS_ONLY) ----

struct Hunk {
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    /// Lines with prefix and (initially) trailing `\n` intact.
    lines: Vec<String>,
}

/// Mirror of `generateUnifiedPatch(path, old, new)` — `createTwoFilesPatch`
/// with `{context: 4, headerOptions: FILE_HEADERS_ONLY}` and no headers.
/// TS-mirror API for the test suite; production renders via `render_details`.
#[cfg(test)]
pub fn generate_unified_patch(path: &str, old_content: &str, new_content: &str) -> String {
    let parts = diff_lines(old_content, new_content);
    generate_unified_patch_from_parts(path, &parts)
}

/// One shared `diff_lines` run feeding both renders — the TS helpers each
/// re-diff internally, but the parts are identical by construction, so the
/// edit pipeline renders both from a single Myers pass.
pub fn render_details(
    path: &str,
    old_content: &str,
    new_content: &str,
) -> (String, String, Option<usize>) {
    let parts = diff_lines(old_content, new_content);
    let (diff, first_changed_line) =
        generate_diff_string_from_parts(&parts, old_content, new_content);
    let patch = generate_unified_patch_from_parts(path, &parts);
    (diff, patch, first_changed_line)
}

/// `generate_unified_patch` over precomputed parts.
fn generate_unified_patch_from_parts(path: &str, diff: &[LinePart]) -> String {
    const CONTEXT: usize = 4;
    // Precompute per-part lines (`current.lines`), push the sentinel part.
    let mut parts: Vec<(Vec<&str>, bool, bool)> = diff
        .iter()
        .map(|p| (split_lines_keep_end(&p.value), p.added, p.removed))
        .collect();
    parts.push((Vec::new(), false, false)); // sentinel {value:"", lines:[]}

    let mut hunks: Vec<Hunk> = Vec::new();
    let mut old_range_start = 0usize;
    let mut new_range_start = 0usize;
    let mut cur_range: Vec<String> = Vec::new();
    let mut old_line = 1usize;
    let mut new_line = 1usize;

    for i in 0..parts.len() {
        let (lines, added, removed) = (&parts[i].0, parts[i].1, parts[i].2);
        if added || removed {
            if old_range_start == 0 {
                old_range_start = old_line;
                new_range_start = new_line;
                if i > 0 {
                    let prev = &parts[i - 1].0;
                    let from = prev.len().saturating_sub(CONTEXT);
                    let ctx: Vec<String> =
                        prev[from..].iter().map(|l| format!(" {l}")).collect();
                    old_range_start -= ctx.len();
                    new_range_start -= ctx.len();
                    cur_range = ctx;
                }
            }
            let prefix = if added { "+" } else { "-" };
            for line in lines {
                cur_range.push(format!("{prefix}{line}"));
            }
            if added {
                new_line += lines.len();
            } else {
                old_line += lines.len();
            }
        } else {
            if old_range_start != 0 {
                if lines.len() <= CONTEXT * 2 && i < parts.len() - 2 {
                    for line in lines {
                        cur_range.push(format!(" {line}"));
                    }
                } else {
                    let context_size = lines.len().min(CONTEXT);
                    for line in &lines[..context_size] {
                        cur_range.push(format!(" {line}"));
                    }
                    hunks.push(Hunk {
                        old_start: old_range_start,
                        old_lines: old_line - old_range_start + context_size,
                        new_start: new_range_start,
                        new_lines: new_line - new_range_start + context_size,
                        lines: std::mem::take(&mut cur_range),
                    });
                    old_range_start = 0;
                    new_range_start = 0;
                }
            }
            old_line += lines.len();
            new_line += lines.len();
        }
    }

    // Strip trailing newlines; mark missing end-of-file newlines.
    for hunk in &mut hunks {
        let mut i = 0;
        while i < hunk.lines.len() {
            if hunk.lines[i].ends_with('\n') {
                hunk.lines[i].pop();
            } else {
                hunk.lines.insert(i + 1, "\\ No newline at end of file".to_string());
                i += 1;
            }
            i += 1;
        }
    }

    // formatPatch with FILE_HEADERS_ONLY: file headers, no index/underline.
    let mut ret: Vec<String> = vec![format!("--- {path}"), format!("+++ {path}")];
    for hunk in hunks {
        let old_start = if hunk.old_lines == 0 { hunk.old_start - 1 } else { hunk.old_start };
        let new_start = if hunk.new_lines == 0 { hunk.new_start - 1 } else { hunk.new_start };
        ret.push(format!(
            "@@ -{old_start},{} +{new_start},{} @@",
            hunk.old_lines, hunk.new_lines
        ));
        ret.extend(hunk.lines);
    }
    let mut out = ret.join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(old: &str, new: &str) -> Vec<(String, bool, bool)> {
        diff_lines(old, new)
            .into_iter()
            .map(|p| (p.value, p.added, p.removed))
            .collect()
    }

    #[test]
    fn tokenizer_matches_jsdiff_pieces() {
        assert_eq!(tokenize_lines("abc"), ["abc"]);
        assert_eq!(tokenize_lines("abc\n"), ["abc\n"]);
        assert_eq!(tokenize_lines("a\nb"), ["a\n", "b"]);
        assert_eq!(tokenize_lines("a\n\nb"), ["a\n", "\n", "b"]);
        assert_eq!(tokenize_lines("\n"), ["\n"]);
        assert_eq!(tokenize_lines(""), Vec::<&str>::new());
        assert_eq!(tokenize_lines("a\r\nb"), ["a\r\n", "b"]);
        assert_eq!(tokenize_lines("a\rb\n"), ["a\rb\n"]);
    }

    #[test]
    fn split_lines_keep_end_matches_jsdiff() {
        assert_eq!(split_lines_keep_end("a\nb\n"), ["a\n", "b\n"]);
        assert_eq!(split_lines_keep_end("a\nb"), ["a\n", "b"]);
        assert_eq!(split_lines_keep_end("\n"), ["\n"]);
        assert_eq!(split_lines_keep_end("a\n"), ["a\n"]);
        assert_eq!(split_lines_keep_end("a"), ["a"]);
        assert_eq!(split_lines_keep_end(""), [""]);
    }

    #[test]
    fn diff_simple_replace() {
        // a\nb\n → a\nc\n : equal, removed, added
        assert_eq!(
            parts("a\nb\n", "a\nc\n"),
            vec![
                ("a\n".into(), false, false),
                ("b\n".into(), false, true),
                ("c\n".into(), true, false),
            ]
        );
    }

    #[test]
    fn diff_pure_insert_and_delete() {
        assert_eq!(
            parts("a\n", "a\nx\n"),
            vec![("a\n".into(), false, false), ("x\n".into(), true, false)]
        );
        assert_eq!(
            parts("a\nx\n", "a\n"),
            vec![("a\n".into(), false, false), ("x\n".into(), false, true)]
        );
        assert_eq!(parts("a\n", "a\n"), vec![("a\n".into(), false, false)]);
        assert!(parts("", "").is_empty());
        assert_eq!(parts("", "x\n"), vec![("x\n".into(), true, false)]);
        assert_eq!(parts("x\n", ""), vec![("x\n".into(), false, true)]);
    }

    #[test]
    fn diff_repeated_blocks_pick_unique_alignment() {
        // Repeated content forces the Myers tie-break; the JS oracle renders
        // " 1 x / 2 x / 3 x / -4 y / +4 z / 5 x / 6 x / 7 x" — exactly this
        // 4-part split (equal, removed, added, equal).
        let old = "x\nx\nx\ny\nx\nx\nx\n";
        let new = "x\nx\nx\nz\nx\nx\nx\n";
        assert_eq!(
            parts(old, new),
            vec![
                ("x\nx\nx\n".into(), false, false),
                ("y\n".into(), false, true),
                ("z\n".into(), true, false),
                ("x\nx\nx\n".into(), false, false),
            ]
        );
    }

    #[test]
    fn diff_no_newline_at_eof() {
        assert_eq!(
            parts("a\nb", "a\nc"),
            vec![
                ("a\n".into(), false, false),
                ("b".into(), false, true),
                ("c".into(), true, false),
            ]
        );
    }

    #[test]
    fn diff_string_numbering_and_elision() {
        // 12 lines, first line changed: the trailing 11-line equal part shows
        // 4 context lines then elides. Width is 2 (split("\n") counts the
        // trailing empty piece → 13 → width 2), hence "- 1 l0".
        let old: String = (0..12).map(|i| format!("l{i}\n")).collect();
        let mut new = old.clone();
        new.replace_range(0..3, "L0\n");
        let (diff, first) = generate_diff_string(&old, &new);
        assert_eq!(first, Some(1));
        assert_eq!(diff, "- 1 l0\n+ 1 L0\n  2 l1\n  3 l2\n  4 l3\n  5 l4\n    ...");
    }

    #[test]
    fn diff_string_first_changed_line_in_new_file() {
        let old = "a\nb\nc\nd\ne\nf\ng\nh\n";
        let new = "a\nb\nX\nd\ne\nf\ng\nh\n";
        let (diff, first) = generate_diff_string(old, new);
        assert_eq!(first, Some(3));
        assert!(diff.starts_with(" 1 a\n 2 b\n-3 c\n+3 X\n 4 d"));
        assert!(diff.ends_with(" 7 g\n   ...")); // width 1: 3 spaces + dots
    }

    #[test]
    fn unified_patch_single_change() {
        let p = generate_unified_patch("f.txt", "a\nb\nc\n", "a\nB\nc\n");
        assert_eq!(
            p,
            "--- f.txt\n+++ f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n"
        );
    }

    #[test]
    fn unified_patch_two_hunks_and_context() {
        let old: String = (0..30).map(|i| format!("l{i}\n")).collect();
        let new = old.replacen("l1\n", "X\n", 1).replacen("l28\n", "Z\n", 1);
        let p = generate_unified_patch("f", &old, &new);
        assert_eq!(
            p,
            "--- f\n+++ f\n@@ -1,6 +1,6 @@\n l0\n-l1\n+X\n l2\n l3\n l4\n l5\n@@ -25,6 +25,6 @@\n l24\n l25\n l26\n l27\n-l28\n+Z\n l29\n"
        );
    }

    #[test]
    fn unified_patch_no_newline_at_eof() {
        let p = generate_unified_patch("f", "a\nend", "a\nEND");
        assert_eq!(
            p,
            "--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-end\n\\ No newline at end of file\n+END\n\\ No newline at end of file\n"
        );
    }

    #[test]
    fn unified_patch_zero_side_headers() {
        // Pure insertion into an empty base: oldLines = 0 → oldStart 1-1 = 0.
        assert_eq!(
            generate_unified_patch("f", "", "a\nb\n"),
            "--- f\n+++ f\n@@ -0,0 +1,2 @@\n+a\n+b\n"
        );
        // Pure deletion to an empty result: newLines = 0 → newStart 0.
        assert_eq!(
            generate_unified_patch("f", "a\nb\n", ""),
            "--- f\n+++ f\n@@ -1,2 +0,0 @@\n-a\n-b\n"
        );
        // Insertion with surrounding context keeps ordinary ranges.
        assert_eq!(
            generate_unified_patch("f", "b\n", "a\nb\n"),
            "--- f\n+++ f\n@@ -1,1 +1,2 @@\n+a\n b\n"
        );
        assert_eq!(
            generate_unified_patch("f", "a\nb\n", "a\n"),
            "--- f\n+++ f\n@@ -1,2 +1,1 @@\n a\n-b\n"
        );
    }

    #[test]
    fn unified_patch_empty_diff_headers_only() {
        let p = generate_unified_patch("f", "a\n", "a\n");
        assert_eq!(p, "--- f\n+++ f\n");
    }

    #[test]
    fn display_diff_gap_boundary_at_double_context() {
        // Both changes sit near the file's end; the leading 10-line equal
        // part elides in BOTH variants (trailing-change branch), so the
        // distinguishing ellipsis is the middle one: an 8-line gap between
        // the changes shows whole (one "..." total), a 9-line gap elides
        // (two "..."). Pinned against the TS oracle render.
        let old: String = (0..20).map(|i| format!("o{i}\n")).collect();
        let (g8, f8) =
            generate_diff_string(&old, &old.replacen("o10\n", "A\n", 1).replacen("o19\n", "B\n", 1));
        assert_eq!(f8, Some(11));
        assert_eq!(g8.matches("...").count(), 1);
        assert!(g8.contains("-11 o10\n+11 A\n 12 o11\n 13 o12\n 14 o13\n 15 o14\n 16 o15\n 17 o16\n 18 o17\n 19 o18\n-20 o19"));
        let (g9, f9) =
            generate_diff_string(&old, &old.replacen("o9\n", "A\n", 1).replacen("o19\n", "B\n", 1));
        assert_eq!(f9, Some(10));
        assert_eq!(g9.matches("...").count(), 2);
    }
}

