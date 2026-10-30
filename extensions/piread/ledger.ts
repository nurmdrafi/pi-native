/**
 * Durable per-repo read ledger: every piread result appends one record —
 * path, requested window, compaction omissions (absolute 1-based lines),
 * file stat + sha256, session id, timestamp — to
 * `<repo-root>/.pi/read-ledger.jsonl`.
 *
 * Honest boundary: this is an INDEX of prior reads, not a context
 * substitute. Lines rendered in another session are not in this session's
 * context; edit anchoring still requires the current session to have
 * rendered the anchor lines. Successors use it to see which spans of which
 * files were examined (and whether the file changed since, via stat/hash),
 * so they re-read only what their own context needs.
 *
 * Storage: append-only JSONL, rotated by size (5 MiB active file, three
 * archives). Set PI_READ_LEDGER=0 to disable recording.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

/** Rotate when the active ledger exceeds this size. */
const ROTATION_BYTES = 5 * 1024 * 1024;
/** Archives kept: ledger.jsonl.1 .. .3 (oldest dropped). */
const ROTATION_KEEP = 3;

let rotationBytesOverride: number | null = null;

/** Test hook: shrink the rotation threshold (null restores it). */
export function setRotationBytesForTest(bytes: number | null): void {
  rotationBytesOverride = bytes;
}

function rotationBytes(): number {
  return rotationBytesOverride ?? ROTATION_BYTES;
}

/** Nearest ancestor of startDir containing `.git`, else startDir itself. */
function repoRootFor(startDir: string): string {
  let cur = startDir;
  for (;;) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return startDir;
    cur = parent;
  }
}

export function readLedgerPath(cwd: string): string {
  return join(repoRootFor(cwd), ".pi", "read-ledger.jsonl");
}

/** Shift ledger → .1 → .2 → .3, dropping whatever falls past the keep count. */
export function rotateReadLedger(path: string): void {
  for (let i = ROTATION_KEEP; i >= 1; i--) {
    const from = i === 1 ? path : `${path}.${i - 1}`;
    const to = `${path}.${i}`;
    if (existsSync(from)) renameSync(from, to);
  }
}

export interface ReadRecordInput {
  /** Session cwd — the repo whose ledger this record belongs to. */
  cwd: string;
  sessionId?: string | null;
  /** Resolved absolute path of the file read. */
  file: string;
  params: { path: string; offset?: number; limit?: number };
  envelope: {
    content?: string;
    compaction?: {
      omissions?: { startLine: number; endLine: number; chars?: number; lines?: number }[] | null;
    } | null;
  };
}

/** Append one read record. Best-effort: a failed append never fails the read. */
export function appendReadRecord(input: ReadRecordInput): void {
  if (process.env.PI_READ_LEDGER === "0") return;
  try {
    const path = readLedgerPath(input.cwd);
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (statSync(path).size >= rotationBytes()) rotateReadLedger(path);
    } catch {}

    let stat: { size: number; mtimeMs: number } | null = null;
    let sha256: string | null = null;
    try {
      const st = statSync(input.file);
      stat = { size: st.size, mtimeMs: st.mtimeMs };
      if (st.size <= 1024 * 1024) {
        sha256 = createHash("sha256").update(readFileSync(input.file)).digest("hex");
      }
    } catch {}

    const omissions =
      input.envelope.compaction?.omissions?.map((o) => ({
        startLine: o.startLine,
        endLine: o.endLine,
      })) ?? null;

    const record = {
      ts: Date.now(),
      kind: "piread",
      sessionId: input.sessionId ?? null,
      path: input.file,
      requested: {
        ...(input.params.offset !== undefined ? { offset: input.params.offset } : {}),
        ...(input.params.limit !== undefined ? { limit: input.params.limit } : {}),
      },
      omissions,
      chars: input.envelope.content?.length ?? 0,
      stat,
      sha256,
    };
    appendFileSync(path, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // Index only: never fail the read itself.
  }
}
