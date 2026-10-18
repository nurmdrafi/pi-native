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
 * | NM1 | read tool + grep/find/rg/cat/head/tail into node_modules | docs/types, not the tree |
 * | SS2 | bare grep/egrep/fgrep head or mid-pipe (rg-first policy) | rg PATTERN path/           |
 * | SS3 | bare find head (fd-first policy)                    | fd PATTERN path/           |
 *
 * `ls node_modules/<pkg>` stays allowed (presence checks are legitimate);
 * rg is gitignore-aware and fast, so unscoped rg passes by design.
 */
import { readdirSync } from "node:fs";

const NM1_MSG =
  "Search (node_modules): dependency internals — ask the user before crawling node_modules; pi docs under node_modules/@earendil-works/ are pre-approved.";

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

const isNodeModulesToken = (t: string) =>
  t === "node_modules" ||
  t.startsWith("node_modules/") ||
  /(^|\/)node_modules(\/|$)/.test(t);

/** user-approved 2026-10-13: @earendil-works (pi docs/types) reads are not a wasted crawl */
const isEarendilExempt = (t: string) =>
  t.startsWith("node_modules/@earendil-works/") ||
  t.includes("/node_modules/@earendil-works/");

/** SS2 (2026-10-16): AGENTS.md tooling defaults — rg is the search default;
 * grep/egrep/fgrep (segment head or mid-pipe) is fallback only when rg errors.
 * Fires after PB1/SS1/NM1 so their specific reasons still teach first. */
const SS2_MSG =
  "Search (rg-first): 'grep' is the fallback, not the default — use 'rg PATTERN path/' (scope with -t <lang> or a glob). If rg genuinely errored, say so in chat and wait for approval before using grep.";

/** SS3 (2026-10-16): AGENTS.md tooling defaults — fd is the file-find default;
 * find is fallback only when fd errors. Fires after NM1 so the node_modules
 * approval policy keeps its specific reason. */
const SS3_MSG =
  "Search (fd-first): 'find' is the fallback, not the default — use 'fd PATTERN path/' (regex pattern; -e exact, -H hidden, -t f files). If fd genuinely errored, say so in chat and wait for approval before using find.";

/**
 * SS1's crawl-cost premise applies to all searches.
 * PB1 (deterministic BSD failure) and NM1 (user-approval policy) still block.
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
  /** NM1: node_modules reads/searches */
  nodeModules?: boolean;
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
    nodeModules: rules.nodeModules ?? true,
  };
  const toks = tokens(seg);
  let i = 0;
  if (toks[i] === "sudo") i++;
  const head = toks[i] ?? "";
  if (head !== "grep" && head !== "egrep" && head !== "fgrep") {
    if (on.nodeModules &&
        /^(?:find|rg|cat|head|tail)$/.test(head) &&
        toks.some((t) => isNodeModulesToken(t) && !isEarendilExempt(t)))
      return NM1_MSG;
    // SS3 fd-first: find head → fd (NM1's node_modules reason stays first)
    if (on.findFirst && head === "find") return SS3_MSG;
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
  if (on.nodeModules && [...paths, ...opts].some((t) => isNodeModulesToken(t) && !isEarendilExempt(t)))
    return NM1_MSG;
  // user-approved 2026-10-13: grep into @earendil-works pi docs stays allowed
  return !on.midPipe || (paths.length > 0 && paths.every(isEarendilExempt))
    ? undefined
    : SS2_MSG;
}

/** NM1 for the read tool: block reads of dependency internals */
export function nodeModulesPath(display: string): string | undefined {
  const d = display.replace(/\\/g, "/");
  if (!/(^|\/)node_modules(\/|$)/.test(d)) return undefined;
  // user-approved 2026-10-13: @earendil-works (pi docs/types) allowed
  if (/(^|\/)node_modules\/@earendil-works\//.test(d)) return undefined;
  const shown = display.length > 48 ? `…${display.slice(-47)}` : display;
  return `Search (node_modules): '${shown}' is dependency internals — ask the user before crawling node_modules; pi docs under node_modules/@earendil-works/ are pre-approved.`;
}

/** R1c locate-first: which paths did this command target? A wide window read
 * of a path that was never searched is a guess about where the content is.
 * Tokens that exist on disk count as targets; flags and patterns do not.
 * node_modules is excluded — NM1 governs that path. */
export function searchedPathsFrom(
  segments: string[],
  cwd: string | undefined,
  resolvePath: (p: string, cwd?: string) => string,
  exists: (p: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    const toks = seg.split(/\s+/).filter(Boolean);
    if (!toks.some((t) => /^(?:rg|grep|egrep|fgrep|fd|find|ag|ack)$/.test(t)))
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
      const re = new RegExp(
        `^${base
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/")}$`,
      );
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
