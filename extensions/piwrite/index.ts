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

import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  getLanguageFromPath,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
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

/**
 * WC resolution rung (2026-11-07 audit, MED): a RELATIVE path whose ..
 * traversal escapes the session cwd is a lexical jailbreak — a tool error,
 * never a confirm. Absolute targets (including ~/ and file:// forms, which
 * norm expanded above) are the permission-gate's lane: outside-cwd ones
 * confirm through the gate's WC rule, so this rung must not reject them.
 * In-cwd .. spellings that stay under cwd resolve inside and pass.
 */
function assertInsideCwd(input: string, resolved: string, cwd: string): void {
  const raw = input.startsWith("@") ? input.slice(1) : input;
  if (isAbsolute(raw) || raw.startsWith("~") || /^file:\/\//.test(raw)) return;
  const rel = relative(cwd, resolved);
  if (rel === ".." || rel.startsWith("../"))
    throw new Error(
      `piwrite: path '${input}' escapes the session directory via .. — relative writes must stay under the session cwd (${cwd}); use an absolute path for outside targets (those confirm).`,
    );
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
    // WC resolution rung: relative ../ escapes are errors before any spawn
    assertInsideCwd(path, resolvedPath, spawnCwd);

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
    renderCall(args, theme, context) {
      // write.js renderCall verbatim: reuse the call component, keep the
      // streaming highlight cache while args are incomplete, drop it once
      // they complete, and hand cache + highlighter + cwd to the formatter.
      const component =
        (context.lastComponent as PiwriteCallRenderComponent | undefined) ?? new PiwriteCallRenderComponent();
      const renderArgs = args as { file_path?: unknown; path?: unknown; content?: unknown };
      const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
      const fileContent = str(renderArgs?.content);
      component.cache =
        fileContent !== null && !context.argsComplete
          ? updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent, component.highlighter)
          : undefined;
      component.setText(
        formatPiwriteCall(
          renderArgs,
          { expanded: context.expanded, isPartial: context.isPartial },
          theme,
          component.cache,
          component.highlighter,
          context.cwd,
        ),
      );
      return component;
    },
    renderResult(result, _options, theme, context) {
      const output = formatPiwriteResult({ ...result, isError: context.isError }, theme);
      if (!output) {
        const component = (context.lastComponent as Container | undefined) ?? new Container();
        component.clear();
        return component;
      }
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(output);
      return text;
    },
  });
}

/* ------------------------------------------------------------------ *
 * Interactive display — byte-for-byte parity with the built-in write
 * tool's writeRenderers (pi's dist/core/tools/renderers/write.js),
 * locked by tests/extensions/piwrite-render-parity.test.mjs against the
 * real renderers. The expressions below are copied from that file (plus
 * render-utils.js's `renderToolPath` chain), not reinvented; the title
 * carries the tool's own `piwrite` label — the one deliberate divergence
 * from the built-in's rendering, so a rendered row names its engine.
 *
 * Copied locally because the package root exports neither:
 * - `renderToolPath` -> `linkPath` -> `shortenHomePath`/`resolvePath`
 *   (utils/paths.js, POSIX shape): home-shortened, OSC8-hyperlinked path
 *   with the same null/empty fallbacks.
 * - `CodeHighlighter` (theme.js): a one-entry memo of the public
 *   `highlightCode` keyed on code, lang, and theme — a memo cannot change
 *   output, so the local highlighter calls `highlightCode` directly and
 *   renders the same bytes.
 * ------------------------------------------------------------------ */

/** render-utils.js `str`: string passthrough, nullish → "", other → null. */
function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

/** render-utils.js `replaceTabs`: one tab → three spaces. */
function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

/** render-utils.js `normalizeDisplayText`: strip carriage returns. */
function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

/** write.js `trimTrailingEmptyLines`: drop empty lines off the tail. */
function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") {
    end--;
  }
  return lines.slice(0, end);
}

/* ---- renderToolPath chain (render-utils.js + utils/paths.js) ---- */

/** utils/paths.js `isPathWithin` (POSIX shape): child is parent or inside it. */
function isPathWithin(parent: string, child: string): boolean {
  const parentKey = resolve(parent);
  const childKey = resolve(child);
  if (childKey === parentKey) return true;
  return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`);
}

/** utils/paths.js `shortenHomePath` (POSIX shape): leading home → `~`. */
function shortenHomePath(path: string, homeDir = homedir()): string {
  if (!homeDir || !isAbsolute(path) || !isPathWithin(homeDir, path)) return path;
  const relativePath = relative(homeDir, path);
  return relativePath ? `~${sep}${relativePath}` : "~";
}

/**
 * utils/paths.js `normalizePath` with render-side defaults: tilde
 * expansion and `file://` URLs, no `@`-strip or unicode-space fold (those
 * belong to the executor's `resolveToCwd`, mirrored above as
 * `resolveToolPath`). POSIX shape.
 */
function normalizeDisplayPath(input: string): string {
  const home = homedir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  if (/^file:\/\//.test(input)) return fileURLToPath(input);
  return input;
}

/** utils/paths.js `resolvePath` (POSIX shape) for the display link href. */
function resolveDisplayPath(input: string, baseDir: string): string {
  const normalized = normalizeDisplayPath(input);
  const normalizedBaseDir = normalizeDisplayPath(baseDir);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizedBaseDir, normalized);
}

/** render-utils.js `linkPath`: OSC8 hyperlink when the terminal supports it. */
function linkPath(styledText: string, rawPath: string, cwd: string | undefined): string {
  if (!getCapabilities().hyperlinks) return styledText;
  const absolutePath = resolveDisplayPath(rawPath, cwd ?? process.cwd());
  return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

/** render-utils.js `renderToolPath` (write.js passes no options). */
function renderToolPath(rawPath: string | null, theme: Theme, cwd: string | undefined): string {
  if (rawPath === null) return theme.fg("error", "[invalid arg]");
  const value = rawPath || undefined;
  if (!value) return theme.fg("toolOutput", "...");
  return linkPath(theme.fg("accent", shortenHomePath(value)), value, cwd);
}

/* ---- streaming highlight cache (write.js) ---- */

/** write.js `WRITE_PARTIAL_FULL_HIGHLIGHT_LINES`. */
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/** write.js `highlightSingleLine`: first line of a single-line highlight. */
function highlightSingleLine(line: string, lang: string): string {
  const highlighted = highlightCode(line, lang);
  return highlighted[0] ?? "";
}

/**
 * The built-in's per-component `CodeHighlighter` is a one-entry memo of
 * the public `highlightCode` keyed on code, lang, and theme; a memo
 * cannot change output, so this calls `highlightCode` directly.
 */
class PiwriteHighlighter {
  highlight(code: string, lang: string): string[] {
    return highlightCode(code, lang);
  }
}

/** write.js `WriteHighlightCache`: the incremental streaming state. */
type WriteHighlightCache = {
  rawPath: string;
  lang: string;
  rawContent: string;
  normalizedLines: string[];
  highlightedLines: string[];
};

/** write.js `refreshWriteHighlightPrefix`. */
function refreshWriteHighlightPrefix(cache: WriteHighlightCache, highlighter: PiwriteHighlighter): void {
  const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
  if (prefixCount === 0) return;
  const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
  const prefixHighlighted = highlighter.highlight(prefixSource, cache.lang);
  for (let i = 0; i < prefixCount; i++) {
    cache.highlightedLines[i] =
      prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
  }
}

/** write.js `rebuildWriteHighlightCacheFull` (null path is no-language). */
function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
  if (!rawPath) return undefined;
  const lang = getLanguageFromPath(rawPath);
  if (!lang) return undefined;
  const displayContent = normalizeDisplayText(fileContent);
  const normalized = replaceTabs(displayContent);
  return {
    rawPath,
    lang,
    rawContent: fileContent,
    normalizedLines: normalized.split("\n"),
    highlightedLines: highlightCode(normalized, lang),
  };
}

/** write.js `updateWriteHighlightCacheIncremental`. */
function updateWriteHighlightCacheIncremental(
  cache: WriteHighlightCache | undefined,
  rawPath: string | null,
  fileContent: string,
  highlighter: PiwriteHighlighter,
): WriteHighlightCache | undefined {
  const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
  if (!lang) return undefined;
  if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  if (cache.lang !== lang || cache.rawPath !== rawPath || !fileContent.startsWith(cache.rawContent)) {
    return rebuildWriteHighlightCacheFull(rawPath, fileContent);
  }
  if (fileContent.length === cache.rawContent.length) return cache;
  const deltaRaw = fileContent.slice(cache.rawContent.length);
  const deltaDisplay = normalizeDisplayText(deltaRaw);
  const deltaNormalized = replaceTabs(deltaDisplay);
  cache.rawContent = fileContent;
  if (cache.normalizedLines.length === 0) {
    cache.normalizedLines.push("");
    cache.highlightedLines.push("");
  }
  const segments = deltaNormalized.split("\n");
  const lastIndex = cache.normalizedLines.length - 1;
  cache.normalizedLines[lastIndex] += segments[0];
  cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
  for (let i = 1; i < segments.length; i++) {
    cache.normalizedLines.push(segments[i]);
    cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
  }
  refreshWriteHighlightPrefix(cache, highlighter);
  return cache;
}

/**
 * write.js `WriteCallRenderComponent`: a `Text` carrying the streaming
 * highlight cache and the highlighter — the component the TUI reuses
 * across partial updates of one call.
 */
class PiwriteCallRenderComponent extends Text {
  cache: WriteHighlightCache | undefined;
  highlighter = new PiwriteHighlighter();
  constructor() {
    super("", 0, 0);
  }
}

/** write.js `formatWriteCall` verbatim, except the title is `piwrite`. */
function formatPiwriteCall(
  args: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
  cache: WriteHighlightCache | undefined,
  highlighter: PiwriteHighlighter,
  cwd: string | undefined,
): string {
  const renderArgs = args as { file_path?: unknown; path?: unknown; content?: unknown };
  const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
  const fileContent = str(renderArgs?.content);
  const pathDisplay = renderToolPath(rawPath, theme, cwd);
  let text = `${theme.fg("toolTitle", theme.bold("piwrite"))} ${pathDisplay}`;
  if (fileContent === null) {
    text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
  } else if (fileContent) {
    const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
    const renderedLines = lang
      ? (cache?.highlightedLines ?? highlighter.highlight(replaceTabs(normalizeDisplayText(fileContent)), lang))
      : normalizeDisplayText(fileContent).split("\n");
    const lines = trimTrailingEmptyLines(renderedLines);
    const totalLines = lines.length;
    const maxLines = options.expanded ? lines.length : 10;
    const displayLines = lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
    if (remaining > 0) {
      text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    }
  }
  return text;
}

/** write.js `formatWriteResult`: nothing on success, error text otherwise. */
function formatPiwriteResult(
  result: { isError?: boolean; content: ReadonlyArray<{ type: string; text?: string }> },
  theme: Theme,
): string | undefined {
  if (!result.isError) {
    return undefined;
  }
  const output = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
  if (!output) {
    return undefined;
  }
  return `\n${theme.fg("error", output)}`;
}
