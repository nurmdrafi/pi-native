/**
 * Search/portability gate (SS/PB/NM) — mechanical enforcement of
 * docs/agent-hygiene.md "Toolchain" scope rules and docs/portability.md.
 *
 * 2026-10-13 session audit: unscoped repo-wide greps (`grep -rn … .`) timed
 * out at 30s twice; a `node_modules/.pnpm/…` path was read via the read tool;
 * `grep: invalid option -- P` on BSD grep.
 *
 * | ID  | Check                                            | Fix carried in the reason |
 * |-----|--------------------------------------------------|---------------------------|
 * | PB1 | grep -P on darwin (BSD grep lacks it)            | rg / grep -E              |
 * | SS1 | recursive grep with no path/glob scope           | scope path/--include or rg |
 * | SS2 | bare grep/egrep/fgrep head or mid-pipe (rg-first policy) | rg PATTERN path/           |
 * | SS3 | bare find head (fd-first policy)                    | fd PATTERN path/           |
 * | SE1 | `|| true` / `|| :` swallows the failure exit code (warn) | drop it / handle explicitly |
 *
 * `ls node_modules/<pkg>` stays allowed (presence checks are legitimate);
 * rg is gitignore-aware and fast, so unscoped rg passes by design.
 */
import { readdirSync } from "node:fs";

/** quote-aware tokenizer: quoted runs stay one token (quotes stripped);
 * shell operators | < > stand alone so tokens past them are another command */
function tokens(seg: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let has = false;
  const push = () => {
    if (has) {
      out.push(cur);
      cur = "";
      has = false;
    }
  };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === "\\") {
        cur += seg[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (ch === "\\" && i + 1 < seg.length) {
      cur += seg[i + 1];
      i++;
      has = true;
      continue;
    }
    if (ch === "|" || ch === ">" || ch === "<") {
      push();
      out.push(ch);
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
    has = true;
  }
  push();
  return out;
}

/** node_modules paths: rg/fd are gitignore-aware and skip the tree, so
 * grep/find there are legitimate — exempt from rg-first (2026-10-18). */
const isNodeModulesPath = (t: string) =>
  t === "node_modules" ||
  t.startsWith("node_modules/") ||
  /(^|\/)node_modules(\/|$)/.test(t);

/** SS2 (2026-10-16): AGENTS.md tooling defaults — rg is the search default;
 * grep/egrep/fgrep (segment head or mid-pipe) is fallback only when rg errors.
 * Fires after PB1/SS1 so their specific reasons still teach first. */
const SS2_MSG =
  "Search (rg-first): 'grep' is the fallback, not the default — use 'rg PATTERN path/' (scope with -t <lang> or a glob). If rg genuinely errored, say so in chat and wait for approval before using grep.";

/** SS3 (2026-10-16): AGENTS.md tooling defaults — fd is the file-find default;
 * find is fallback only when fd errors. */
const SS3_MSG =
  "Search (fd-first): 'find' is the fallback, not the default — use 'fd PATTERN path/' (regex pattern; -e exact, -H hidden, -t f files). If fd genuinely errored, say so in chat and wait for approval before using find.";

/** SS4 (2026-11-01): `-r` is a grep habit, not an rg recursion flag — rg recurses
 * by default and reads `-r`/`--replace` as display substitution, so the search
 * still runs but answers the wrong question and costs a re-run. */
const SS4_MSG =
  "Search (rg -r): '-r' on rg is --replace (display substitution), not recursion — rg already recurses, so drop it: 'rg PATTERN path/'. The flag comes from grep idioms and silently changes what the command reports.";

/**
 * SS1's crawl-cost premise applies to all searches.
 * PB1 (deterministic BSD failure) still blocks.
 */
export interface SearchRules {
  /** SS1: recursive grep with no path/glob scope */
  scope?: boolean;
  /** PB1: grep -P on darwin */
  portability?: boolean;
  /** SS2: mid-pipe grep */
  midPipe?: boolean;
  /** SS3: find head — prefer fd */
  findFirst?: boolean;
  /** SS4: rg -r/--replace, a grep idiom for a flag rg reads as substitution */
  replaceFlag?: boolean;
}

/** SE1 (2026-10-28): `|| true` / `|| :` swallows the failure exit code.
 * Warn by default — taught, counted, not blocked. `|| echo fallback` keeps
 * the failure visible and is not flagged. */
export function swallowCheck(seg: string): string | undefined {
  return /\|\|\s*(?:true|:)(?=$|[\s;&|)])/.test(seg)
    ? "Hygiene (Error-swallow): '|| true' hides the failure exit code — drop it or handle the error explicitly."
    : undefined;
}

/** SE2 (2026-10-28): read windows belong to piread — sed is a pipeline
 * stage, never a reader. Command-level check (segments split on pipes).
 * Warn by default; the reason rides the result as a note. Reconciled with
 * view-command credit (2026-10-29): the preference stands — piread gives
 * offset windows and compaction markers, bash output is capped and
 * unnumbered — but the printed lines of a mappable single-file view DO
 * certify spans, so the reason must not claim they seed nothing. */
export function readerBypassCheck(cmd: string): string | undefined {
  return /(?:^|&&|\|\||;|\||\bdo\b|\bthen\b)\s*(?:sed\s+[^|;&]*-n\b|cat\s)/.test(cmd)
    ? "Hygiene (Reader-bypass): read windows go through piread — sed is a pipeline stage, never a reader; view-command output is capped and unnumbered, though its printed lines do count as read coverage."
    : undefined;
}

export function searchCheck(
  seg: string,
  isDarwin: boolean,
  rules: SearchRules = {},
): string | undefined {
  const on = {
    scope: rules.scope ?? true,
    portability: rules.portability ?? true,
    midPipe: rules.midPipe ?? true,
    findFirst: rules.findFirst ?? true,
    replaceFlag: rules.replaceFlag ?? true,
  };
  const toks = tokens(seg);
  let i = 0;
  if (toks[i] === "sudo") i++;
  const head = toks[i] ?? "";
  if (head !== "grep" && head !== "egrep" && head !== "fgrep") {
    // SS3 fd-first: find head → fd
    if (on.findFirst && head === "find") return SS3_MSG;
    // SS4: rg -r / --replace — substitution, never recursion
    if (on.replaceFlag && head === "rg")
      for (let k = i + 1; k < toks.length && toks[k].startsWith("-"); k++) {
        const t = toks[k];
        if (t === "--") break;
        if (t === "--replace" || t.startsWith("--replace=")) return SS4_MSG;
        // rg's short --replace form is -r; a short cluster like -rn carries it
        if (!t.startsWith("--") && t.slice(1).includes("r")) return SS4_MSG;
      }
    // SS2 mid-pipe: a grep segment headed by another command
    if (on.midPipe)
      for (let k = 1; k < toks.length; k++)
        if (toks[k - 1] === "|" && /^(?:grep|egrep|fgrep)$/.test(toks[k]))
          return SS2_MSG;
    return undefined;
  }
  // grep: flags, then the pattern, then path args / mid-command options
  const flags: string[] = [];
  let j = i + 1;
  for (; j < toks.length && toks[j].startsWith("-") && toks[j] !== "-"; j++)
    flags.push(toks[j]);
  j++; // the pattern
  const rest: string[] = [];
  for (
    ;
    j < toks.length && toks[j] !== "|" && toks[j] !== ">" && toks[j] !== "<";
    j++
  )
    rest.push(toks[j]);
  const shortFlag = (ch: string) =>
    flags.some((f) => !f.startsWith("--") && f.slice(1).includes(ch));
  const hasLong = (name: string, all: string[]) =>
    all.some((f) => f === name || f.startsWith(name + "="));
  if (on.portability && isDarwin && (shortFlag("P") || hasLong("--perl-regexp", flags)))
    return "Portability (grep -P): BSD grep has no -P (audit: 'grep: invalid option -- P') — use 'rg <pattern>' or 'grep -E'.";
  const paths = rest.filter((t) => !t.startsWith("-"));
  const opts = rest.filter((t) => t.startsWith("-"));
  const includeScoped = hasLong("--include", [...flags, ...opts]);
  const recursive =
    shortFlag("r") || shortFlag("R") || hasLong("--recursive", flags);
  const unscoped =
    paths.length === 0 ||
    paths.every((p) => p === "." || p === "./" || p === "..");
  if (on.scope && recursive && unscoped && !includeScoped)
    return "Search (Scope): recursive grep with no path/glob scope crawls node_modules/.git and timed out at 30s — scope it (grep -rn --include='*.ts' PATTERN src/) or use rg PATTERN src/.";
  return !on.midPipe || (paths.length > 0 && paths.every(isNodeModulesPath)) ? undefined : SS2_MSG;
}

/** R1c search-tool family, one home for every consumer (argv seeding,
 * C4 result parsing) so the two cannot drift apart. */
const SEARCH_TOOL_RE = /^(?:rg|grep|egrep|fgrep|fd|find|ag|ack)$/;

/** R1c/C4: does this command segment run a search tool? Any-token match —
 * exactly what searchedPathsFrom has always keyed on. */
export function isSearchSegment(seg: string): boolean {
  return seg.split(/\s+/).filter(Boolean).some((t) => SEARCH_TOOL_RE.test(t));
}

/** R1c/C4 (2026-10-27): does this segment run a path enumeration — a command
 * whose output pairs a count with a path (`wc -l`), so its rows name files the
 * agent then legitimately reads?
 * `wc` must sit in command position: `echo wc` mentions the tool without
 * running it. `ls` is excluded on purpose — its `-l` rows carry permission,
 * size and date metadata, which read as noise, not as a named path. */
export function enumeratesPaths(seg: string): boolean {
  return seg
    .split(/\s*(?:&&|\|\||[|;])\s*/)
    .filter(Boolean)
    .some((sub) => sub.split(/\s+/)[0] === "wc");
}

/** R1c locate-first: which paths did this command target? A wide window read
 * of a path that was never searched is a guess about where the content is.
 * Tokens that exist on disk count as targets; flags and patterns do not. */
export function searchedPathsFrom(
  segments: string[],
  cwd: string | undefined,
  resolvePath: (p: string, cwd?: string) => string,
  exists: (p: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    const toks = seg.split(/\s+/).filter(Boolean);
    if (!isSearchSegment(seg))
      continue;
    for (const tok of toks) {
      if (tok.startsWith("-") || tok.includes("=")) continue;
      if (/[|><;$`]/.test(tok)) continue;
      if (/(^|\/)node_modules(\/|$)/.test(tok)) continue;
      const abs = resolvePath(tok, cwd);
      if (exists(abs)) {
        out.push(abs);
        continue;
      }
      // Glob target (`rg -n term src/utils/*.js`): literal string is not a
      // path, so it credited nothing — yet the search named those files, and a
      // later wide read of a hit was blocked as "never searched" (2026-10-18
      // session audit). Expand one level, credit the matches.
      if (!/[*?\[]/.test(tok)) continue;
      const slash = tok.lastIndexOf("/");
      const dirTok = slash === -1 ? "." : tok.slice(0, slash);
      const base = slash === -1 ? tok : tok.slice(slash + 1);
      if (base.includes("/")) continue; // `**` recursion: out of scope
      const dirAbs = resolvePath(dirTok, cwd);
      if (!exists(dirAbs)) continue;
      const re = globToRegex(base);
      let entries: string[];
      try {
        entries = readdirSync(dirAbs);
      } catch {
        continue;
      }
      for (const entry of entries)
        if (re.test(entry)) out.push(resolvePath(`${dirTok}/${entry}`, cwd));
    }
  }
  return out;
}

/** R1c/C4: cap on result text scanned for hit lines — output beyond the first
 * screenful is stale for locating, and the bound keeps parsing O(1). */
export const HIT_SCAN_CHARS = 4096;

/** R1c/C4: the cwd a command's search hits resolve against — the session cwd
 * advanced by each `cd <dir>` segment in command order (the 2026-10-26
 * incident's searches all carried `cd <dir> &&` prefixes). Bare `cd` (HOME),
 * flag forms and quoted targets are skipped: an unadvanced cwd under-resolves
 * and then fails the existence check instead of mis-seeding. */
export function effectiveCwd(
  segments: string[],
  cwd: string | undefined,
  resolvePath: (p: string, cwd?: string) => string,
): string | undefined {
  let cur = cwd;
  for (const seg of segments) {
    const toks = seg.split(/\s+/).filter(Boolean);
    if (toks[0] !== "cd" || toks.length !== 2) continue;
    const dir = toks[1];
    if (dir.startsWith("-") || /[|><;$`"']/.test(dir)) continue;
    cur = resolvePath(dir, cur);
  }
  return cur;
}

/** R1c/C4 hit-anchored seeding: parse rg/grep/fd-style output into
 * path → hit lines. `path:line[:col]:` prefixes seed with that line; bare
 * path-only lines (`rg -l`, fd) seed an empty set — any window; colon-bearing
 * forms that miss the hit pattern (`rg -c` counts, prose references) seed
 * nothing.
 * FAIL-CLOSED, two gates: callers scan only results of commands that passed
 * isSearchSegment (an `echo <path>` result is never parsed), and every
 * candidate must exist on disk after cwd resolution — prose like `foo:12:`
 * resolves nowhere, so it seeds nothing.
 * `singleFile` (2026-10-27): the search named exactly one file, so its output
 * carries no path prefix — bare `NN:` lines are that file's hits. */
export function searchHitsFrom(
  text: string,
  cwd: string | undefined,
  resolvePath: (p: string, cwd?: string) => string,
  exists: (p: string) => boolean,
  singleFile?: string,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const line of text.slice(0, HIT_SCAN_CHARS).split(/\r?\n/)) {
    const hit = /^([^\s:]+\.?[A-Za-z0-9_-]*):(\d+)(?::\d+)?:/.exec(line);
    if (hit) {
      const abs = resolvePath(hit[1], cwd);
      if (!exists(abs)) continue;
      const lines = out.get(abs) ?? new Set<number>();
      lines.add(Number(hit[2]));
      out.set(abs, lines);
      continue;
    }
    // single-file attribution: rg on one file, `awk`/`sed -n` on one file —
    // output is `241:  dataSource`, no path to anchor on. A tail that itself
    // starts with a digit is a `line:col:` shape (`12:5:x`), not content:
    // fail closed rather than credit a line the search never reported.
    if (singleFile !== undefined) {
      const bare = /^(\d+):(.*)$/.exec(line);
      if (bare && !/^\d/.test(bare[2])) {
        const lines = out.get(singleFile) ?? new Set<number>();
        lines.add(Number(bare[1]));
        out.set(singleFile, lines);
        continue;
      }
    }
    // enumeration row (`wc -l`): a count, then the path it counted. The count
    // is not a hit line and the path was never grepped, so seed path-only (any
    // window). `727 total` resolves nowhere and seeds nothing; a metadata row
    // with more than one trailing token (`ls -l`) never matches.
    const counted = /^\s*\d+\s+(\S+)\s*$/.exec(line);
    if (counted && !counted[1].includes(":") && /[./]/.test(counted[1])) {
      const abs = resolvePath(counted[1], cwd);
      if (!exists(abs)) continue;
      if (!out.has(abs)) out.set(abs, new Set<number>());
      continue;
    }
    // path-only: one token shaped like a path (has / or .), no colon (a
    // colon-bearing token that missed the hit form — `rg -c` counts, prose
    // references — is not a path)
    if (
      line &&
      !/\s/.test(line) &&
      !line.includes(":") &&
      !line.startsWith("-") &&
      /[./]/.test(line)
    ) {
      const abs = resolvePath(line, cwd);
      if (!exists(abs)) continue;
      if (!out.has(abs)) out.set(abs, new Set<number>());
    }
  }
  return out;
}

/** R1c/C4: does a recorded search hit anchor this window? A path-only seed
 * (`rg -l`) anchors any window; otherwise some reported hit line must fall
 * inside the read — the allow-condition is the rule text: "read the hit's
 * range". */
export function hitAnchorsWindow(
  hits: Map<string, Set<number>>,
  path: string,
  win: { start: number; end: number },
): boolean {
  const lines = hits.get(path);
  if (lines === undefined) return false;
  if (lines.size === 0) return true;
  for (const l of lines)
    if (l >= win.start && l <= win.end) return true;
  return false;
}

/** Locate remedy text: the lines a search reported for one file, bounded to
 * three entries so the reason stays inside the 220c block cap ("241, 245,
 * 261, +2 more"). */
export function hitLinesLabel(lines: Set<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const shown = sorted.slice(0, 3).join(", ");
  return sorted.length > 3 ? `${shown}, +${sorted.length - 3} more` : shown;
}

/** Locate remedy: the smallest read window that covers the reported hits,
 * padded by `pad` lines and capped at `max` — the block hands the model a
 * paste-ready call, so the remedy costs one targeted read instead of a re-run
 * of the search plus a guessed window. Undefined for a path-only seed. */
export function hitWindowHint(
  lines: Set<number>,
  pad = 3,
  max = 60,
): { offset: number; limit: number } | undefined {
  if (lines.size === 0) return undefined;
  const sorted = [...lines].sort((a, b) => a - b);
  const offset = Math.max(1, sorted[0] - pad);
  const limit = Math.min(sorted[sorted.length - 1] + pad - offset + 1, max);
  return { offset, limit };
}

/** fnmatch-style single-level glob → RegExp. `?` → one non-slash char,
 * `*` → any run of non-slash chars, everything else literal. Total over
 * strings — never throws on glob metachar soup (2026-10-18: `?` built an
 * unterminated `[^/` class and the RegExp constructor threw, failing
 * every call whose command text contained that shape). */
export function globToRegex(base: string): RegExp {
  const body = [...base]
    .map((ch) =>
      ch === "*"
        ? "[^/]*"
        : ch === "?"
          ? "[^/]"
          : /[.+^${}()|[\]\\]/.test(ch)
            ? `\\${ch}`
            : ch,
    )
    .join("");
  return new RegExp(`^${body}$`);
}
