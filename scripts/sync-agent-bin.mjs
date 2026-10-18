#!/usr/bin/env node
/**
 * sync-agent-bin — make the agent bin dir resolvable and keep native tools fresh.
 *
 * Portable by design: macOS and Linux, zsh and bash. It never hardcodes a
 * home path and never uses bash-only syntax in the block it writes, so the
 * same run works on a fresh machine.
 *
 * Three idempotent steps, each skipped when already satisfied:
 *
 * 1. Shell PATH pin — append a guarded `case` block to the user's shell rc so
 *    a fresh terminal resolves `rg` (PCRE2 build), `piread`, `piedit`,
 *    `pibash`, `pidx`, and `fd` from `~/.pi/agent/bin`.
 * 2. Missing native binaries — report how to build them. Building is left to
 *    `scripts/bootstrap.sh`; this script never compiles on its own, because a
 *    session start must stay fast and non-blocking.
 * 3. `bin/rg` PCRE2 — report when the pinned `rg` lacks `-P` support.
 *
 * Run: node scripts/sync-agent-bin.mjs [--check]
 * `--check` reports only, never writes.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the agent config dir. `PI_CODING_AGENT_DIR` overrides it (same key
 * the piextensions read), so nothing here is tied to one device or layout.
 * Never hardcode a home-relative segment: the override may point anywhere.
 */
export function resolveAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** Rc files checked, most-specific first. Covers zsh and bash on both OSes. */
export function shellRcCandidates(shell) {
  const portable = [".zshenv", ".zshrc", ".bashrc", ".profile"];
  if (shell === "zsh") return portable;
  if (shell === "bash") return [".bashrc", ".profile", ".zshenv", ".zshrc"];
  return portable;
}

/**
 * The block appended to an rc file. POSIX `case` — safe in zsh and bash alike.
 * `binDir` is interpolated unquoted: it sits inside a double-quoted shell word,
 * where single quotes would be literal characters and spaces do not word-split.
 * Only `$`, backtick, and `"` need escaping there.
 */
export function pathPinBlock(binDir) {
  const dir = shDoubleQuoted(binDir ?? "");
  return [
    "",
    `# pi agent bin: pinned native tools (rg+PCRE2, piread, piedit, pibash, pidx, fd)`,
    `case ":$PATH:" in`,
    `  *":${dir}:"*) ;;`,
    `  *) PATH="${dir}:$PATH"; export PATH ;;`,
    `esac`,
    "",
  ].join("\n");
}

/** Escape a value for safe interpolation inside a POSIX double-quoted word. */
export function shDoubleQuoted(value) {
  return String(value).replace(/[\\"$`]/g, (ch) => `\\${ch}`);
}

/** Every bin dir an rc pins onto PATH, in file order (first = highest
 * precedence). Pure text scan matching `pathPinBlock`'s two quote shapes — it
 * never asks a shell to interpret the rc, so no OS or shell is assumed. */
export function pinnedBinDirs(text) {
  if (typeof text !== "string") return [];
  const out = [];
  const re = /^\s*\*\).*?PATH=(?:"([^"]+?):\$PATH"|'([^']+?)':\$PATH)/gm;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2]);
  return out;
}

/** Pinned dirs that do not exist on disk. A dead entry still reorders PATH, so
 * it shadows a live pin lower down (`rg`/`piread` then resolve elsewhere).
 * Existence is the test — these are read, never written. */
export function missingPinnedDirs(text, exists) {
  return pinnedBinDirs(text).filter((dir) => !exists(dir));
}

/** True when `text` already pins `binDir` onto PATH. */
export function hasPathPin(text, binDir) {
  if (typeof text !== "string") return false;
  if (!binDir) return false;
  const dir = shDoubleQuoted(binDir);
  return (
    text.includes(`PATH="${dir}:`) ||
    text.includes(`PATH=${dir}:`) ||
    text.includes(`*":${dir}:"*`)
  );
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function which(cmd) {
  const r = spawnSync("sh", ["-c", `command -v ${cmd} 2>/dev/null`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

function hasPcre2(rgBin) {
  const r = spawnSync(rgBin, ["-P", "a(?=b)"], { input: "ab\n", encoding: "utf8" });
  return r.status === 0;
}

/**
 * Apply the sync. Returns a result object rather than printing, so the caller
 * (CLI or session-start hook) decides how to surface it.
 */
export function sync({
  check = false,
  shell = process.env.SHELL?.split("/").pop(),
  home = homedir(),
  agentDir = resolveAgentDir(),
} = {}) {
  const bin = join(agentDir, "bin");
  const changes = [];
  const problems = [];

  // 1. shell PATH pin. On a fresh machine the rc file may not exist yet —
  //    `.profile` is the portable choice (POSIX sh, read by login shells on
  //    both macOS and Linux). Create it rather than failing to pin.
  const rcName = shellRcCandidates(shell).find((f) => existsSync(join(home, f))) ?? ".profile";
  if (rcName) {
    const rcPath = join(home, rcName);
    const rcText = readOrEmpty(rcPath);
    // Dead pins from an older run (a deleted bench dir, a moved checkout) stay
    // in the rc and keep reordering PATH above the live entry. Report them —
    // never edit the user's rc in place beyond appending our own block.
    for (const dead of missingPinnedDirs(rcText, existsSync)) {
      problems.push({
        kind: "shell-path",
        detail: `~/${rcName} pins a missing dir (${dead}) — it shadows the live pin; remove that block`,
      });
    }
    if (hasPathPin(rcText, bin)) {
      changes.push({ kind: "shell-path", status: "ok", detail: `~/${rcName} already pins the bin dir` });
    } else if (check) {
      changes.push({ kind: "shell-path", status: "needed", detail: `~/${rcName} lacks the pin` });
    } else {
      try {
        appendFileSync(rcPath, pathPinBlock(bin), "utf8");
        changes.push({ kind: "shell-path", status: "fixed", detail: `pinned ~/${rcName}` });
      } catch (e) {
        problems.push({ kind: "shell-path", detail: `cannot write ~/${rcName}: ${e.message}` });
      }
    }
  } else {
    problems.push({ kind: "shell-path", detail: "no shell rc found (.zshenv/.zshrc/.bashrc/.profile)" });
  }

  // 2. native binaries present?
  for (const tool of ["piread", "piedit", "pibash", "pidx"]) {
    if (!existsSync(join(bin, tool))) {
      problems.push({ kind: tool, detail: `missing — build via scripts/bootstrap.sh` });
    }
  }

  // 3. pinned rg must support PCRE2
  const pinnedRg = join(bin, "rg");
  if (!existsSync(pinnedRg)) {
    problems.push({ kind: "rg-pcre2", detail: "bin/rg missing — cargo install ripgrep --features pcre2 --root ~/.pi/agent" });
  } else if (!hasPcre2(pinnedRg)) {
    problems.push({ kind: "rg-pcre2", detail: "bin/rg lacks PCRE2 — rebuild with --features pcre2" });
  } else {
    changes.push({ kind: "rg-pcre2", status: "ok", detail: "bin/rg supports -P" });
  }

  // 4. is the pin actually live in this process?
  const pathLive = (process.env.PATH ?? "").split(":").includes(bin);
  if (!pathLive) {
    changes.push({ kind: "path-live", status: "deferred", detail: "takes effect in a fresh shell" });
  }

  return { changes, problems, pathLive };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  const { changes, problems } = sync({ check });
  for (const c of changes) console.log(`== ${c.kind}: ${c.status} — ${c.detail}`);
  for (const p of problems) console.log(`!! ${p.kind}: ${p.detail}`);
  console.log(`sync-agent-bin: ${changes.length} checked, ${problems.length} problem(s)${check ? " (check only)" : ""}`);
  process.exit(0);
}
