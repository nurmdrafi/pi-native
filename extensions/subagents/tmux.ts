/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). When the parent pi
 * runs inside tmux, splits target the parent pi's pane (`$TMUX_PANE`) so they
 * follow the agent. When the parent runs outside tmux, panes are created in a
 * dedicated detached session (`pi-agents`) that is created on demand — the
 * user can watch with `tmux attach -t pi-agents` and the parent terminal is
 * never required to be inside tmux.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * Dedicated detached tmux session used when the parent pi runs OUTSIDE tmux.
 * Created on demand; watch with `tmux attach -t pi-agents`.
 */
const AGENTS_TMUX_SESSION = "pi-agents";

/** Cached base pane id of the dedicated agents session (outside-tmux mode). */
let agentsSessionBasePane: string | null = null;

/**
 * True when the tmux binary is available. The parent pi does NOT need to be
 * running inside tmux — when it isn't, panes go to a dedicated detached
 * session created on demand (see ensureAgentsSessionPane).
 */
export function isTmuxAvailable(): boolean {
  return hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Install tmux (brew install tmux / sudo apt install tmux). Subagents run in a detached session; watch with `tmux attach -t pi-agents`.";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Process seam ──

/** Fake tmux binary for unit tests (null = run the real process). */
let tmuxRunner: ((args: string[]) => string) | null = null;

/** Run one synchronous tmux command and return its stdout. All pane-creation
 *  paths go through here so tests can substitute the multiplexer. */
function runTmux(args: string[]): string {
  if (tmuxRunner) return tmuxRunner(args);
  return execFileSync("tmux", args, { encoding: "utf8" });
}

/** Whether an error is tmux reporting the target pane does not exist — the
 *  one pane failure creation can self-heal from by re-targeting the split. */
function isPaneNotFound(err: unknown): boolean {
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string" ? (err as { stderr: string }).stderr : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /can't find pane/i.test(stderr) || /can't find pane/i.test(message);
}

/**
 * Ensure the dedicated agents session exists and return a pane id inside it
 * that new subagent panes can be split from. Detached by default so it never
 * steals the user's terminal; `tmux attach -t pi-agents` shows it on demand.
 */
function ensureAgentsSessionPane(): string {
  if (agentsSessionBasePane) return agentsSessionBasePane;
  let exists = false;
  try {
    runTmux(["has-session", "-t", AGENTS_TMUX_SESSION]);
    exists = true;
  } catch {}
  if (!exists) {
    runTmux(["new-session", "-d", "-s", AGENTS_TMUX_SESSION, "-x", "200", "-y", "50"]);
  }
  const paneList = runTmux([
    "list-panes",
    "-t",
    AGENTS_TMUX_SESSION,
    "-F",
    "#{pane_id}",
  ]);
  // First valid pane id line. Deliberately no `-f` filter: filter tokens like
  // `#M` are not uniform across tmux versions (on 3.5a `#M` matches EVERY
  // pane), so a filtered list once returned multiple lines that passed the
  // old startsWith("%") check, cached a multi-line "pane id", and broke every
  // subsequent split-window with `can't find pane: %0`.
  const pane = paneList
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^%\d+$/.test(line));
  if (!pane) {
    throw new Error(`No panes found in tmux session ${AGENTS_TMUX_SESSION}`);
  }
  agentsSessionBasePane = pane;
  return pane;
}

/**
 * The pane new subagent panes are split from: the parent pi's pane when pi
 * runs inside tmux, otherwise a pane in the dedicated agents session.
 */
function splitOriginPane(): string {
  return process.env.TMUX_PANE ?? ensureAgentsSessionPane();
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane);
  // outside tmux, balance the dedicated agents session's window instead.
  const target = process.env.TMUX_PANE ?? agentsSessionBasePane ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 * See https://github.com/HazAT/pi-interactive-subagents/issues/12
 *
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurface(name: string): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", splitOriginPane());
}

/** Run one split-window against `fromSurface` (or the current window when
 *  absent) and return the new pane id. */
function splitPaneOnce(
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = runTmux(args).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 *
 * Self-heal: when the from-pane is dead — its window reaped, or a parent pane
 * id gone stale after a reload — tmux answers `can't find pane` and every
 * spawn would keep failing until process restart. Retry exactly once against
 * a live pane of the dedicated agents session, re-derived from live tmux
 * state (never the stale cache). Any other failure propagates unchanged.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  let pane: string;
  try {
    pane = splitPaneOnce(direction, fromSurface);
  } catch (err) {
    if (!fromSurface || !isPaneNotFound(err)) throw err;
    agentsSessionBasePane = null;
    pane = splitPaneOnce(direction, ensureAgentsSessionPane());
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  // Deliver by replacing the pane process with the script — NOT by typing into
  // the pane's shell. Keystrokes sent before the shell finishes initializing
  // (oh-my-zsh/powerlevel10k/nvm can take seconds) are unreliable: the command
  // text renders once the line editor comes up, but an Enter sent mid-init is
  // swallowed and the command never executes (children "died pre-turn" in
  // headless runs). respawn-pane needs no ready shell and no keypress.
  // The trailing interactive shell keeps the pane — and its scrollback, where
  // the completion sentinel echo lives — alive after the script exits, matching
  // the old typed-in-a-shell behavior; the watcher closes the pane on
  // completion. SHELL falls back to /bin/sh for portability.
  execFileSync(
    "tmux",
    [
      "respawn-pane",
      "-k",
      "-t",
      surface,
      `bash ${shellEscape(scriptPath)}; exec "\${SHELL:-/bin/sh}"`,
    ],
    { encoding: "utf8" },
  );
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

/**
 * Send an interrupt (Ctrl-C) to a pane without typing into it — used by the
 * budget stop path to ask a runaway child to exit cleanly before kill-pane.
 */
export function sendInterrupt(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "C-c"], { encoding: "utf8" });
}

// ── Exit polling ──

/** Whether the pane still exists: "alive", "gone" (tmux ran and reports no
 * such pane — terminal, ids are never resurrected), or "unknown" (tmux
 * itself unreachable — must not be treated as pane death). */
export async function surfaceAlive(
  surface: string,
): Promise<"alive" | "gone" | "unknown"> {
  try {
    await execFileAsync("tmux", ["list-panes", "-t", surface, "-F", "#{pane_id}"]);
    return "alive";
  } catch (err) {
    // Exit code 1 = tmux ran and could not find the pane.
    if ((err as { code?: number | string })?.code === 1) return "gone";
    return "unknown";
  }
}

/** All live pane ids across every tmux session ("%N"), or null when tmux
 * itself is unreachable (an outage is not a reap). */
export async function listLiveSurfaces(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
    return new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return null;
  }
}

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "gone";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/** Test hooks for the pane-creation paths: substitute the tmux binary and
 *  reset the state a fake run leaves behind (base-pane cache, availability
 *  cache, pending layout rebalance). */
export const __surfaceTest__ = {
  setTmuxRunner(fn: ((args: string[]) => string) | null): void {
    tmuxRunner = fn;
    agentsSessionBasePane = null;
    if (fn) commandAvailability.set("tmux", true);
    else commandAvailability.delete("tmux");
    if (rebalanceTimer) {
      clearTimeout(rebalanceTimer);
      rebalanceTimer = null;
    }
  },
  isPaneNotFound,
};

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();
  let goneTicks = 0;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
      goneTicks = 0;
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
      // Pane destroyed with no exit record (group reap, external kill-pane,
      // or the budget stopper's kill racing this poll): the pane is not coming
      // back — report it instead of spinning forever on unreadable screens.
      goneTicks = (await surfaceAlive(surface)) === "gone" ? goneTicks + 1 : 0;
      if (goneTicks >= 2) {
        return { reason: "gone", exitCode: -1 };
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
