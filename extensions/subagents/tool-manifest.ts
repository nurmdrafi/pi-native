/**
 * Declarative tool-extension manifests.
 *
 * A sandboxed child launches with `--no-extensions` plus one `-e <path>` per
 * tool-backing extension, so the spawner must map each allowlisted tool name
 * to an extension file. That mapping is declarative: any extension directory
 * may ship a `pi-tools.json` manifest naming the tools it registers. Nothing
 * needs to run for the mapping to be seen, so it is load-order independent
 * by construction — unlike runtime registration, whose hook silently no-ops
 * for extensions that load before the spawner.
 *
 * Manifest shape: `{ "tools": string[], "entry"?: string }`. `entry` is
 * relative to the manifest's directory (default `index.ts`). Scanned
 * locations: `<base>/<dir>/pi-tools.json` and `<base>/<dir>/tools/pi-tools.json`
 * (the latter covers tool files bundled inside an extension directory).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_NAME = "pi-tools.json";
const MANIFEST_SUBDIRS = ["", "tools"] as const;

export interface ToolManifest {
  tools: string[];
  entry: string;
}

/** Parse one manifest file; undefined when absent, malformed, or empty.
 *  Problems go to `warn` — stderr by default, or the caller's diagnostic
 *  funnel, so manifest text never lands on the TUI input line. */
export function readToolManifest(
  manifestPath: string,
  warn: (message: string) => void = console.error,
): ToolManifest | undefined {
  if (!existsSync(manifestPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    warn(
      `[pi-subagents] malformed ${MANIFEST_NAME} at ${manifestPath}: ${err instanceof Error ? err.message : String(err)} — skipping`,
    );
    return undefined;
  }
  const record = (parsed ?? {}) as { tools?: unknown; entry?: unknown };
  if (!Array.isArray(record.tools)) {
    warn(
      `[pi-subagents] ${MANIFEST_NAME} at ${manifestPath} must carry a "tools" string array — skipping`,
    );
    return undefined;
  }
  const tools = record.tools.filter((t): t is string => typeof t === "string" && t.length > 0);
  if (tools.length === 0) return undefined;
  const entry =
    typeof record.entry === "string" && record.entry.length > 0 ? record.entry : "index.ts";
  return { tools, entry };
}

/**
 * Scan an extensions base directory for manifests. Returns tool name →
 * absolute entry-file path. Deterministic order (sorted directory listing);
 * the first declaration of a tool wins, so manifests cannot silently steal a
 * name from an earlier extension.
 */
export function scanToolManifests(
  extBase: string,
  warn: (message: string) => void = console.error,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(extBase)) return out;
  const children = readdirSync(extBase, { withFileTypes: true })
    .filter((c) => c.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const child of children) {
    for (const sub of MANIFEST_SUBDIRS) {
      const dir = join(extBase, child.name, sub);
      const manifest = readToolManifest(join(dir, MANIFEST_NAME), warn);
      if (!manifest) continue;
      const entryPath = join(dir, manifest.entry);
      for (const tool of manifest.tools) {
        if (!out.has(tool)) out.set(tool, entryPath);
      }
    }
  }
  return out;
}
