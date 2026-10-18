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

/**
 * Re-map certified spans after a successful exact-anchor edit. Lines
 * strictly above the first edited line keep their numbers; lines from the
 * first edited line down shifted by `delta` (new − old line count of the
 * edit call). Straddling spans are dropped — their content changed.
 * Exact for single-edit calls; multi-edit calls shift by the cumulative
 * delta (spans between edit regions over-shift and simply stay decertified
 * on mismatch — conservative, never blocks a legitimate read of new
 * content since partial overlap always passes).
 */
export function shiftSpansForEdit(
  spans: LineSpan[],
  firstEditedLine: number,
  delta: number,
): LineSpan[] {
  const out: LineSpan[] = [];
  for (const s of spans) {
    if (s.end < firstEditedLine) out.push(s);
    else if (s.start >= firstEditedLine)
      out.push({ ...s, start: s.start + delta, end: s.end + delta });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** fallback line count from text blocks when details.truncation is absent */
export function countTextLines(content: unknown[]): {
  lines: number;
  truncated: boolean;
} {
  const text = content
    .filter((b) => (b as { type?: unknown })?.type === "text")
    .map((b) => String((b as { text?: unknown })?.text ?? ""))
    .join("\n");
  if (!text) return { lines: 0, truncated: false };
  const lines = text.split("\n");
  // (piread no longer appends a "[piread native]" marker line: the rung is now
  // carried on details.via, which never enters content, so line numbering here
  // matches the built-in read directly.)
  // strip the read tool's trailing truncation note ("[N more lines in file…]"
  // or "[Showing lines A-B of N…]") and the blank separator line before it —
  // the note is separated by "\n\n", so without this every windowed read
  // would over-certify one line past its real content
  const last = lines[lines.length - 1] ?? "";
  if (
    /^\[\d+ more lines? in file\./.test(last) ||
    /^\[Showing lines /.test(last)
  ) {
    lines.pop();
    if (lines[lines.length - 1] === "") lines.pop();
    return { lines: lines.length, truncated: true };
  }
  return { lines: lines.length, truncated: false };
}
