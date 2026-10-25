/** Read-coverage model (R1): per absolute path, the union of line spans whose
 * content this session has already put in context. A read is blocked only when
 * its requested window is FULLY covered; partial overlap passes. Freshness is
 * stat-based (mtime+size) — external changes are caught by stat, not guessed
 * from bash command text. */
import { homedir } from "os";
import { readFile, stat } from "fs/promises";
import { createHash } from "crypto";
import { join, resolve } from "path";
import { fileURLToPath } from "url";

/** edited line span, 1-based inclusive, post-application */
export interface LineSpan {
  start: number;
  end: number;
}

export type CoverKind = "read" | "edit" | "write" | "inject";

/** a coverage entry: certified span union + the stat/hash the content was
 * certified against (S5 M3: hash closes the same-stat drift tail) */
export interface CoverageEntry {
  spans: LineSpan[];
  kind: CoverKind;
  stat?: { mtimeMs: number; size: number };
  hash?: string;
}

/** sha256 of content, truncated to 16 hex — S5 M3 chain token. Mutation
 * points only (never the read hot path — spec §5.3), so 16 hex (64 bits)
 * makes an accidental collision impossible for any real adversary. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** hash of file content, undefined when missing/unreadable or above the
 * 1 MiB cap (hashing multi-MB files on a mutation boundary costs more than
 * the same-stat tail it closes — stat-only there, spec §5.3). Hashes the
 * SAME normalized view anchor-guard validates against (toLF mirror + BOM
 * strip) so a stored hash never false-blocks a CRLF file. */
export const HASH_CAP_BYTES = 1024 * 1024;
export async function hashFile(
  key: string,
): Promise<string | undefined> {
  try {
    const s = await stat(key);
    if (s.size > HASH_CAP_BYTES) return undefined;
    const raw = await readFile(key, "utf8");
    return hashText(
      raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, ""),
    );
  } catch {
    return undefined;
  }
}

/** absolute map key mirroring pi's own tool path resolution (utils/paths.js:
 * expandPath/resolveToCwd): unicode-space fold, leading-@ strip, ~ and file://
 * expansion, then resolve against the handler ctx cwd (falling back to
 * process.cwd()). 2026-10-11: the old plain resolve() keyed @-prefixed and ~
 * paths differently from the tool's own resolution — mismatches fail open
 * (snapshot/coverage lookups simply miss), never mis-blocking. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
export function normPath(p: unknown, cwd?: string): string {
  let s = String(p ?? "");
  if (!s) return "";
  s = s.replace(UNICODE_SPACES, " ");
  if (s.startsWith("@")) s = s.slice(1);
  if (s === "~") return homedir();
  if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  if (/^file:\/\//.test(s)) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* malformed URL — fall through and resolve the raw text */
    }
  }
  return resolve(cwd ?? process.cwd(), s);
}

/** snapshot {mtimeMs,size} for freshness (ChatCLI/Crush-style staleness — 2026-10-06) */
export async function snapshot(
  key: string,
): Promise<{ mtimeMs: number; size: number } | undefined> {
  try {
    const s = await stat(key);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

/** add a certified span to a path's union (sorted, overlap/adjacency-merged) */
export function certify(
  coverage: Map<string, CoverageEntry>,
  key: string,
  span: LineSpan,
  kind: CoverKind,
  statSnap?: { mtimeMs: number; size: number },
  hash?: string,
): void {
  const spans = [...(coverage.get(key)?.spans ?? []), span].sort(
    (a, b) => a.start - b.start,
  );
  const merged: LineSpan[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 1)
      last.end = last.end > s.end ? last.end : s.end;
    else merged.push({ ...s });
  }
  coverage.set(key, {
    spans: merged,
    kind,
    stat: statSnap ?? coverage.get(key)?.stat,
    hash: hash ?? coverage.get(key)?.hash,
  });
}

/** true when [win.start, win.end] lies entirely inside the span union */
export function coversAll(spans: LineSpan[], win: LineSpan): boolean {
  let pos = win.start;
  for (const s of spans) {
    if (s.end < pos) continue;
    if (s.start > pos) return false;
    if (s.end === Infinity || (pos = s.end + 1) > win.end) return true;
  }
  return false;
}

/** one edit region of an edit call, in ORIGINAL 1-based line coordinates:
 * the matched `oldText` span [start, end] and its line-count delta. */
export interface EditRegion {
  start: number;
  end: number;
  delta: number;
}

/**
 * Re-map certified spans after a successful edit call.
 *
 * With `regions` (per-edit original spans + deltas, the exact-anchor edit
 * path): every span rebases by the cumulative delta of the regions ABOVE it
 * only, and a span straddling a region SPLITS — the unchanged head keeps
 * its original line numbers, the tail below the region shifts. Nothing
 * still byte-identical in context is dropped (backlog §8, 2026-10-18: the
 * old wholesale straddler drop wiped a write's [1,∞] on the first edit and
 * false-blocked later edits on lines the session itself had put in context;
 * a single total delta also over-shifted spans between a multi-edit call's
 * regions).
 *
 * Legacy path (no `regions`, e.g. a write result): spans at/below
 * firstEditedLine shift by the one `delta`; straddlers drop; no
 * firstEditedLine at all (full rewrite) drops everything.
 */
export function shiftSpansForEdit(
  spans: LineSpan[],
  firstEditedLine: number | undefined,
  delta: number,
  regions?: EditRegion[],
): LineSpan[] {
  if (regions === undefined || regions.length === 0) {
    const out: LineSpan[] = [];
    for (const s of spans) {
      if (firstEditedLine === undefined) continue; // full rewrite: nothing survives
      if (s.end < firstEditedLine) out.push(s);
      else if (s.start >= firstEditedLine)
        out.push({ ...s, start: s.start + delta, end: s.end + delta });
    }
    return out.sort((a, b) => a.start - b.start);
  }
  const sortedRegions = [...regions].sort((a, b) => a.start - b.start);
  const out: LineSpan[] = [];
  for (const s of spans) {
    let curStart = s.start;
    let shift = 0; // cumulative delta of the regions above the remainder
    for (const r of sortedRegions) {
      if (r.end < curStart) {
        shift += r.delta; // region entirely above the remaining span
      } else if (r.start > s.end) {
        break; // region below — every later region is further below
      } else {
        // region overlaps the remaining span: emit the unchanged head,
        // skip the changed lines, continue with the tail
        if (r.start > curStart)
          out.push({ start: curStart + shift, end: r.start - 1 + shift });
        curStart = r.end + 1;
        shift += r.delta;
        if (curStart > s.end) break;
      }
    }
    if (curStart <= s.end)
      out.push({ start: curStart + shift, end: s.end + shift });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** text of a tool_result's text blocks, joined like countTextLines */
function blocksToText(content: unknown[]): string {
  return content
    .filter((b) => (b as { type?: unknown })?.type === "text")
    .map((b) => String((b as { text?: unknown })?.text ?? ""))
    .join("\n");
}

/** strip the read tool's trailing truncation note ("[N more lines in file…]"
 * or "[Showing lines A-B of N…]") and the blank separator line before it —
 * the note is separated by "\n\n", so without this every windowed read
 * would over-certify one line past its real content */
function stripTailNotice(lines: string[]): { lines: string[]; truncated: boolean } {
  const last = lines[lines.length - 1] ?? "";
  if (
    /^\[\d+ more lines? in file\./.test(last) ||
    /^\[Showing lines /.test(last)
  ) {
    lines.pop();
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines, truncated: true };
  }
  return { lines, truncated: false };
}

/** fallback line count from text blocks when details.truncation is absent */
export function countTextLines(content: unknown[]): {
  lines: number;
  truncated: boolean;
} {
  const text = blocksToText(content);
  if (!text) return { lines: 0, truncated: false };
  // (piread no longer appends a "[piread native]" marker line: the rung is now
  // carried on details.via, which never enters content, so line numbering here
  // matches the built-in read directly.)
  const stripped = stripTailNotice(text.split("\n"));
  return { lines: stripped.lines.length, truncated: stripped.truncated };
}

/** Omission marker emitted by piread's head-tail compaction (compress.rs):
 * "[... omitted D chars / N lines ...]" standing alone. The chars-only
 * variant omits no whole lines, so it needs no span math. */
const OMISSION_MARKER_LINE =
  /^\[\.\.\. omitted \d+ chars \/ (\d+) lines \.\.\.\]$/;

/** Rendered line spans of a possibly-elided read body (backlog §9): walks
 * the text, treats each line-omission marker (and the blank separators
 * piread pads it with) as a gap of the marker's stated line count, and maps
 * the surviving runs onto file lines starting at `startLine`. Only the
 * rendered runs entered context, so only they may certify. Returns undefined
 * when no line-omission marker is present — callers keep their legacy
 * whole-window certification. Under-certifies (never over) when a real
 * blank line sits directly at an elision boundary: dropped, not counted. */
export function renderedSpansFromBlocks(
  content: unknown[],
  startLine: number,
): LineSpan[] | undefined {
  const text = blocksToText(content);
  if (!text) return undefined;
  const { lines } = stripTailNotice(text.split("\n"));
  const omits: { at: number; lines: number }[] = [];
  const skip = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = OMISSION_MARKER_LINE.exec(lines[i].trim());
    if (!m) continue;
    omits.push({ at: i, lines: Number(m[1]) });
    if (i > 0 && lines[i - 1].trim() === "") skip.add(i - 1);
    if (i + 1 < lines.length && lines[i + 1].trim() === "") skip.add(i + 1);
  }
  if (omits.length === 0) return undefined;
  const spans: LineSpan[] = [];
  let cursor = startLine;
  for (let i = 0; i < lines.length; i++) {
    const om = omits.find((o) => o.at === i);
    if (om) {
      cursor += om.lines;
      continue;
    }
    if (skip.has(i)) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === cursor - 1) last.end = cursor;
    else spans.push({ start: cursor, end: cursor });
    cursor++;
  }
  return spans;
}
