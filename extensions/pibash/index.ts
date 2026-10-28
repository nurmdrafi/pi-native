/**
 * pibash — native shell tool registered as its own tool.
 *
 * Registers a distinct tool named `pibash` alongside the built-in `bash`.
 * Parameters are copied verbatim from `createBashToolDefinition` so the
 * schema matches; name/label/description/promptGuidelines are pibash-specific
 * and steer the model to pibash for shell work. permission-gate treats
 * `pibash` calls as bash-kind (H1 output cap, R10 re-run guard, destructive
 * analysis, mutation tracking), so gate protection is retained.
 *
 * Dispatch (daemon ladder, same shape as piread/piedit):
 *   1. `bin/pibash --serve` daemon — persistent, id-matched NDJSON over stdio,
 *      lazily started, restarted on death. This rung is what makes the native
 *      path beat the built-in: one spawn per session, not one per call.
 *   2. one-shot `bin/pibash` spawn per call when the daemon transport fails.
 *   3. built-in bash implementation — fail-open to correctness — plus ONE
 *      stderr fallback line (the terminal reason) per call.
 *
 * The session-sensitive parts live here: the full spawn environment (PI_* keys
 * and the managed PATH) is rebuilt per call and sent with each request, the
 * daemon reports the child pid plus throttled partial output (stream:true) so
 * live output can be rendered, and an AbortSignal kills the whole process group
 * mid-run.
 *
 * Default on: the load guard registers unless PI_NATIVE_BASH=0 (explicit
 * opt-out — the ladder still guarantees the built-in path when the native
 * binary is missing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashTool,
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/** Transport-level daemon failure — the call moves to the one-shot rung. */
class DaemonUnavailableError extends Error {
  constructor(reason: string) {
    super(`daemon unavailable (${reason})`);
    this.name = "DaemonUnavailableError";
  }
}

/** Wraps an error that must reach the caller unchanged (built-in parity for the
 * spawn/timeout failure shapes), distinguishing it from a transport failure that
 * should fall open to the built-in executor. */
class ParityError extends Error {
  readonly cause: Error;
  constructor(cause: Error) {
    super(cause.message);
    this.name = "ParityError";
    this.cause = cause;
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
const PIBASH_BIN = resolve(extDir, "../../bin/pibash");

/** Binary path; `PI_BASH_BIN` overrides (parity tests / non-standard installs). */
const pibashBin = (): string => process.env.PI_BASH_BIN || PIBASH_BIN;

/** The built-in's MAX_TIMEOUT_MS / 1000. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;

/** Session env keys the built-in deletes, then re-sets from ctx. */
const CONTEXT_ENV_KEYS = [
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
] as const;

/** The built-in's getBinDir() — ~/.pi/agent/bin, with the env override. */
function agentBinDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "bin");
}

/** The bits of the SDK tool context the spawn environment depends on. */
type ExecContext = {
  cwd?: string;
  sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
};

/** Port of the built-in's resolveTimeoutMs: validate before spawning. */
function resolveTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  if (timeout * 1000 > 2_147_483_647) {
    throw new Error("Invalid timeout: maximum is " + MAX_TIMEOUT_SECONDS + " seconds");
  }
}

/**
 * Port of the built-in's resolveSpawnContext + getShellEnv: a full copy of the
 * parent environment with the PI_* session keys removed (then re-set from ctx)
 * and the managed bin dir prepended to PATH. Sent with every request so the
 * daemon — whose own environment is frozen at startup — runs commands exactly
 * as the in-process built-in would.
 */
export function buildEnv(ctx: ExecContext | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of CONTEXT_ENV_KEYS) delete env[key];
  const sessionId = ctx?.sessionManager?.getSessionId();
  if (sessionId) env.PI_SESSION_ID = sessionId;
  const sessionFile = ctx?.sessionManager?.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx?.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx?.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const binDir = agentBinDir();
  const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
  if (!entries.includes(binDir)) {
    env[pathKey] = [binDir, ...entries].join(delimiter);
  }
  // BASH_ENV (nvm bootstrap) for non-interactive daemon shells: default to
  // the repo's scripts/env.sh when unset so node resolves without per-command
  // `nvm use` prefixes; an explicit value always wins, absent file = no-op.
  if (env.BASH_ENV === undefined && existsSync(join(extDir, "..", "..", "scripts", "env.sh")))
    env.BASH_ENV = join(extDir, "..", "..", "scripts", "env.sh");
  return env;
}

/** pibash's stdout contract (crate docs, `rust-tools/pibash`). */
type PibashEnvelope = {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  /** Rust serializes this camelCase, matching the built-in's details field. */
  fullOutputPath?: string;
  exit_code?: number;
  wall_time_seconds?: number;
  structured_output?: string;
  structured_truncated?: boolean;
  truncation?: unknown;
  compression?: { strategy?: string; omittedChars?: number };
  token_estimate?: number;
  error?: { kind: string; message: string };
};

/** A streamed partial line emitted for a stream:true request. */
type PibashPartial = {
  id?: number;
  partial?: boolean;
  started?: boolean;
  pid?: number;
  text?: string;
  truncation?: unknown;
  fullOutputPath?: string;
};

type BashParams = { command: string; timeout?: number };

/** Structural result shape — the only contract pibash rebuilds. */
type BashResult = {
  content: { type: "text"; text: string }[];
  details?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

/** Schema/prompt source: the built-in bash definition. Copied verbatim; the
 * registration below overrides name/label/description/promptGuidelines. */
const definition = createBashToolDefinition(process.cwd());

/** Private built-in executor — the final fail-open rung. Never registered. */
const builtinExecute = createBashTool(process.cwd()).execute as (
  toolCallId: string,
  params: BashParams,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<BashResult>;

// ---- daemon client (`pibash --serve`, NDJSON over stdio) ----

type DaemonPending = {
  resolve: (envelope: PibashEnvelope) => void;
  reject: (err: Error) => void;
  onUpdate?: (update: BashResult) => void;
  /** Settle refcounts and drop the abort listener. */
  cleanup: () => void;
  pid?: number;
  aborted?: boolean;
};

type DaemonState = {
  proc: ChildProcess;
  stdin: PipeStdin;
  stdout: PipeStdout;
  pending: Map<number, DaemonPending>;
  nextId: number;
  buffer: string;
};

/** Child stdio pipes expose libuv refcounting at runtime; @types/node models
 * them as plain streams — structural bridge. */
interface Refable {
  ref(): void;
  unref(): void;
}
interface PipeStdin extends Refable {
  write(chunk: string): boolean;
  end(): void;
  on(event: "error", listener: (err: Error) => void): void;
}
interface PipeStdout extends Refable {
  on(event: "data", listener: (chunk: Buffer) => void): void;
}

let daemon: DaemonState | undefined;

function killDaemon(state: DaemonState, reason: string): void {
  if (daemon === state) daemon = undefined;
  const pendingEntries = [...state.pending.values()];
  state.pending.clear();
  for (const pending of pendingEntries) {
    pending.cleanup();
    pending.reject(new DaemonUnavailableError(reason));
  }
  try {
    state.stdin.end();
    state.proc.kill();
  } catch {
    // Best effort: a dead daemon needs no cleanup.
  }
}

function startDaemon(): DaemonState {
  const proc = spawn(pibashBin(), ["--serve"], { stdio: ["pipe", "pipe", "ignore"] });
  const state: DaemonState = {
    proc,
    stdin: proc.stdin as unknown as PipeStdin,
    stdout: proc.stdout as unknown as PipeStdout,
    pending: new Map(),
    nextId: 1,
    buffer: "",
  };
  state.stdout.on("data", (chunk: Buffer) => {
    state.buffer += chunk.toString("utf8");
    for (;;) {
      const newline = state.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let parsed: (PibashEnvelope & PibashPartial) | undefined;
      try {
        parsed = JSON.parse(line) as PibashEnvelope & PibashPartial;
      } catch {
        killDaemon(state, "unparseable response line");
        return;
      }
      const id = parsed.id;
      if (id === undefined) continue;
      const pending = state.pending.get(id);
      if (!pending) continue;
      if (parsed.partial) {
        if (parsed.pid !== undefined) pending.pid = parsed.pid;
        if (pending.aborted && pending.pid !== undefined) killProcessGroup(pending.pid);
        if (!parsed.started && pending.onUpdate) pending.onUpdate(toPartialResult(parsed));
        continue;
      }
      state.pending.delete(id);
      pending.cleanup();
      if (pending.aborted) {
        pending.reject(
          new ParityError(new Error(appendStatus(parsed.text ?? "", "Command aborted"))),
        );
      } else {
        pending.resolve(parsed);
      }
    }
  });
  proc.on("error", (err: Error) => killDaemon(state, err.message));
  proc.on("exit", () => killDaemon(state, "daemon exited"));
  state.stdin.on("error", () => killDaemon(state, "daemon stdin closed"));
  // Idle daemon must not hold the process open.
  (state.stdin as unknown as Refable).unref();
  (state.stdout as unknown as Refable).unref();
  state.proc.unref();
  return state;
}

function ensureDaemon(): DaemonState {
  daemon ??= startDaemon();
  return daemon;
}

function request(
  state: DaemonState,
  command: string,
  cwd: string,
  timeout: number | undefined,
  env: Record<string, string>,
  options: { signal?: AbortSignal; onUpdate?: (update: BashResult) => void } = {},
): Promise<PibashEnvelope> {
  const id = state.nextId++;
  const stream = Boolean(options.signal || options.onUpdate);
  const payload = JSON.stringify({ id, command, cwd, timeout, env, stream });
  return new Promise<PibashEnvelope>((resolve, reject) => {
    (state.stdin as unknown as Refable).ref();
    (state.stdout as unknown as Refable).ref();
    state.proc.ref();
    const settle = (): void => {
      if (state.pending.size > 0) return;
      (state.stdin as unknown as Refable).unref();
      (state.stdout as unknown as Refable).unref();
      state.proc.unref();
    };
    const signal = options.signal;
    const onAbort = (): void => {
      const pending = state.pending.get(id);
      if (!pending) return;
      pending.aborted = true;
      if (pending.pid !== undefined) killProcessGroup(pending.pid);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const pending: DaemonPending = {
      resolve,
      reject,
      onUpdate: options.onUpdate,
      cleanup: () => {
        settle();
        if (signal) signal.removeEventListener("abort", onAbort);
      },
    };
    state.pending.set(id, pending);
    try {
      state.stdin.write(payload + "\n");
    } catch (err) {
      state.pending.delete(id);
      pending.cleanup();
      reject(new DaemonUnavailableError(err instanceof Error ? err.message : String(err)));
    }
  });
}

/** One-shot rung: a single `pibash` spawn per call. */
/** Kill a shell's whole process group (runner spawns it detached). */
function killProcessGroup(pid: number): void {
  if (process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** The built-in's appendStatus. */
function appendStatus(text: string, status: string): string {
  return text ? text + "\n\n" + status : status;
}

/** Render a streamed partial line as the built-in's onUpdate payload shape. */
function toPartialResult(partial: PibashPartial): BashResult {
  const details = partial.truncation
    ? { truncation: partial.truncation, fullOutputPath: partial.fullOutputPath }
    : undefined;
  return { content: [{ type: "text", text: partial.text ?? "" }], details };
}

function oneShot(
  command: string,
  cwd: string,
  timeout: number | undefined,
  env: Record<string, string>,
): Promise<PibashEnvelope> {
  const args = ["--command", command, "--cwd", cwd];
  if (timeout !== undefined) args.push("--timeout", String(timeout));
  return new Promise<PibashEnvelope>((resolve, reject) => {
    const proc = spawn(pibashBin(), args, { stdio: ["ignore", "pipe", "ignore"], env });
    let stdout = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.on("error", (err: Error) => reject(new DaemonUnavailableError(err.message)));
    proc.on("exit", () => {
      const line = stdout.trim().split("\n").filter(Boolean).pop();
      if (!line) {
        reject(new DaemonUnavailableError("empty one-shot output"));
        return;
      }
      try {
        resolve(JSON.parse(line) as PibashEnvelope);
      } catch (err) {
        reject(new DaemonUnavailableError(err instanceof Error ? err.message : String(err)));
      }
    });
  });
}

/** Rebuild the built-in's result envelope from a pibash response. */
function toResult(envelope: PibashEnvelope): BashResult {
  const exitCode = envelope.exit_code ?? 0;
  const truncated = envelope.truncated === true;
  // The oracle only emits `details` when the output was truncated; an
  // unconditional object would add `{truncation: undefined}` and break parity.
  let details;
  if (truncated) {
    // The daemon omits `truncation.content` (it is always an exact prefix of
    // the display text and would double the envelope bytes); restore it here so
    // `details.truncation` is byte-identical to the built-in's.
    const truncation = envelope.truncation as { content?: string } | undefined;
    if (truncation && truncation.content === undefined) {
      // The note is appended after a blank line; everything before it is content.
      const displayText = envelope.text ?? "";
      const noteAt = displayText.indexOf("\n\n[");
      truncation.content = noteAt === -1 ? displayText : displayText.slice(0, noteAt);
    }
    details = { truncation, fullOutputPath: envelope.fullOutputPath };
  }
  // Forward the additive compression metadata so the permission gate can skip
  // its H1 re-truncation for output the Rust engine already pruned to the
  // model budget (otherwise the gate would re-cut rescued error lines).
  if (envelope.compression) {
    details = { ...(details ?? {}), compression: envelope.compression };
  }
  const structuredContent = {
    output: envelope.structured_output ?? "",
    truncated: envelope.structured_truncated === true,
    ...(envelope.structured_truncated === true && envelope.fullOutputPath
      ? { full_output_path: envelope.fullOutputPath }
      : {}),
    exit_code: exitCode,
    wall_time_seconds: envelope.wall_time_seconds ?? 0,
  };
  const text = envelope.text ?? "";
  if (exitCode !== 0) {
    return {
      content: [{ type: "text", text: `${text ? `${text}\n\n` : ""}Command exited with code ${exitCode}` }],
      details,
      structuredContent,
      isError: true,
    };
  }
  return { content: [{ type: "text", text }], details, structuredContent };
}

export default function pibashExtension(pi: ExtensionAPI): void {
  if (process.env.PI_NATIVE_BASH === "0") return;

  announceNativeTool("pibash", fileURLToPath(import.meta.url));

  async function execute(
    toolCallId: string,
    params: BashParams,
    signal?: AbortSignal,
    onUpdate?: (update: BashResult) => void,
    ctx?: ExecContext,
  ): Promise<BashResult> {
    const command = typeof params?.command === "string" ? params.command : "";
    if (!command.trim()) return builtinExecute(toolCallId, params, signal, onUpdate, ctx);
    const cwd = ctx?.cwd ?? process.cwd();
    const timeout = typeof params.timeout === "number" ? params.timeout : undefined;
    // Validate before dispatching: the built-in rejects a bad timeout with a
    // thrown error, which must not fall open to a second spawn attempt.
    resolveTimeout(timeout);
    // The built-in checks the signal before spawning and rejects with a bare
    // "Command aborted"; mirror that for an already-aborted call. Mid-run
    // cancellation still needs daemon-side support.
    if (signal?.aborted) throw new Error("Command aborted");
    const env = buildEnv(ctx);
    // The built-in emits one empty update up front; mirror it.
    if (onUpdate) onUpdate({ content: [], details: undefined });
    let reason = "unknown";
    try {
      let envelope: PibashEnvelope;
      try {
        envelope = await request(ensureDaemon(), command, cwd, timeout, env, { signal, onUpdate });
      } catch (err) {
        if (!(err instanceof DaemonUnavailableError)) throw err;
        reason = `daemon: ${err.message}`;
        envelope = await oneShot(command, cwd, timeout, env);
      }
      if (!envelope.ok) {
        // The built-in THROWS for a missing cwd and for a timeout (it does not
        // return an error result). Rethrow those two so callers observe the same
        // failure shape; anything else falls open to the built-in executor.
        const kind = envelope.error?.kind;
        if (kind === "spawn" || kind === "timeout") {
          throw new ParityError(new Error(envelope.error?.message ?? kind));
        }
        reason = `native error: ${envelope.error?.message ?? "unknown"}`;
        return builtinExecute(toolCallId, params, signal, onUpdate, ctx);
      }
      return toResult(envelope);
    } catch (err) {
      // A deliberate parity rethrow (spawn/timeout) must propagate untouched —
      // only transport failures fall through to the built-in.
      if (err instanceof ParityError) throw err.cause;
      reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`pibash: falling back to built-in bash (${reason})\n`);
      return builtinExecute(toolCallId, params, signal, onUpdate, ctx);
    }
  }

  pi.registerTool({
    ...definition,
    name: "pibash",
    label: "pibash",
    description:
      "Execute a bash command via the native pibash pipeline — prefer this over the bash tool for shell work. Returns stdout and stderr. The raw pipeline truncates to the last 2000 lines or 50KB (whichever is hit first) and spills the full output to a temp file; permission-gate H1 then caps what reaches the model to 40 lines / 2KB — so keep commands' output targeted (rg/head/awk), not flooding. Optionally provide a timeout in seconds. Any pipeline failure falls back to the built-in bash tool automatically.",
    promptGuidelines: [
      "Use pibash to run shell commands instead of the built-in bash tool — it runs the same schema and bash-kind gate rules and falls back to the built-in executor automatically.",
      ...(definition.promptGuidelines ?? []),
    ],
    execute: execute as typeof definition.execute,
    renderCall(args, theme) {
      let text = theme.fg("success", theme.bold("pibash ")) + theme.fg("text", args.command);
      if (args.timeout) text += theme.fg("dim", ` (timeout ${args.timeout}s)`);
      return new Text(text, 0, 0);
    },
  });
}

/** Test affordance: kill the daemon so suites can exercise the cold-start
 * paths (missing binary, one-shot rung) mid-process. */
export function __resetDaemonForTest(): void {
  if (daemon) killDaemon(daemon, "test reset");
}
