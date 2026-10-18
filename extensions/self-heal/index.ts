/**
 * self-heal — keep the harness usable after a pull, a pi update, or on startup.
 *
 * Runs the portable `scripts/sync-agent-bin.mjs` on `session_start` so a fresh
 * machine, a pi upgrade, or a pulled change cannot leave the shell PATH pin or
 * the pinned PCRE2 `rg` stale. The script is idempotent and does no compiling,
 * so this stays fast; anything it cannot fix is reported, never thrown, so a
 * broken environment never blocks a session from starting.
 *
 * OS-agnostic: the script resolves rc files (.zshenv/.zshrc/.bashrc/.profile),
 * honours `PI_CODING_AGENT_DIR`, and writes a POSIX `case` block, so macOS and
 * Linux behave the same. No path here is hardcoded to one device.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { daemonKillPattern, generationChanged, scanBinGeneration } from "./bins.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SYNC = join(ROOT, "scripts", "sync-agent-bin.mjs");
const STAMP = join(ROOT, ".cache", "pi-version");
const BIN_GEN_STAMP = join(ROOT, ".cache", "bins-generation");

/**
 * Run the portable sync. Returns its stdout, or null when it could not run.
 * Never throws: a broken environment must not block a session from starting.
 */
function runSync(): string | null {
  try {
    const r = spawnSync(process.execPath, [SYNC], { encoding: "utf8", timeout: 10_000 });
    if (r.error || r.status !== 0) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

/**
 * The running pi version, read from the installed package so nothing depends on
 * an env var pi does not set. Returns "unknown" when it cannot be resolved.
 */
function piVersion(): string {
  try {
    const pkg = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/package.json"));
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Record the running pi version. Returns the previous version when it differs
 * from the current one, so the caller can flag "pi was updated".
 */
function noteVersion(current: string): string | null {
  let previous: string | null = null;
  try {
    previous = readFileSync(STAMP, "utf8").trim().split("\n")[1] ?? null;
  } catch {}
  try {
    writeFileSync(STAMP, `${Math.floor(Date.now() / 1000)}\n${current}\n`, "utf8");
  } catch {}
  return previous && previous !== current ? previous : null;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // A version change (a pi update) can invalidate native binaries.
    const current = piVersion();
    const changedFrom = noteVersion(current);
    // Kill daemons started from binaries that changed since the last
    // session: clients would otherwise keep talking to pre-rebuild
    // daemons and fall back to one-shot spawns on every call.
    try {
      const stamp = readFileSync(BIN_GEN_STAMP, "utf8").trim();
      const previous = stamp === "" ? null : parseInt(stamp, 10);
      const current = scanBinGeneration(join(ROOT, "bin"));
      if (generationChanged(Number.isNaN(previous) ? null : previous, current)) {
        spawnSync("pkill", ["-f", daemonKillPattern(join(ROOT, "bin"))], { stdio: "ignore" });
      }
      writeFileSync(BIN_GEN_STAMP, `${current}\n`, "utf8");
    } catch {}

    const out = runSync();

    if (changedFrom) {
      ctx.ui.setStatus?.("self-heal", `pi ${changedFrom} -> ${current}: run scripts/bootstrap.sh`);
      return;
    }
    if (!out) return;
    // Only surface problems; a healthy machine stays quiet.
    const problems = out.split("\n").filter((l) => l.startsWith("!!"));
    if (problems.length > 0) {
      ctx.ui.setStatus?.("self-heal", `${problems.length} setup issue(s) -- see /doctor`);
    }
  });
}

// Test seam: the pure pieces are exported for the unit tests.
export { noteVersion, piVersion };
