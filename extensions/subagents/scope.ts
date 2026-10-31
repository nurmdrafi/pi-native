/**
 * File-scope derivation for subagents.
 *
 * A subagent's WRITE scope is only what the orchestrator declares via the
 * spawn tool's `files` param: declared scopes are the one thing the spawn
 * queue locks on. Paths parsed out of the task text are context-only — they
 * feed prior-work injection and display and can never serialize a wave or
 * block another spawn (parsing noise must not lock, and read-only agents
 * that declare nothing always stay parallel).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface SubagentScope {
  /** Absolute, normalized paths. A directory owns its whole subtree. */
  paths: string[];
  /** "declared" — from the `files` param (lock-forming). "parsed" — from
   * task text (context-only). "none" — unscoped, runs parallel. */
  origin: "declared" | "parsed" | "none";
}

/** Parsed-scope cap: task text can name dozens of plausible paths; only the
 * first few matter for injection matching, so the derivation stays cheap. */
const PARSED_PATH_CAP = 20;

/** Extensions that make an extension-only token path-shaped ("index.ts"
 * has no "/" but is unmistakably a file reference). */
const KNOWN_SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts",
  "json", "jsonc", "md", "mdx", "txt", "rst",
  "css", "scss", "html", "htm", "svg",
  "py", "pyi", "rs", "go", "java", "kt", "rb", "php", "swift", "c", "h", "cc", "cpp", "hpp",
  "sh", "bash", "zsh", "fish",
  "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "sql", "graphql", "proto", "lock",
]);

/** Path-shaped token: chars [A-Za-z0-9._@/-]. */
const PATH_TOKEN = /[A-Za-z0-9._@/-]+/g;
/** Sentence punctuation that glues onto a token before a word boundary. */
const TRAILING_PUNCTUATION = /[.,;:)\]}'"!?]+$/;

function hasKnownExtension(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  return KNOWN_SOURCE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/** Extract path-shaped tokens from task text (hygiene applied, existence NOT
 * checked): chars [A-Za-z0-9._@/-], containing "/" or a known source
 * extension. Hygiene: the bare "/" token is dropped (it would resolve to the
 * repo root and own the whole tree), trailing punctuation is trimmed before
 * any use, and URLs are split at ":" so schemes never join a token. */
export function parseTaskPaths(task: string): string[] {
  const tokens = new Set<string>();
  for (const chunk of task.split(":")) {
    for (const match of chunk.matchAll(PATH_TOKEN)) {
      // Punctuation first ("src/a.ts."), then trailing slashes ("src/b/.").
      const token = match[0].replace(TRAILING_PUNCTUATION, "").replace(/\/+$/, "");
      if (token === "" || token === "/") continue;
      if (!token.includes("/") && !hasKnownExtension(token)) continue;
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** Normalize a scope path to absolute form against `cwd` (absolute inputs
 * pass through; resolve collapses "..", "." and duplicate separators). */
export function normalizeScopePath(cwd: string, p: string): string {
  return resolve(cwd && cwd.trim() ? cwd : process.cwd(), p);
}

/** Segment-prefix overlap between two absolute normalized paths: equal, or
 * one is a directory ancestor of the other — a directory owns its subtree. */
export function scopePathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + "/") || b.startsWith(a + "/");
}

/** Derive a subagent's file scope. `declaredFiles` (the spawn tool's `files`
 * param, repo-relative to `cwd`) is the whole scope when present and
 * non-empty — NOT existence-checked, because create-task deliverables must
 * lock before they exist. Otherwise fall back to parsing the task text and
 * keeping only tokens that resolve to an existing file/dir under `cwd`. */
export function deriveScope(task: string, cwd: string, declaredFiles?: string[]): SubagentScope {
  const declared = (declaredFiles ?? [])
    .filter((p): p is string => typeof p === "string" && !!p.trim())
    .map((p) => normalizeScopePath(cwd, p.trim()));
  if (declaredFiles && declared.length > 0) {
    return { paths: [...new Set(declared)].sort(), origin: "declared" };
  }
  // An empty `files` array behaves as undeclared: fall through to parsing.
  const existing = parseTaskPaths(task)
    .map((t) => normalizeScopePath(cwd, t))
    .filter((p) => existsSync(p));
  const paths = [...new Set(existing)].sort().slice(0, PARSED_PATH_CAP);
  return { paths, origin: paths.length > 0 ? "parsed" : "none" };
}

/** Keep the repo-relative git-delta entries that fall inside the scope: a
 * file counts when it equals a scope path, sits under a scope directory, or
 * is an ancestor of a scope path (a scope target inside a changed dir). */
export function intersectFilesChanged(filesChanged: string[], scopePaths: string[], repoRoot: string): string[] {
  if (scopePaths.length === 0) return filesChanged;
  const root = repoRoot && repoRoot.trim() ? repoRoot : process.cwd();
  return filesChanged.filter((f) => {
    const abs = normalizeScopePath(root, f);
    return scopePaths.some((s) => abs === s || abs.startsWith(s + "/") || s.startsWith(abs + "/"));
  });
}
