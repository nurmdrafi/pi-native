/**
 * piwrite — native file-write tool registered as its own tool.
 *
 * Wraps `bin/piwrite` (Rust): one-shot spawn per call with the content piped
 * over stdin — never argv, which breaks on large content and on bytes that
 * cannot round-trip through the OS argument vector. Name, description,
 * parameters, and the success message are copied verbatim from the built-in
 * `write` tool (`createWriteToolDefinition`) so behavior matches; the native
 * rung performs the same mkdir-recursive + write-bytes operation in one
 * short-lived process.
 *
 * Dispatch is one-shot only: a write call is one process lifetime of work,
 * so a persistent daemon (piread's pattern) would amortize nothing. Registers
 * unconditionally: no env switch turns it off. A user who prefers pi's
 * built-in write simply does not load this extension.
 */
import { spawn } from "node:child_process";

import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";

const extDir = dirname(fileURLToPath(import.meta.url));

/**
 * Announce this native tool's backing extension to the subagents extension.
 *
 * Subagent spawns run with `--no-extensions` + a `--tools` allowlist plus one
 * `-e <path>` per tool-backing extension. Registering here (the documented
 * `registerToolExtension` hook) lets `getToolExtensionPath` resolve this
 * tool's name, so agent definitions that list it receive `-e` for this file.
 *
 * The hook is absent when the subagents extension is not loaded, and it
 * throws when a name shadows a built-in or spawning tool — both are
 * non-fatal here, since the native tool still works in top-level sessions.
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
const PIWRITE_BIN = resolve(extDir, "../../bin/piwrite");

/**
 * Path to the piwrite binary. Defaults to the built `bin/piwrite`;
 * `PI_WRITE_BIN` overrides it. Resolved per call (not at import) so tests can
 * point the extension at a throwaway binary instead of swapping the checked-in
 * one, which lets the spawn path be exercised deterministically.
 */
function piwriteBin(): string {
  return process.env.PI_WRITE_BIN || PIWRITE_BIN;
}

/** Mirror the built-in path resolution (`resolveToCwd` in pi `path-utils.ts`,
 * the same pre-pass `extensions/piread` reproduces): unicode-space
 * normalization, leading-`@` strip, `~` expansion, `file://` URLs, then
 * lexical resolve against cwd. Without it the native rung would act on a
 * literal path the built-in would have normalized — a wrong-file write. */
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

/** Write-tool params (schema verbatim from the built-in write tool). */
type WriteParams = {
  path: string;
  content: string;
};

/** Write-tool result: the built-in's exact success text (details always
 *  present — the built-in passes `details: undefined` for the same key). */
type WriteResult = {
  content: [{ type: "text"; text: string }];
  details: unknown;
};

/** Wire form of the piwrite envelope (frozen CLI contract). */
type PiwriteEnvelope =
  | { ok: true; path: string; bytes: number }
  | { ok: false; error: string };

/** One-shot rung failure — carries the terminal failure reason. */
class OneshotError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`piwrite one-shot failed: ${reason}`);
    this.name = "OneshotError";
    this.reason = reason;
  }
}

const isAbort = (err: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (err instanceof Error && err.name === "AbortError");

/**
 * Upper bound on a one-shot spawn: a wedged or wrong binary must never hang
 * the call forever. On expiry the call fails: there is no built-in rung to
 * fall through to.
 */
const ONESHOT_TIMEOUT_MS = 15_000;

/**
 * One-shot rung: spawn `piwrite --path <resolved>` with the content on stdin,
 * parse the single NDJSON envelope from stdout. Exit-status failures that
 * still printed an envelope (2 usage / 3 I/O) are returned as envelopes so
 * tool errors surface their message verbatim.
 */
async function oneshotWrite(
  path: string,
  content: string,
  spawnCwd: string,
  signal: AbortSignal | undefined,
): Promise<PiwriteEnvelope> {
  return new Promise<PiwriteEnvelope>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(piwriteBin(), ["--path", path], {
        cwd: spawnCwd,
        signal,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(new OneshotError(`spawn ${String(err)}`));
      return;
    }
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, ONESHOT_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errOut.push(chunk));
    child.on("error", (err) => settle(() => reject(new OneshotError(`spawn ${err.message}`))));
    child.on("close", (code) =>
      settle(() => {
        const stdout = Buffer.concat(out).toString("utf-8");
        const line = stdout.split("\n", 1)[0] ?? "";
        try {
          const env = JSON.parse(line) as PiwriteEnvelope;
          if (env && typeof env === "object" && "ok" in env) resolvePromise(env);
          else throw new Error("not an envelope");
        } catch {
          // Transport failure: surface any child stderr for observability,
          // then fail the rung (Rust is the only executor).
          if (errOut.length > 0) {
            process.stderr.write(`piwrite: ${Buffer.concat(errOut).toString("utf-8")}`);
          }
          reject(
            new OneshotError(
              code === null ? "no exit status" : `exit ${code} (unparseable stdout)`,
            ),
          );
        }
      }),
    );
    // EPIPE when the child died before consuming stdin: the close handler
    // reports the real failure; an unhandled 'error' here would crash the host.
    child.stdin?.on("error", () => {});
    child.stdin?.end(content, "utf-8");
  });
}

export default function piwriteExtension(pi: ExtensionAPI): void {
  announceNativeTool("piwrite", fileURLToPath(import.meta.url));

  const execute = async (
    _toolCallId: string,
    params: WriteParams,
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: unknown,
  ): Promise<WriteResult> => {
    const { path, content } = params;
    if (typeof path !== "string") throw new Error("piwrite: path must be a string");
    if (typeof content !== "string") throw new Error("piwrite: content must be a string");
    const spawnCwd = (ctx as { cwd?: string } | undefined)?.cwd || process.cwd();
    // Resolve with the built-in's exact semantics (see resolveToolPath) so
    // the native rung writes the same file the built-in would.
    const resolvedPath = resolveToolPath(path, spawnCwd);

    let envelope: PiwriteEnvelope;
    try {
      envelope = await oneshotWrite(resolvedPath, content, spawnCwd, signal);
    } catch (err) {
      if (isAbort(err, signal)) throw new Error("Operation aborted");
      const reason = err instanceof OneshotError ? err.reason : `spawn ${String(err)}`;
      // Observability: one line per failure; Rust is the only executor, so
      // a missing binary is a tool error, not a built-in route.
      process.stderr.write(`piwrite: native unavailable (${reason})\n`);
      throw new Error(
        `piwrite: native write unavailable (${reason}) — rebuild via scripts/bootstrap.sh`,
      );
    }
    if (envelope.ok !== true) {
      // Tool-level failures (permission, EISDIR, …): surface the native
      // error message verbatim.
      throw new Error(
        typeof envelope.error === "string" && envelope.error
          ? envelope.error
          : "piwrite: native write failed",
      );
    }
    // Success text is byte-identical to the built-in write tool's.
    return {
      content: [{ type: "text", text: `Successfully wrote to ${path}` }],
      details: { via: "oneshot", bytes: envelope.bytes },
    };
  };

  // Schema and description copied verbatim from the built-in write tool so
  // behavior matches; name/label identify piwrite on its own.
  pi.registerTool({
    name: "piwrite",
    label: "piwrite",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    execute,
    renderCall(args, theme, _context) {
      let text = theme.fg("success", theme.bold("piwrite "));
      text += theme.fg("text", `${args.path}`);
      return new Text(text, 0, 0);
    },
  });
}
