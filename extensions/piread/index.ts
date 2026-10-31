/**
 * piread — native read pipeline registered as its own tool (S6).
 *
 * Registers a distinct tool named `piread` alongside the built-in `read`
 * (2026-10-18 redesign: it previously shadowed `read` under the same name,
 * which made both tools display as one label and collided with any other
 * read-registration). Parameters are copied verbatim from
 * `createReadToolDefinition` so behavior matches, while name/label/
 * description/promptGuidelines are piread-specific and steer the model:
 * text files → piread, images → read. permission-gate treats `piread`
 * calls as read-kind (coverage/R1/anchor), so gate protection is retained
 * under the individual name.
 *
 * Dispatch (spec §5.2, daemon amendment 2026-10-17; Rust-only 2026-10-31):
 *   1. sane integer offset/limit  → persistent `bin/piread --serve` daemon
 *      (lazy-started, id-matched NDJSON over stdio; restarts on death)
 *   2. daemon transport failure   → one-shot `bin/piread` spawn per call
 *   3. anything else (spawn failure, bad envelope, bad params) → thrown
 *      tool error plus one stderr line — Rust is the only executor; there is
 *      no built-in route to hide a broken binary behind. Images are not a
 *      kind of their own: the model cannot process them, so their bytes come
 *      back as lossy text like any other binary content.
 *
 * Registers unconditionally: no env switch turns it off. A user who prefers
 * pi's built-in read simply does not load this extension (or flips the
 * permission-gate P1 rule off).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";

import { isAbsolute, join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createReadToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

    // TUI/model-visible marker: retired. The rung is now carried on
    // `details.via` (observability) instead of appending text to content,
    // which cost ~4 model tokens per read for no semantic value.

/** Rung that served a call, surfaced in `details.via` (TUI/observability only;
 * never enters model-visible content). */
type Via = "daemon" | "oneshot";

/** Transport-level daemon failure — the call moves to the one-shot rung. */
class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(`daemon unavailable (${reason})`);
    this.name = "DaemonUnavailableError";
  }
}

/** One-shot rung failure — carries the terminal failure reason. */
class OneshotError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`piread one-shot failed: ${reason}`);
    this.name = "OneshotError";
    this.reason = reason;
  }
}

const extDir = dirname(fileURLToPath(import.meta.url));

/**
 * Announce this native tool's backing extension to the subagents extension.
 *
 * Subagent spawns run with `--no-extensions` + a `--tools` allowlist plus one
 * `-e <path>` per tool-backing extension (extensions/subagents/index.ts,
 * `applySandboxToParts`). Built-in pi tool names (`read`/`bash`/`edit`) resolve
 * to no extension, so an agent definition listing only those gets the *built-in*
 * implementation and never the native pipeline. Registering here (the documented
 * `registerToolExtension` hook) lets `getToolExtensionPath` resolve this tool's
 * name, so agent definitions that list it receive `-e` for this file.
 *
 * The hook is absent when the subagents extension is not loaded, and it throws
 * when a name shadows a built-in or spawning tool — both are non-fatal here,
 * since the native tool still works in top-level sessions.
 */
function announceNativeTool(name: string, extensionPath: string): void {
  const registry = (
    globalThis as {
      __pi_interactive_subagents?: { registerToolExtension?: (n: string, p: string) => void };
    }
  ).__pi_interactive_subagents;
  try {
    registry?.registerToolExtension?.(name, extensionPath);
  } catch {
    // Contract violations are the subagents extension's to report; a failure
    // here must not break this tool's own registration.
  }
}

/** Machine-local build output (scripts/bootstrap.sh), no absolute user paths. */
const PIREAD_BIN = resolve(extDir, "../../bin/piread");

/**
 * Path to the piread binary. Defaults to the built `bin/piread`; `PI_READ_BIN`
 * overrides it. Resolved per call (not at import) so tests can point the
 * extension at a throwaway binary instead of swapping the checked-in one, which
 * lets the one-shot rung be exercised deterministically.
 */
function pireadBin(): string {
  return process.env.PI_READ_BIN || PIREAD_BIN;
}

/**
 * Per-line character cap, from `PI_READ_LINE_CAP`. Default OFF (unset, 0, or
 * non-numeric): every line stays byte-identical to the built-in read, which
 * `edit`'s exact matching depends on. When set to a positive integer, selected
 * lines longer than the cap are truncated to that many characters plus a
 * `...[+N chars]` marker; shorter lines and whitespace are never touched.
 */
function readLineCap(): number | undefined {
  const raw = process.env.PI_READ_LINE_CAP;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Mirror the built-in read tool's `resolveToCwd` (pi `path-utils.ts`):
 * unicode-space normalization, leading-`@` strip, `~` expansion, `file://`
 * URLs, then lexical resolve against cwd. The SDK does not export it, so it is
 * reproduced here; the parity suite pins the behavior. Native piread resolves
 * too, but without this pre-pass it would act on a literal-NBSP path while the
 * built-in normalizes to a space (a wrong-file read, not a fallback). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function resolveToolPath(input: string, cwd: string): string {
  const norm = (raw: string): string => {
    let n = raw.replace(UNICODE_SPACES, " ");
    if (n.startsWith("@")) n = n.slice(1);
    const home = homedir();
    if (n === "~") return home;
    if (n.startsWith("~/")) return join(home, n.slice(2));
    if (/^file:\/\//.test(n)) return fileURLToPath(n);
    return n;
  };
  const n = norm(input);
  return isAbsolute(n) ? resolve(n) : resolve(norm(cwd), n);
}

/** Read-tool params (schema: path + optional 1-based offset/limit + optional
 * `hits` fused locate+read selector — exclusive with offset/limit). */
type ReadParams = {
  path: string;
  offset?: number | null;
  limit?: number | null;
  hits?: string | null;
};

/** Structural shape of the built-in read result — the only contract piread rebuilds. */
type ReadResult = {
  content: { type: "text"; text: string }[];
  details?: { truncation?: unknown; via?: Via; locate?: unknown } | undefined;
  structuredContent?: unknown;
};

/** Schema/contract source: the built-in read definition. Copied verbatim;
 * the registration below overrides name/label/description/promptGuidelines. */
const definition = createReadToolDefinition(process.cwd());

/** piread's stdout contract (crate docs, `rust-tools/piread`). */
type PireadEnvelope = {
  ok: boolean;
  content?: string;
  truncation?: unknown;
  /** NUL in the first 8 KiB. Informational only: these bytes are returned as
   * lossy text on the same rung (no built-in route exists). */
  binary?: boolean;
  totalBytes?: number;
  /** Head-tail compaction diagnostics (null when the body fit the budget).
   * Carried here rather than printed to stderr so it stays observable without
   * a host echo of `piread: compacted (...)` reaching the conversation. */
  compaction?: {
    strategy: string;
    originalChars: number;
    visibleChars: number;
    omittedChars: number;
    /** Whole-line cuts, absolute 1-based file lines (C3): the coverage map
     * the permission gate consumes. Counts match the model-visible marker. */
    omissions?: { startLine: number; endLine: number; chars: number; lines: number }[] | null;
    partial: boolean;
  } | null;
  error?: { kind: string; message: string };
  /** Fused locate+read report (`--hits`); absent in default mode. */
  locate?:
    | {
        needle: string;
        hits: number[];
        hitsTotal: number;
        windows: [number, number][];
        totalLines: number;
      }
    | null;
};

// ---- daemon client (`piread --serve`, NDJSON over stdio) ----

type DaemonPending = {
  resolve: (envelope: PireadEnvelope) => void;
  reject: (err: Error) => void;
};

type DaemonState = {
  proc: ChildProcess;
  stdin: PipeStdin;
  stdout: PipeStdout;
  pending: Map<number, DaemonPending>;
  nextId: number;
  buffer: string;
  /** Set by killDaemon: the slot can never answer again, even if a request
   * still holds a reference to it. */
  dying: boolean;
};

/** Child stdio pipes expose libuv handle refcounting (`ref`/`unref`) at
 * runtime; @types/node models them as plain Writable/Readable — structural
 * bridge (same pattern as the d.ts identity casts above). */
interface Refable {
  ref(): void;
  unref(): void;
}
type PipeStdin = NonNullable<ChildProcess["stdin"]> & Refable;
type PipeStdout = NonNullable<ChildProcess["stdout"]> & Refable;

/** Module-lifetime daemon; null when not started or after death (lazy restart). */
let daemon: DaemonState | null = null;

function killDaemon(state: DaemonState, reason: string): void {
  if (state.dying) return; // idempotent: 'exit' after a kill must not re-sweep
  state.dying = true;
  if (daemon === state) daemon = null; // next dispatch lazily restarts
  for (const p of state.pending.values()) p.reject(new DaemonUnavailableError(reason));
  state.pending.clear();
  maybeUnrefStreams(state);
  state.proc.kill();
}

let exitHooked = false;

function startDaemon(): DaemonState | null {
  let proc: ChildProcess;
  try {
    proc = spawn(pireadBin(), ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
  } catch {
    return null; // sync spawn failure (rare); async ones arrive via 'error'
  }
  const { stdin, stdout } = proc as ChildProcess & { stdin: PipeStdin | null; stdout: PipeStdout | null };
  if (!stdin || !stdout) {
    proc.kill();
    return null;
  }
  // Prompt daemon teardown on process exit (belt-and-braces with the
  // daemon's own stdin-EOF exit); registered once, only when the native
  // path is actually used.
  if (!exitHooked) {
    exitHooked = true;
    process.on("exit", () => {
      if (daemon) daemon.proc.kill();
    });
  }
  const state: DaemonState = { proc, stdin, stdout, pending: new Map(), nextId: 1, buffer: "", dying: false };
  // Any death (crash, spawn ENOENT, garbage protocol) fails pending requests
  // into the one-shot rung and clears the slot for a lazy restart.
  proc.on("error", () => killDaemon(state, "spawn error"));
  proc.on("exit", () => killDaemon(state, "exited"));
  stdin.on("error", () => killDaemon(state, "stdin error")); // incl. EPIPE
  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    state.buffer += chunk;
    for (let nl = state.buffer.indexOf("\n"); nl >= 0; nl = state.buffer.indexOf("\n")) {
      const line = state.buffer.slice(0, nl);
      state.buffer = state.buffer.slice(nl + 1);
      handleDaemonLine(state, line);
    }
  });
  // Refcount hygiene: the daemon never keeps the host's event loop alive
  // while idle (streams unref'd), but a request in flight DOES hold the
  // loop until its response arrives — see daemonRequest/maybeUnrefStreams.
  // The daemon exits on stdin EOF when the parent goes away regardless.
  proc.unref();
  stdin.unref();
  stdout.unref();
  return state;
}

/** Hold the loop while `pending` is non-empty.
 *
 * The daemon's streams and process are unref'd at start so an idle daemon never
 * keeps the host alive. That makes liveness a refcount problem: a request in
 * flight MUST keep the loop referenced, or Node drains and exits with the await
 * unsettled — the "unsettled top-level await" hang (exit 13), which appears
 * whenever nothing else (a timer, a socket) is holding the loop open.
 * The PROCESS handle has to be ref'd too, not just the pipes: otherwise a
 * daemon that exits can never report it, and the request never settles. */
function refWhilePending(state: DaemonState): void {
  if (state.pending.size > 0) {
    state.proc.ref();
    state.stdin.ref();
    state.stdout.ref();
  }
}

/** Streams may unref only when nothing is in flight — a ref'd stdout while
 * a response is pending is what keeps the loop (and the awaited call)
 * alive; an idle daemon must not hold the host process open. */
function maybeUnrefStreams(state: DaemonState): void {
  if (state.pending.size === 0) {
    state.stdin.unref();
    state.stdout.unref();
    // The process handle was ref'd by refWhilePending; unref it too, or an
    // idle daemon keeps the host's event loop (and the host) alive forever.
    state.proc.unref();
  }
}

function handleDaemonLine(state: DaemonState, line: string): void {
  if (!line) return;
  let envelope: (PireadEnvelope & { id?: unknown }) | null = null;
  try {
    envelope = JSON.parse(line) as PireadEnvelope & { id?: unknown };
  } catch {
    killDaemon(state, "unparseable daemon line");
    return;
  }
  const pending = state.pending.get(Number(envelope.id));
  if (pending) {
    state.pending.delete(Number(envelope.id));
    maybeUnrefStreams(state);
    pending.resolve(envelope);
  }
  // Unknown ids (late responses to aborted calls) are dropped silently.
}

function daemonRequest(
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  cwd: string,
  signal: AbortSignal | undefined,
  hits: string | undefined,
): Promise<PireadEnvelope> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    if (!daemon) daemon = startDaemon();
    const state = daemon;
    if (!state) {
      reject(new DaemonUnavailableError("start failed"));
      return;
    }
    // A slot that is already dying (killed, streams destroyed, pending
    // already swept) can never answer this request: writing into it yields no
    // 'data', no write error, and no further 'exit' — the awaited call would
    // dangle for the life of the host process. Refuse it so the ladder moves
    // to the one-shot rung; the next dispatch lazily starts a fresh daemon.
    // `state.dying` is the authoritative flag: it is set before the pending
    // sweep, so a request racing the teardown is refused rather than added to
    // a map that is never swept again.
    if (
      state.dying ||
      state.stdin.destroyed ||
      state.stdin.writableEnded ||
      state.proc.exitCode !== null ||
      state.proc.signalCode !== null
    ) {
      reject(new DaemonUnavailableError("daemon torn down"));
      return;
    }
    const id = state.nextId++;
    const onAbort = () => {
      if (state.pending.delete(id)) {
        maybeUnrefStreams(state);
        reject(abortError());
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = {
      resolve: (envelope: PireadEnvelope) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(envelope);
      },
      reject: (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    };
    state.pending.set(id, settle);
    refWhilePending(state); // hold the loop until this response settles
    const lineCap = readLineCap();
    const request = JSON.stringify({
      id,
      path,
      ...(offset !== undefined ? { offset } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(hits !== undefined ? { hits } : {}),
      ...(lineCap !== undefined ? { line_cap: lineCap } : {}),
      cwd,
    });
    state.stdin.write(`${request}\n`, (err) => {
      // A write failure is the only failure signal left once the pipe has been
      // destroyed (nothing follows: no 'exit' for a slot already swept), so the
      // rejection must not be gated on the entry still being present — a
      // swept-and-reinserted request would otherwise hang. Settle only the
      // request that is still ours; the delete is unconditional.
      if (err) {
        const mine = state.pending.get(id) === settle;
        if (mine) state.pending.delete(id);
        maybeUnrefStreams(state);
        if (mine) settle.reject(new DaemonUnavailableError("write failed"));
      }
    });
  });
}

function abortError(): Error {
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

const isAbort = (err: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (err instanceof Error && err.name === "AbortError");

/**
 * Upper bound on a one-shot spawn. The daemon leg is bounded by its own death
 * handlers, but a one-shot child that never exits (a wedged or wrong binary)
 * otherwise hangs the call forever — the cross-rung hang the settle suite pins.
 * On expiry the call fails: there is no built-in rung to fall through to.
 */
const ONESHOT_TIMEOUT_MS = 15_000;

/** One-shot rung: per-call spawn, the pre-daemon dispatch path verbatim. */
async function oneshotDispatch(
  path: string,
  offset: number | undefined,
  limit: number | undefined,
  spawnCwd: string,
  signal: AbortSignal | undefined,
  hits: string | undefined,
): Promise<PireadEnvelope> {
  const args = ["--path", path];
  if (offset !== undefined) args.push("--offset", String(offset));
  if (limit !== undefined) args.push("--limit", String(limit));
  if (hits !== undefined) args.push("--hits", hits);
  const lineCap = readLineCap();
  if (lineCap !== undefined) args.push("--line-cap", String(lineCap));
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(pireadBin(), args, {
      cwd: spawnCwd,
      signal,
      timeout: ONESHOT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
    };
    if (signal?.aborted || e.name === "AbortError") throw abortError();
    // execFile failures: a killed child is our own timeout ("exit null" would
    // be uninformative); numeric `code` is the child's exit status (piread
    // usage/I-O errors), anything else (ENOENT, EACCES…) is a spawn failure.
    // A numeric exit carries the envelope on stdout (exit 3 = I/O error,
    // JSON): parse it so tool errors surface their message verbatim instead
    // of becoming a transport failure.
    if (e.killed) throw new OneshotError(`timeout after ${ONESHOT_TIMEOUT_MS}ms`);
    if (typeof e.code === "number") {
      try {
        const env = JSON.parse(String(e.stdout ?? "")) as PireadEnvelope;
        if (env && typeof env === "object" && "ok" in env) return env;
      } catch {
        /* fall through to the transport failure */
      }
    }
    throw new OneshotError(
      typeof e.code === "number" ? `exit ${e.code}` : `spawn ${String(e.code ?? e.message)}`,
    );
  }
  try {
    return JSON.parse(stdout) as PireadEnvelope;
  } catch {
    throw new OneshotError("unparseable stdout");
  }
}

export default function pireadExtension(pi: ExtensionAPI): void {
  announceNativeTool("piread", fileURLToPath(import.meta.url));

  const nativeUnavailable = (reason: string): never => {
    // Observability: one line per failure (spec §5.2).
    process.stderr.write(`piread: native unavailable (${reason})\n`);
    throw new Error(
      "piread: native read unavailable (" +
        reason +
        ") — rebuild via scripts/bootstrap.sh",
    );
  };

  const execute = async (
    toolCallId: string,
    params: ReadParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<ReadResult> => {
    const { path, offset: rawOffset, limit: rawLimit, hits: rawHits } = params;
    if (typeof path !== "string") {
      throw new Error("piread: path must be a string");
    }
    // JSON null is the wire form of an omitted optional parameter (the
    // advertised schema offers null wherever a key may be left out);
    // normalize it once so the guards and every dispatch rung below see a
    // single absence shape.
    const absent = <T>(v: T | null | undefined): T | undefined =>
      v === null ? undefined : v;
    const offset = absent(rawOffset);
    const limit = absent(rawLimit);
    const rawNeedle = absent(rawHits);
    // A client that serializes JSON null into this string parameter sends the
    // literal "null" (or "undefined") — an absent selector, not a needle.
    // Reading it as a selector rejected every paged read as a fused+offset
    // misuse and searched for the word "null" when sent alone.
    const hits =
      typeof rawNeedle === "string" && /^(?:null|undefined)$/i.test(rawNeedle.trim())
        ? undefined
        : rawNeedle;
    // Fused-mode screening mirrors the CLI contract: a nonsense needle is a
    // usage error, and combining `hits` with paging would silently turn a
    // locate into a paged read — reject both up front instead of dispatching.
    if (hits !== undefined && (typeof hits !== "string" || hits === "")) {
      throw new Error(
        typeof hits === "string"
          ? "piread: hits must be a non-empty string"
          : "piread: hits must be a string",
      );
    }
    if (hits !== undefined && (offset !== undefined || limit !== undefined)) {
      throw new Error("piread: hits cannot combine with offset/limit");
    }
    // The CLI contract is offset/limit >= 1; anything else is a usage error
    // (JS's own semantics for 0, negatives, and non-integers are
    // odd-but-defined — reject rather than approximate).
    const sane = (n: number | undefined) =>
      n === undefined || (Number.isInteger(n) && n >= 1);
    if (!sane(offset) || !sane(limit)) {
      throw new Error("piread: offset/limit must be integers >= 1");
    }
    const spawnCwd = (ctx as { cwd?: string } | undefined)?.cwd || process.cwd();
    // Resolve with the built-in's exact semantics (see resolveToolPath) so the
    // native rung acts on the same file the built-in would, not a literal path
    // that happens to exist (NBSP) or one the built-in would normalize.
    const resolvedPath = resolveToolPath(path, spawnCwd);

    // Dispatch ladder: daemon (persistent) → one-shot spawn → built-in.
    // A daemon TRANSPORT failure (crash, missing binary, bad protocol) moves
    // to the one-shot rung; a terminal failure throws — exactly one stderr
    // line per call.
    let envelope: PireadEnvelope;
    let via: Via = "daemon";
    try {
      envelope = await daemonRequest(resolvedPath, offset, limit, spawnCwd, signal, hits);
    } catch (err) {
      if (isAbort(err, signal)) throw new Error("Operation aborted");
      try {
        envelope = await oneshotDispatch(resolvedPath, offset, limit, spawnCwd, signal, hits);
        via = "oneshot";
      } catch (err2) {
        if (isAbort(err2, signal)) throw new Error("Operation aborted");
        const reason = err2 instanceof OneshotError ? err2.reason : `spawn ${String(err2)}`;
        return nativeUnavailable(reason);
      }
    }

    if (envelope.ok !== true || typeof envelope.content !== "string") {
      // Tool-level failures (missing file, EISDIR, …): surface the native
      // error verbatim — one-shot rungs report this as `exit 3`; daemon
      // envelopes carry the same condition without an exit status.
      const message = envelope.error?.message;
      throw new Error(
        typeof message === "string" && message ? message : "piread: native read failed",
      );
    }
    return {
      content: [{ type: "text", text: envelope.content }],
      details: {
        via,
        ...(envelope.truncation ? { truncation: envelope.truncation } : {}),
        ...(envelope.compaction ? { compaction: envelope.compaction } : {}),
        ...(envelope.locate ? { locate: envelope.locate } : {}),
      },
      structuredContent: envelope.content,
    };
  };

  // The envelope pipeline rebuilds `details.truncation` from piread's JSON
  // (shape-identical to the built-in's TruncationResult, pinned byte-exact by
  // the parity suite); the cast bridges the loose structural type to the
  // definition's precise one (its d.ts lives in the nested pi-agent-core
  // identity, which does not unify under skipLibCheck).
  // renderCall (lineage: retired read-label.ts): displays the piread label
  // with the requested path:offset[-end] window. Display layer only.
  // Individual registration (2026-10-18): name/label identify piread on its
  // own; description/promptGuidelines steer text reads to piread. Schema
  // keeps the built-in's three params verbatim and adds the
  // `hits` fused locate+read selector (default reads stay byte-identical).
  pi.registerTool({
    ...definition,
    // The spread's display renderer is typed against the built-in's
    // params; the null-widened optionals below no longer unify with that
    // nested identity (the same dual-copy problem the execute cast below
    // bridges). The member stays the built-in's renderer verbatim — it
    // renders results and never reads the args shape — so re-assert it.
    renderResult: definition.renderResult as never,
    name: "piread",
    label: "piread",
    description:
      "Read a text file. Use offset/limit for a targeted window; reads are windowed and large outputs spill to a temp file. Pass hits to get merged context windows around every matching line in one call.",
    promptGuidelines: [
      "Use piread to examine text files instead of cat or sed.",
      "For symbol or string lookups pass hits instead of search-then-read: one call returns the windows around every match plus the remaining hit lines.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(
        Type.Union([
          Type.Number({ description: "Line number to start reading from (1-indexed)" }),
          Type.Null(),
        ]),
      ),
      limit: Type.Optional(
        Type.Union([
          Type.Number({ description: "Maximum number of lines to read" }),
          Type.Null(),
        ]),
      ),
      hits: Type.Optional(
        Type.Union([
          Type.String({
            description:
              "Fused locate+read: return merged context windows around every line containing this string (literal, case-sensitive). Cannot combine with offset/limit.",
          }),
          Type.Null(),
        ]),
      ),
    }),
    execute: execute as typeof definition.execute,
    renderCall(args, theme, _context) {
      const start = args.offset ?? 1;
      let range = `:${start}`;
      if (args.limit) range = `:${start}-${start + args.limit - 1}`;
      const suffix = args.hits !== undefined ? ` hits:'${args.hits}'` : range;
      let text = theme.fg("success", theme.bold("piread "));
      text += theme.fg("text", `${args.path}${suffix}`);
      return new Text(text, 0, 0);
    },
  });
}

/** Test affordance: kill the persistent daemon so suites can exercise the
 * cold-start paths (missing binary, one-shot rung) mid-process. Not used by
 * the harness at runtime. */
export function __resetDaemonForTest(): void {
  if (daemon) killDaemon(daemon, "test reset");
}
