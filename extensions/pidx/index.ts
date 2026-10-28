/**
 * pidx — native session-log indexer registered as its own tool.
 *
 * Wraps bin/pidx (Rust crate, rust-tools/pidx): parses pi session transcripts
 * into compact per-session extracts (turns, tool calls with param hashes,
 * tool results, compactions, skill loads). Incremental via (size, mtime_ns)
 * cache in the state file, so warm runs are O(changes).
 *
 * Dispatch: one-shot execFile per call (indexing is infrequent; no daemon
 * needed). Failures throw — the model sees a failed tool result and can
 * fall back to the Node parser (session-audit slow path).
 *
 * Context discipline (token economy): extracts are written to a file by
 * default and ONLY a compact pointer line enters the model context. The raw
 * JSONL listing (one long line per session) is never dumped inline unless the
 * caller opts in with `stdout: true`, and even then it is hard-capped.
 * PI_PIDX_MAX_INLINE toggles that cap (default 2000 chars).
 *
 * Load guard: default on; PI_NATIVE_PIDX=0 opts out.
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

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
const PIDX_BIN = resolve(extDir, "../../bin/pidx");

/** Binary path; `PI_PIDX_BIN` overrides (non-standard installs). */
const pidxBin = (): string => process.env.PI_PIDX_BIN || PIDX_BIN;

/** Where default extracts go — beside the pidx cache, never in the repo. */
const CACHE_DIR = join(homedir(), ".pi", "agent", ".cache");
const DEFAULT_OUT = join(CACHE_DIR, "pidx-extracts.jsonl");

/** Hard cap for the opt-in inline path, so a stray dump cannot blow context. */
const MAX_INLINE_CHARS = Number(process.env.PI_PIDX_MAX_INLINE ?? 2000);

/**
 * Roots a pidx path parameter may resolve inside (X2, audit §10): the agent
 * state/cache dir and the current repo root. A path outside every root is
 * refused rather than silently created.
 */
const SANDBOX_ROOTS = [join(homedir(), ".pi", "agent"), process.cwd()].map((r) => resolve(r));

/** True when `candidate` is `root` itself or sits beneath it. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Reject a path parameter that resolves outside every sandbox root. Resolution
 * happens first, so `../` traversal and symlinked spellings are compared on
 * their real destination, not their literal text.
 */
function assertContained(param: string, value: string): void {
  const abs = resolve(value);
  if (!SANDBOX_ROOTS.some((root) => isInside(root, abs))) {
    throw new Error(
      `pidx: parameter "${param}" resolves outside the sandbox (containment): ` +
        `${abs}. Allowed roots: ${SANDBOX_ROOTS.join(", ")}.`,
    );
  }
}

/**
 * `force` overwrites an existing cache/state file, so it requires an explicit
 * acknowledgement from the caller rather than a bare boolean. `force: true`
 * is refused with a message naming the confirm option; only `"confirm"` (or
 * the env opt-out used by the test-suite) proceeds.
 */
function assertForceConfirmed(value: unknown): void {
  if (value === true && process.env.PI_PIDX_FORCE_CONFIRM !== "1") {
    throw new Error(
      'pidx: parameter "force" requires explicit confirmation — pass confirm ' +
        'to overwrite the existing cache/state file.',
    );
  }
}

type PidxParams = {
  sessionsDir?: string;
  state?: string;
  out?: string;
  max?: number;
  /** `true` alone is refused; `"confirm"` (or the env opt-out) proceeds. */
  force?: boolean | "confirm";
  /** Opt in to returning raw extracts in context (hard-capped). Default false. */
  stdout?: boolean;
};

/**
 * Accepted parameter names — single source of truth for the schema below and
 * for the runtime guard in execute(). Keep in sync with Type.Object({...}).
 */
const PIDX_PARAM_KEYS = ['sessionsDir', 'state', 'out', 'max', 'force', 'stdout'] as const;

/**
 * Reject unknown parameters instead of silently dropping them.
 *
 * Root-cause guard for session 01a14440 (2026-10-16): a call shaped
 * pidx({ pattern, path }) had both args dropped by schema tolerance, so every
 * `if (params.X)` guard fell through and the tool ran its default
 * behaviour, returning the whole session index. That entered context at ~40KB
 * (3.5M raw tokens before truncation) with isError === false, so nothing
 * signalled the call was malformed. A hard error is far cheaper than a silent
 * wrong-success.
 *
 * Deliberately enforced at runtime, not by schema alone: additionalProperties
 * is advisory at this boundary and cannot be relied on to fire.
 */
function rejectUnknownParams(params: Record<string, unknown>): string[] {
  const allowed: readonly string[] = PIDX_PARAM_KEYS;
  return Object.keys(params).filter((k) => !allowed.includes(k));
}

const pidxTool = defineTool({
  name: "pidx",
  label: "pidx",
  description:
    "Index pi session logs into compact per-session extracts (turns, tool calls with param hashes, tool results, compactions, skill loads) via the native Rust indexer. Incremental: unchanged files reuse the cached extract, so warm runs only process changes. Extracts are written to a file (default .cache/pidx-extracts.jsonl) and only a short pointer plus summary enters context — read or query that file for details. Pass stdout:true only when the listing itself is needed (hard-capped). Use this as the fast path for session-audit and session-history analysis.",
  promptGuidelines: [
    "Use this as the fast path for session-audit and session-history analysis.",
  ],
  parameters: Type.Object({
    sessionsDir: Type.Optional(
      Type.String({ description: "Sessions directory to scan (default: pi default sessions dir)" }),
    ),
    state: Type.Optional(
      Type.String({ description: "Cache/state file path (default: repo .pidx-state.bin)" }),
    ),
    out: Type.Optional(
      Type.String({ description: "Path for the extracts JSONL (default: <home>/.pi/agent/.cache/pidx-extracts.jsonl). Never dumped inline." }),
    ),
    max: Type.Optional(Type.Number({ description: "Limit number of sessions in output" })),
    force: Type.Optional(
      Type.Union([Type.Boolean(), Type.Literal("confirm")], {
        description:
          "Re-index everything, ignoring the cache. `true` alone is refused — pass \"confirm\" to overwrite the cache/state file",
      }),
    ),
    stdout: Type.Optional(
      Type.Boolean({ description: "Return the raw extracts in context instead of only a pointer (hard-capped; default false)" }),
    ),
  }, { additionalProperties: false }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },

  async execute(_toolCallId, params: PidxParams, signal) {
    // Fail closed on unknown params before doing any work. Without this, a
    // malformed call silently degrades to default behaviour and can return the
    // entire session index — see rejectUnknownParams() for the incident.
    const unknown = rejectUnknownParams(params as Record<string, unknown>);
    if (unknown.length > 0) {
      throw new Error(
        `pidx: unknown parameter(s): ${unknown.join(', ')}. ` +
          `Accepted: ${PIDX_PARAM_KEYS.join(', ')}. ` +
          'If you meant to search file contents, use rg/piread — pidx only indexes session logs.',
      );
    }

    // Token economy: extracts go to a file unless the caller explicitly opts
    // into the (capped) inline path. This keeps the per-call context cost at
    // one short line instead of a full JSONL dump of every session.
    const inline = params.stdout === true;
    const outPath = params.out ?? (inline ? undefined : DEFAULT_OUT);

    // X2 (permission-gate audit §10): `out`/`state`/`sessionsDir` used to be
    // forwarded verbatim, so a caller could point them at any path on disk.
    // Every path param must now resolve inside one of the sandbox roots
    // before anything is created or spawned.
    for (const [key, value] of [
      ["out", outPath],
      ["state", params.state],
      ["sessionsDir", params.sessionsDir],
    ] as const) {
      if (typeof value === "string" && value !== "") assertContained(key, value);
    }
    if (params.force) assertForceConfirmed(params.force);

    if (outPath) mkdirSync(dirname(outPath), { recursive: true });

    const args: string[] = [];
    if (params.sessionsDir) args.push("--sessions-dir", params.sessionsDir);
    if (params.state) args.push("--state", params.state);
    if (outPath) args.push("--out", outPath);
    if (params.max !== undefined) args.push("--max", String(params.max));
    if (params.force === true || params.force === "confirm") args.push("--force");

    const { stdout, stderr } = await execFileAsync(pidxBin(), args, {
      maxBuffer: 64 * 1024 * 1024,
      signal,
    });

    // stdout: one JSON per session (or empty when --out was given).
    // stderr: single summary JSON line — surface it in details either way.
    let summary: unknown;
    try {
      summary = stderr.trim() ? JSON.parse(stderr.trim().split("\n").pop()!) : undefined;
    } catch {
      summary = stderr.trim();
    }

    const s = (summary ?? {}) as Record<string, unknown>;
    const summaryBits =
      summary && typeof summary === "object"
        ? `sessions=${s.sessions ?? "?"} parsed=${s.parsed ?? "?"} reused=${s.reused ?? "?"}`
        : "summary unavailable";

    let content: string;
    if (inline) {
      // Explicit opt-in: still capped so a dump cannot blow context.
      const raw = stdout.trim();
      if (raw.length <= MAX_INLINE_CHARS) {
        content = raw || "No sessions found.";
      } else {
        const lines = raw.split("\n").length;
        content = `${raw.slice(0, MAX_INLINE_CHARS)}\n… [truncated: ${lines} sessions, ${raw.length} chars — full listing not inlined]`;
      }
    } else if (stdout.trim().length > 0) {
      // Defensive: --out given but tool still emitted bytes; do not inline them.
      content = `Extracts written to ${outPath} (${summaryBits}); output suppressed to save context.`;
    } else {
      content = `Extracts written to ${outPath} (${summaryBits}). Read or query that file for details.`;
    }

    return {
      content: [{ type: "text", text: content }],
      details: { summary, out: outPath, inline, bin: pidxBin() },
    };
  },

  renderCall(args, theme) {
    let text = theme.fg("success", theme.bold("pidx "));
    const bits: string[] = [];
    if (args.sessionsDir) bits.push(args.sessionsDir);
    if (args.max !== undefined) bits.push(`max=${args.max}`);
    if (args.force) bits.push("--force");
    if (args.stdout) bits.push("stdout");
    text += theme.fg("text", bits.join(" ") || "sessions");
    return new Text(text, 0, 0);
  },
});

export default function pidxExtension(pi: ExtensionAPI): void {
  // Load guard: default on; PI_NATIVE_PIDX=0 opts out.
  if (process.env.PI_NATIVE_PIDX === "0") return;

  announceNativeTool("pidx", fileURLToPath(import.meta.url));

  pi.registerTool(pidxTool);
}
