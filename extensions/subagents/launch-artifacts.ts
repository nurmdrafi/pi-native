/**
 * Rebuild a subagent's sandbox loadout from the artifacts a launch leaves
 * behind, for resume when the `.loadout.json` sidecar is gone.
 *
 * A spawn writes three things that outlive it:
 *  - `subagent-scripts/<name>-<id>.sh` — the exact `pi` command line, with
 *    `cd '<cwd>' &&`, the `PI_*` env prefix, `--model`, the system-prompt
 *    flag, and the default-deny `--tools` allowlist;
 *  - `context/<name>-sysprompt-<ts>.md` — the identity text itself;
 *  - the session file.
 *
 * Together they describe the same sandbox the sidecar recorded, so resume can
 * replay it instead of refusing. The sidecar stays authoritative when present:
 * it is the resolved snapshot, while the script is a reconstruction.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { readSubagentLoadout, type SubagentLoadout } from "./session.ts";

/** Slug used for artifact file names derived from a subagent's name. Kept
 *  identical to the launch path so lookups match what a spawn wrote. */
export function slugifySubagentName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, "") || "subagent"
  );
}

/** Shell-unquote one token written by shellEscape(): `'it'\''s'` → `it's`. */
function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("'")) return trimmed;
  const end = trimmed.lastIndexOf("'");
  if (end <= 0) return trimmed;
  return trimmed.slice(1, end).replace(/'\\''/g, "'");
}

/** One escaped single-quoted token, as shellEscape writes it. */
const Q = "'(?:[^']|'\\\\'')*'";

/** Value of `--flag '<value>'`, when present. */
function flagValue(text: string, flag: string): string | null {
  const m = text.match(new RegExp(`(?:^|\\s)${flag}\\s+(${Q})`));
  return m ? unquote(m[1]) : null;
}

/** Value of `VAR='<value>'` in the command's env prefix, when present. */
function envValue(text: string, name: string): string | null {
  const m = text.match(new RegExp(`${name}=(${Q})`));
  return m ? unquote(m[1]) : null;
}

/**
 * Parse one launch script into a loadout, or null when it is not a pi launch
 * (the claude path writes a different command and has no pi sandbox to replay).
 */
export function loadoutFromLaunchScript(scriptPath: string): SubagentLoadout | null {
  let text: string;
  try {
    text = readFileSync(scriptPath, "utf8");
  } catch {
    return null;
  }
  // A pi launch is recognizable by its session flag; anything else would be
  // reconstructed from guesses, which is exactly what refuse-instead-of-guess
  // exists to prevent.
  if (!/(?:^|\s)pi\s+--session\s/.test(text)) return null;

  const cdMatch = text.match(new RegExp(`(?:^|\\s)cd\\s+(${Q})\\s+&&`));
  const cwd = cdMatch ? unquote(cdMatch[1]) : null;

  const systemPromptAppend = flagValue(text, "--append-system-prompt");
  const systemPromptReplace = flagValue(text, "--system-prompt");
  const identityPath = systemPromptReplace ?? systemPromptAppend;
  let identity: string | null = null;
  if (identityPath) {
    try {
      identity = existsSync(identityPath) ? readFileSync(identityPath, "utf8") : null;
    } catch {
      identity = null;
    }
  }

  const allowed = envValue(text, "PI_SUBAGENT_ALLOWED");

  return {
    agent: envValue(text, "PI_SUBAGENT_AGENT"),
    // A null allowlist is faithful: a bare/fork spawn ran unrestricted and was
    // written with no --tools flag, so replaying null keeps it unrestricted.
    toolAllowlist: flagValue(text, "--tools"),
    // The script stores model and thinking together (`model:level`), so the
    // whole token is replayed as the model — applySandboxToParts appends
    // thinking only when it is set separately.
    model: flagValue(text, "--model"),
    thinking: null,
    systemPromptMode: identityPath
      ? systemPromptReplace
        ? "replace"
        : "append"
      : null,
    identity,
    spawnable: allowed ? allowed.split(",").filter(Boolean) : null,
    autoExit: /PI_SUBAGENT_AUTO_EXIT=1(?:\s|$)/.test(text),
    cwd,
    agentDir: envValue(text, "PI_CODING_AGENT_DIR"),
    budget: null,
  };
}

/**
 * Newest launch script written for `name` in this spawner session's artifact
 * dir, or null. Newest wins because a resumed child gets a fresh script per
 * attempt and the last one is the run being continued.
 */
export function findLaunchScript(artifactDir: string, name: string): string | null {
  const dir = join(artifactDir, "subagent-scripts");
  const prefix = `${slugifySubagentName(name)}-`;
  let candidates: string[];
  try {
    if (!existsSync(dir)) return null;
    candidates = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".sh"));
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const file of candidates) {
    const path = join(dir, file);
    try {
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      // Unreadable entry: skip it rather than failing the whole lookup.
    }
  }
  return best?.path ?? null;
}

/** Where a resume's sandbox came from: the spawn-time snapshot, or a rebuild
 *  from the launch artifacts when that snapshot is gone. */
export type ResumeLoadoutSource = "sidecar" | "launch-script";

/**
 * Resolve the sandbox a resume should replay: the spawn-time sidecar when it
 * is readable, else a rebuild from the launch script plus its system-prompt
 * file. Null means neither exists, and resume must refuse rather than launch
 * a child with pi's defaults (all global extensions, full toolset).
 */
export function resolveResumeLoadout(
  artifactDir: string,
  name: string,
  sessionFile: string,
): { loadout: SubagentLoadout; source: ResumeLoadoutSource } | null {
  const sidecar = readSubagentLoadout(sessionFile);
  if (sidecar) return { loadout: sidecar, source: "sidecar" };
  const script = findLaunchScript(artifactDir, name);
  if (!script) return null;
  const rebuilt = loadoutFromLaunchScript(script);
  return rebuilt ? { loadout: rebuilt, source: "launch-script" } : null;
}
