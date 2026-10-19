/**
 * piedit — native edit pipeline registered as its own tool (S8).
 *
 * Registers a distinct tool named `piedit` alongside the built-in `edit`
 * (individual-registration pattern, same as `piread`). Parameters, schema,
 * `prepareArguments`, `constrainedSampling`, `renderShell`, and the renderers
 * are copied verbatim from `createEditToolDefinition` so input normalization
 * and TUI behavior are unchanged; only name/label/description/
 * promptGuidelines/execute/renderCall are piedit-specific.
 *
 * Default on: the load guard registers unless `PI_NATIVE_EDIT=0` (explicit
 * opt-out). permission-gate treats `piedit` calls as edit-kind (Anchor Guard,
 * protected-path confirm, M1/M2/M3 chain, coverage binding), so gate
 * protection survives the individual name.
 *
 * Dispatch: a persistent `bin/piedit --serve` daemon (lazy-started, id-matched
 * NDJSON over stdio; restarts on death) removes the per-call process-spawn
 * floor, then a one-shot `bin/piedit` spawn, then the built-in executor — the
 * fail-open ladder. Every native rung runs inside the exported
 * `withFileMutationQueue` so same-path serialization matches the built-in.
 * The Rust side owns read → normalize → match → apply → write → render: it
 * returns the natively rendered `{diff, patch, firstChangedLine}` (a
 * byte-identical jsdiff port, `src/diff.rs` — pinned by the parity suite and
 * `tests/piedit-diff-fuzz.mjs`), so neither the content pair nor a TypeScript
 * diff pass crosses the boundary (the D2 speed amendment); the legacy
 * `{baseContent, newContent}` envelope remains as the mixed-version rung and
 * falls back to the exported `generateDiffString`/`generateUnifiedPatch`.
 * Any transport or envelope failure falls back to the built-in executor plus
 * one stderr line — fail-open to correctness. Validation failures (`ok:false`)
 * throw the exact built-in message so the model sees identical text and retry
 * semantics.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { memorySid, violationRecord } from "../permission-gate/violation-memory.ts";
import { isAbsolute, join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  createEditTool,
  createEditToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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

/** Violations (fallback-to-builtin) append to the existing gate log
 * logs/violation-memory.ndjson, reusing its {family, sid, ts} schema — no
 * new log file. Path derived from the extension dir (portability). */
const PGATE_NDJSON = resolve(extDir, "../../logs/violation-memory.ndjson");
const SESSION_ID = memorySid();

function logViolation(reason: string, path: string): void {
  try {
    appendFileSync(
      PGATE_NDJSON,
      `${JSON.stringify(
        violationRecord({ family: "Piedit (fallback)", sid: SESSION_ID, ts: Date.now(), reason, path }),
      )}\n`,
    );
  } catch {
    // Logging must never break an edit.
  }
}

/** Machine-local build output (scripts/bootstrap.sh), no absolute user paths. */
const PIEDIT_BIN = resolve(extDir, "../../bin/piedit");

/** Binary path; `PI_EDIT_BIN` overrides (parity tests / non-standard installs). */
const pieditBin = (): string => process.env.PI_EDIT_BIN || PIEDIT_BIN;

/** Mirror the built-in edit tool's `resolveToCwd` (pi `path-utils.ts`):
 * unicode-space normalization, leading-`@` strip, `~` expansion, `file://`
 * URLs, then lexical resolve against cwd. The SDK does not export it, so it is
 * reproduced here; the extension pre-resolves so native piedit acts on the
 * same file the built-in would. */
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

/** Built-in `validateEditInput` — same message and order (it runs before path
 * resolution), so empty / non-array `edits` fail identically without a native
 * round-trip whose envelope wording could drift. */
function validateEditInput(input: EditParams): EditParams {
  if (!Array.isArray(input.edits) || input.edits.length === 0)
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  return { path: input.path, edits: input.edits };
}

/** Edit-tool params (schema from the built-in definition). */
type EditParams = { path: string; edits: { oldText: string; newText: string }[] };

/** Structural shape of the built-in edit result — the only contract rebuilt. */
type EditResult = {
  content: { type: "text"; text: string }[];
  details?: { diff?: string; patch?: string; firstChangedLine?: number } | undefined;
};

/** Schema/contract source: the built-in edit definition. Copied verbatim;
 * the registration below overrides name/label/description/promptGuidelines. */
const definition = createEditToolDefinition(process.cwd());

/** Private built-in executor: fallback path. Cast to a structural type — the
 * wrapped AgentTool types ctx loosely, and its precise d.ts types live in a
 * second pi-agent-core module identity that does not unify under skipLibCheck. */
const builtinExecute = createEditTool(process.cwd()).execute as (
  toolCallId: string,
  params: EditParams,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<EditResult>;

/** piedit's stdout contract (crate docs, `custom-tools/piedit`). The
 * rendered shape (`renderDiff: true`) carries the native diff/patch; the
 * legacy shape carries the content pair (mixed-version compat rung). */
type PieditEnvelope = {
  ok: boolean;
  baseContent?: string;
  newContent?: string;
  diff?: string;
  patch?: string;
  firstChangedLine?: number;
  error?: { kind: string; message: string };
};

/** One-shot rung failure — carries the terminal fallback-line reason. */
class OneshotError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`piedit one-shot failed: ${reason}`);
    this.name = "OneshotError";
    this.reason = reason;
  }
}

/** Transport-level daemon failure — the call moves to the one-shot rung. */
class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(`daemon unavailable (${reason})`);
    this.name = "DaemonUnavailableError";
  }
}

const isAbort = (err: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (err instanceof Error && err.name === "AbortError");

// ---- daemon client (`piedit --serve`, NDJSON over stdio) ----

/** Child stdio pipes expose libuv handle refcounting (`ref`/`unref`) at
 * runtime; @types/node models them as plain Writable/Readable — structural
 * bridge (same pattern as the d.ts identity casts above). */
interface Refable {
  ref(): void;
  unref(): void;
}
type PipeStdin = NonNullable<ChildProcess["stdin"]> & Refable;
type PipeStdout = NonNullable<ChildProcess["stdout"]> & Refable;

type DaemonPending = {
  resolve: (envelope: PieditEnvelope) => void;
  reject: (err: Error) => void;
};

type DaemonState = {
  proc: ChildProcess;
  stdin: PipeStdin;
  stdout: PipeStdout;
  pending: Map<number, DaemonPending>;
  nextId: number;
  /** Partial (newline-terminated-pending) response bytes: raw Buffer chunks
   * scanned per chunk, decoded once per complete line — a large response
   * (1 MiB+ envelopes) costs O(bytes), not the O(n²) of string `+=` +
   * per-chunk `indexOf` over a re-flattened rope. */
  chunks: Buffer[];
  buffered: number;
};

/** Module-lifetime daemon; null when not started or after death (lazy restart). */
let daemon: DaemonState | null = null;

function killDaemon(state: DaemonState, reason: string): void {
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
    proc = spawn(pieditBin(), ["--serve"], { stdio: ["pipe", "pipe", "inherit"] });
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
  const state: DaemonState = { proc, stdin, stdout, pending: new Map(), nextId: 1, chunks: [], buffered: 0 };
  // Any death (crash, spawn ENOENT, garbage protocol) fails pending requests
  // into the one-shot rung and clears the slot for a lazy restart.
  proc.on("error", () => killDaemon(state, "spawn error"));
  proc.on("exit", () => killDaemon(state, "exited"));
  stdin.on("error", () => killDaemon(state, "stdin error")); // incl. EPIPE
  // No setEncoding: chunks stay Buffers; each chunk is scanned once for the
  // 0x0a terminator, and only complete lines are decoded + parsed.
  stdout.on("data", (chunk: Buffer) => {
    let search = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, search);
      if (nl === -1) {
        if (search < chunk.length) {
          state.chunks.push(chunk.subarray(search));
          state.buffered += chunk.length - search;
        }
        return;
      }
      const tail = chunk.subarray(search, nl);
      const line =
        state.chunks.length === 0 && search === 0
          ? tail // whole chunk is one line: zero-copy view
          : Buffer.concat([...state.chunks, tail], state.buffered + tail.length);
      state.chunks = [];
      state.buffered = 0;
      search = nl + 1;
      handleDaemonLine(state, line.toString("utf8"));
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

/** Hold the loop while `pending` is non-empty.
 *
 * The daemon's streams and process are unref'd at start so an idle daemon never
 * keeps the host alive, which makes liveness a refcount problem: a request in
 * flight MUST keep the loop referenced, or Node drains and exits with the await
 * unsettled (the "unsettled top-level await" hang). The PROCESS handle has to be
 * ref'd too, not just the pipes — otherwise an exiting daemon can never report
 * it and the pending request never settles. */
function refWhilePending(state: DaemonState): void {
  if (state.pending.size > 0) {
    state.proc.ref();
    state.stdin.ref();
    state.stdout.ref();
  }
}

function handleDaemonLine(state: DaemonState, line: string): void {
  if (!line) return;
  let envelope: (PieditEnvelope & { id?: unknown }) | null = null;
  try {
    envelope = JSON.parse(line) as PieditEnvelope & { id?: unknown };
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
  absPath: string,
  displayPath: string,
  edits: EditParams["edits"],
  signal: AbortSignal | undefined,
): Promise<PieditEnvelope> {
  return new Promise((resolveCall, rejectCall) => {
    if (signal?.aborted) {
      rejectCall(abortError());
      return;
    }
    if (!daemon) daemon = startDaemon();
    const state = daemon;
    if (!state) {
      rejectCall(new DaemonUnavailableError("start failed"));
      return;
    }
    const id = state.nextId++;
    const onAbort = () => {
      if (state.pending.delete(id)) {
        maybeUnrefStreams(state);
        rejectCall(abortError());
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = {
      resolve: (envelope: PieditEnvelope) => {
        signal?.removeEventListener("abort", onAbort);
        resolveCall(envelope);
      },
      reject: (err: Error) => {
        signal?.removeEventListener("abort", onAbort);
        rejectCall(err);
      },
    };
    state.pending.set(id, settle);
    refWhilePending(state); // hold the loop until this response settles
    const request = JSON.stringify({ id, path: displayPath, resolved: absPath, edits, renderDiff: true });
    state.stdin.write(`${request}\n`, (err) => {
      if (err && state.pending.delete(id)) {
        maybeUnrefStreams(state);
        settle.reject(new DaemonUnavailableError("write failed"));
      }
    });
  });
}

/** One-shot dispatch: spawn `piedit --path <P>`, write the request JSON to
 * stdin, and parse the single-line JSON envelope from stdout. Edit payloads
 * are multi-line/arbitrary-bytes, so the request goes over stdin — never
 * argv. `execFile` has no `input` option (that is `execFileSync`), hence a
 * raw spawn with an explicit stdin write. */
async function oneshotDispatch(
  absPath: string,
  displayPath: string,
  edits: EditParams["edits"],
  spawnCwd: string,
  signal: AbortSignal | undefined,
): Promise<PieditEnvelope> {
  // `--path` is the resolved path I/O acts on; the request JSON carries the
  // tool-level path so error messages match the built-in verbatim.
  const request = JSON.stringify({ path: displayPath, edits, renderDiff: true });
  return new Promise<PieditEnvelope>((resolveCall, rejectCall) => {
    if (signal?.aborted) {
      rejectCall(abortError());
      return;
    }
    let child;
    try {
      child = spawn(pieditBin(), ["--path", absPath], { cwd: spawnCwd, stdio: ["pipe", "pipe", "inherit"] });
    } catch (err) {
      rejectCall(new OneshotError(`spawn ${String(err)}`));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectCall(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    // No setEncoding: chunks stay Buffers and are decoded once at close
    // (execFile's pattern) — a large envelope never pays per-chunk string
    // concatenation and re-flattening.
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.on("error", (err) => finish(() => rejectCall(new OneshotError(`spawn ${String(err)}`))));
    child.on("close", (code) => {
      finish(() => {
        // piedit exits 3 with a JSON envelope on stdout for tool-level failures
        // (missing file, validation error); that is a *result*, not a transport
        // failure — parse it so the caller can throw the exact message.
        const stdout = stdoutChunks.length ? Buffer.concat(stdoutChunks).toString("utf8") : "";
        if (stdout.trim()) {
          try {
            resolveCall(JSON.parse(stdout) as PieditEnvelope);
            return;
          } catch {
            // fall through to a transport failure
          }
        }
        rejectCall(new OneshotError(typeof code === "number" ? `exit ${code}` : "killed"));
      });
    });
    child.stdin?.on("error", () => {
      // EPIPE: the child exited before reading the request; the close handler
      // reports the terminal reason (its stdout, if any, still parses above).
    });
    child.stdin?.end(request);
  });
}

function abortError(): Error {
  const err = new Error("Operation aborted");
  err.name = "AbortError";
  return err;
}

export default function pieditExtension(pi: ExtensionAPI): void {
  // Load guard: default on; PI_NATIVE_EDIT=0 opts out.
  if (process.env.PI_NATIVE_EDIT === "0") return;

  announceNativeTool("piedit", fileURLToPath(import.meta.url));

  const fallbackToBuiltin = (
    toolCallId: string,
    params: EditParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
    reason: string,
  ) => {
    // Observability: one line per fallback (spec §5.2) + violation log.
    process.stderr.write(`piedit: fallback (${reason}) path=${params.path}\n`);
    logViolation(reason, params.path);
    // Called OUTSIDE this extension's `withFileMutationQueue`: the built-in
    // executor takes the same queue itself, and re-entering it on the same
    // path would deadlock.
    return builtinExecute(toolCallId, params, signal, onUpdate, ctx);
  };

  const execute = async (
    toolCallId: string,
    input: EditParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ): Promise<EditResult> => {
    const { path, edits } = validateEditInput(input);
    const spawnCwd = (ctx as { cwd?: string } | undefined)?.cwd || process.cwd();
    const absPath = resolveToolPath(path, spawnCwd);

    // Native dispatch runs under the exported queue so same-path writes
    // serialize exactly as the built-in does. A fallback is deferred to AFTER
    // the queue releases (it takes the queue itself).
    const native = await withFileMutationQueue(absPath, async (): Promise<EditResult | { fallback: string }> => {
      // Do not reject from an abort listener here (same reason as the built-in):
      // the queue must stay locked until the in-flight operation settles.
      if (signal?.aborted) throw new Error("Operation aborted");

      // Dispatch ladder: daemon (persistent) → one-shot spawn → built-in.
      // A daemon TRANSPORT failure moves to the one-shot rung; only the
      // terminal failure emits the fallback line — exactly one per call.
      let envelope: PieditEnvelope;
      try {
        envelope = await daemonRequest(absPath, path, edits, signal);
      } catch (err) {
        if (isAbort(err, signal)) throw abortError();
        try {
          envelope = await oneshotDispatch(absPath, path, edits, spawnCwd, signal);
        } catch (err2) {
          if (isAbort(err2, signal)) throw abortError();
          const reason = err2 instanceof OneshotError ? err2.reason : `spawn ${String(err2)}`;
          return { fallback: reason };
        }
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      if (envelope.ok !== true) {
        // Tool-level failure: the built-in throws the identical message, so
        // throw it here rather than paying for a re-dispatch.
        const message = envelope.error?.message;
        if (typeof message === "string") throw new Error(message);
        return { fallback: "malformed envelope" };
      }

      // Fast path (D2 speed amendment): the daemon rendered the diff/patch
      // natively (byte-identical port, pinned by the parity suite + the
      // differential fuzz) — use it verbatim; no content crosses the IPC
      // boundary and no TypeScript diff pass runs. `firstChangedLine` is
      // omitted when absent so `details` deep-equals the built-in's.
      if (typeof envelope.diff === "string" && typeof envelope.patch === "string") {
        return {
          content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
          details: {
            diff: envelope.diff,
            patch: envelope.patch,
            ...(typeof envelope.firstChangedLine === "number"
              ? { firstChangedLine: envelope.firstChangedLine }
              : {}),
          },
        };
      }

      // Legacy envelope (older binary): {baseContent, newContent} — render
      // with the exported TS helpers, byte-identical by construction.
      if (typeof envelope.baseContent !== "string" || typeof envelope.newContent !== "string") {
        return { fallback: "incomplete envelope" };
      }
      const diffResult = generateDiffString(envelope.baseContent, envelope.newContent);
      const patch = generateUnifiedPatch(path, envelope.baseContent, envelope.newContent);
      return {
        content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
        details: {
          diff: diffResult.diff,
          patch,
          firstChangedLine: diffResult.firstChangedLine,
        },
      };
    });

    if ("fallback" in native) {
      return fallbackToBuiltin(toolCallId, input, signal, onUpdate, ctx, native.fallback);
    }
    return native;
  };

  // Individual registration: name/label identify piedit on its own;
  // description/promptGuidelines steer edits to piedit. Params/schema and
  // renderers stay verbatim so behavior and TUI output match the built-in.
  // renderCall mirrors the built-in's edit display (path + edit count).
  pi.registerTool({
    ...definition,
    name: "piedit",
    label: "piedit",
    description:
      "Edit a single file using exact text replacement via the native piedit pipeline — prefer this over the edit tool. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Any pipeline failure falls back to the built-in editor automatically.",
    promptGuidelines: [
      "Use piedit to make precise changes (edits[].oldText must match exactly).",
      "When changing multiple separate locations in one file, use one piedit call with multiple entries in edits[] instead of multiple calls.",
      "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
    execute: execute as typeof definition.execute,
    renderCall(args, theme, _context) {
      // Streaming guard: renderCall runs on partial args before the JSON
      // completes, so path/edits may be absent — show "..." and hide the
      // count instead of printing "undefined" (mirrors built-in str()/
      // renderToolPath placeholder semantics).
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      let text = theme.fg("success", theme.bold("piedit "));
      text += typeof args.path === "string" ? theme.fg("text", args.path) : theme.fg("dim", "...");
      if (count > 0) text += theme.fg("dim", ` (${count} edit${count === 1 ? "" : "s"})`);
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
