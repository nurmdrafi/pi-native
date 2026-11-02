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
 * dedicated detached per-project session (`pi-agents-…`) created on demand
 * — the user can watch with `tmux attach -t <session name>` and the parent
 * terminal is never required to be inside tmux.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

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
 * Dedicated detached tmux sessions used when the parent pi runs OUTSIDE tmux.
 * One session per project root (see agentsSessionNameFor), created on demand;
 * watch yours with `tmux attach -t <session name>`.
 */
const AGENTS_TMUX_SESSION = "pi-agents";

/**
 * Per-project tmux session name: each project's subagent panes live in their
 * own detached session, so panes of different projects never share a
 * multiplexer session — reaping, killing, or attaching one project's session
 * can never touch another project's children. Stable for a given repo root:
 * basename slug plus a short hash of the full path (tmux session names must
 * avoid `:` and `.`).
 */
export function agentsSessionNameFor(repoRoot: string): string {
  const root = (repoRoot ?? "").trim();
  if (!root) return AGENTS_TMUX_SESSION;
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "root";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `pi-agents-${slug}-${hash}`;
}

/** Cached base pane id per dedicated agents session (outside-tmux mode). */
const agentsSessionBasePanes = new Map<string, string>();

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

/** Both places a tmux failure text can live: the exec error's stderr and
 *  the error message itself (tests and wrapped errors carry either). */
function tmuxErrorText(err: unknown): string {
  const stderr = typeof (err as { stderr?: unknown })?.stderr === "string" ? (err as { stderr: string }).stderr : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  return `${stderr}\n${message}`;
}

/** Error classes the surface layer can act on. Wordings are tmux's own and
 *  identical on macOS and Linux — only socket paths vary, so they are never
 *  parsed. `pane-gone`: the target object (pane/window/client/session) no
 *  longer exists — heal by re-deriving from live state. `server-gone`: the
 *  server is unreachable, dead, or version-mismatched — re-derive,
 *  recreating as needed. `size`: the window's geometry refuses the operation
 *  — grow the window and retry. `duplicate-race`: a parallel creator won
 *  the race — re-probe. */
export type TmuxErrorClass = "pane-gone" | "server-gone" | "size" | "duplicate-race" | "unknown";

const TMUX_ERROR_PATTERNS: Array<[TmuxErrorClass, RegExp]> = [
  ["pane-gone", /can't find (?:pane|window|client|session)|no such (?:pane|window|client|session)/i],
  ["server-gone", /no server running|error connecting to|server exited(?: unexpectedly)?|lost server|server version is too old for client|protocol version mismatch/i],
  ["size", /no space for (?:a )?new pane|create pane failed|pane too small|(?:size|change) is too big or too small|(?:size|change) too (?:small|big)(?: or too (?:big|small))?|adjustment too (?:small|large)/i],
  ["duplicate-race", /duplicate session/i],
];

/** Classify a tmux failure by tmux's own wording (stderr or message). */
export function classifyTmuxError(err: unknown): TmuxErrorClass {
  const text = tmuxErrorText(err);
  for (const [cls, re] of TMUX_ERROR_PATTERNS) {
    if (re.test(text)) return cls;
  }
  return "unknown";
}

/** Whether an error is tmux reporting the target pane does not exist — the
 *  one pane failure creation can self-heal from by re-targeting the split.
 *  A dead window or client takes the pane with it and heals the same way;
 *  session loss is excluded here because it means the whole dedicated
 *  session was reaped (still recoverable — see isMuxRecoverableError). */
export function isPaneNotFound(err: unknown): boolean {
  return /can't find (?:pane|window|client)|no such (?:pane|window|client)/i.test(tmuxErrorText(err));
}

/** Whether an error means the multiplexer layer itself is gone or racing —
 *  server killed or never started, the on-demand session reaped (`no such
 *  session` / `can't find session`), or two parallel first-spawns both
 *  creating that session (`duplicate session`). A missing or dead server is
 *  reported by tmux 3.4+ as `error connecting to <socket> (<reason>)` — the
 *  reason varies (`No such file or directory`, `Connection refused`) — and
 *  by older tmux as `no server running on <socket>`; both wordings are
 *  matched so the heal works across tmux generations. All are recoverable
 *  by re-deriving state from the live server (recreating it when needed)
 *  instead of failing every spawn until process restart. The matched
 *  strings are tmux's own and identical on macOS and Linux; only the socket
 *  path varies between machines, so it is matched by prefix and never
 *  parsed. */
export function isMuxRecoverableError(err: unknown): boolean {
  const cls = classifyTmuxError(err);
  return cls === "pane-gone" || cls === "server-gone" || cls === "duplicate-race";
}

/**
 * Ensure the dedicated agents session exists and return a pane id inside it
 * that new subagent panes can be split from. Detached by default so it never
 * steals the user's terminal; `tmux attach -t pi-agents` shows it on demand.
 */
function ensureAgentsSessionPane(sessionName: string = AGENTS_TMUX_SESSION): string {
  const cached = agentsSessionBasePanes.get(sessionName);
  if (cached) return cached;
  let exists = false;
  try {
    runTmux(["has-session", "-t", sessionName]);
    exists = true;
  } catch {}
  if (!exists) {
    try {
      runTmux(["new-session", "-d", "-s", sessionName, "-x", "220", "-y", "55"]);
      // No `-A` here: attach-if-exists on an existing session acts as a
      // detached attach and would detach a user watching it. The parallel
      // first-spawn race stays handled by the duplicate-session catch below
      // (and `duplicate-race` is classified recoverable upstack). Fixed
      // geometry: `window-size manual` keeps the dedicated session's panes
      // usable no matter what terminal later attaches (a client smaller than
      // the window must not shrink panes below sentinel width).
      runTmux(["set-option", "-w", "-t", sessionName, "window-size", "manual"]);
    } catch (err) {
      // Parallel first-spawn race: both saw no session, both create it; the
      // loser is told `duplicate session`. The winner's session now exists,
      // so re-probe before treating this as fatal — any other failure throws.
      if (!/duplicate session/i.test(err instanceof Error ? err.message : String(err ?? ""))) {
        throw err;
      }
      try {
        runTmux(["has-session", "-t", sessionName]);
      } catch {
        throw err;
      }
    }
  }
  const paneList = runTmux([
    "list-panes",
    "-t",
    sessionName,
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
    throw new Error(`No panes found in tmux session ${sessionName}`);
  }
  agentsSessionBasePanes.set(sessionName, pane);
  return pane;
}

/**
 * The pane new subagent panes are split from: the parent pi's pane when pi
 * runs inside tmux, otherwise a pane in the dedicated agents session.
 */
function splitOriginPane(sessionName: string = AGENTS_TMUX_SESSION): string {
  return process.env.TMUX_PANE ?? ensureAgentsSessionPane(sessionName);
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
  // outside tmux, balance any live dedicated agents session's window instead.
  const anyBase = agentsSessionBasePanes.values().next().value as string | undefined;
  const target = process.env.TMUX_PANE ?? anyBase ?? hintPane;
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

/** Window sizes the dedicated agents session may grow through. Splits
 *  refused for geometry (`no space for a new pane`) step up this ladder
 *  instead of failing the spawn. */
const AGENTS_WINDOW_SIZES: Array<[number, number]> = [
  [220, 55],
  [280, 70],
  [360, 90],
  [480, 120],
];

/** Grow the window containing `target` (a pane id) one step up the size
 *  ladder — the first step with BOTH dimensions strictly larger, so a
 *  manually enlarged window is never shrunk. `window-size manual` first so
 *  resize-window is honored even when a client is attached. No step larger
 *  in both dimensions means the window is already at or past capacity: fail
 *  with an explicit error naming the current size instead of tmux's bare
 *  refusal. A size that does not parse is never guessed: set `window-size
 *  manual` only and let the caller retry the split un-grown. */
function growAgentsWindow(target: string): void {
  const out = runTmux(["display-message", "-p", "-t", target, "#{window_width}x#{window_height}"]).trim();
  const m = out.match(/^(\d+)x(\d+)$/);
  if (!m) {
    runTmux(["set-option", "-w", "-t", target, "window-size", "manual"]);
    return;
  }
  const cur: [number, number] = [+m[1], +m[2]];
  const next = AGENTS_WINDOW_SIZES.find(([w, h]) => w > cur[0] && h > cur[1]);
  const max = AGENTS_WINDOW_SIZES[AGENTS_WINDOW_SIZES.length - 1];
  if (!next) {
    // Distinguish "top of our ladder" from "already larger than anything we
    // grow to" — the latter must not imply the ladder max is bigger.
    const beyond = cur[0] > max[0] || cur[1] > max[1];
    throw new Error(
      beyond
        ? `tmux pane capacity reached: the window is already ${out} — larger than the largest ` +
            `supported step (${max.join("x")}) and the split still needs more space. Reduce ` +
            `concurrent subagents or split fewer panes into this window.`
        : `tmux pane capacity reached: the window is ${out} and the split still needs more space ` +
            `(max supported ${max.join("x")}). Reduce concurrent subagents or enlarge the window.`,
    );
  }
  runTmux(["set-option", "-w", "-t", target, "window-size", "manual"]);
  runTmux(["resize-window", "-t", target, "-x", String(next[0]), "-y", String(next[1])]);
}

/** Oldest pane in `base`'s window that is not the base itself (tmux
 *  `pane_created` epoch seconds), or null when none exists — the eviction
 *  victim when capacity is reached. */
function oldestEvictablePane(base: string): string | null {
  try {
    const out = runTmux(["list-panes", "-t", base, "-F", "#{pane_id} #{pane_created}"]).trim();
    const panes = out
      .split("\n")
      .map((line) => line.trim().match(/^(%\d+) (\d+)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ id: m[1], created: Number(m[2]) }))
      .filter((p) => p.id !== base);
    if (!panes.length) return null;
    panes.sort((a, b) => a.created - b.created);
    return panes[0].id;
  } catch {
    return null;
  }
}

/** Whether `surface` lives in the same tmux window as the parent pi's pane
 *  — the user's own window, which must never be resized by the extension.
 *  Without a parent pane (pi outside tmux) no pane can share it; when window
 *  identity cannot be established, assume it does — never resize what cannot
 *  be identified. */
function paneSharesWindowWithParent(surface: string): boolean {
  const parent = process.env.TMUX_PANE;
  if (!parent) return false;
  try {
    const paneWindow = runTmux(["display-message", "-p", "-t", surface, "#{window_id}"]).trim();
    const parentWindow = runTmux(["display-message", "-p", "-t", parent, "#{window_id}"]).trim();
    return paneWindow !== "" && paneWindow === parentWindow;
  } catch {
    return true;
  }
}

/** Kill dead-but-remained panes in agents sessions (best-effort, called once
 *  per session start): a parent crash between child exit and pane close
 *  leaves "Pane is dead" rows behind. Only panes whose session name carries
 *  the agents prefix are touched — the user's own windows, including their
 *  own dead panes, are never modified. */
export function reapDeadAgentPanes(): void {
  try {
    const out = runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id} #{pane_dead} #{session_name}",
    ]).trim();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(%\d+) ([01]) (.+)$/);
      if (!m || m[2] !== "1" || !m[3].startsWith(AGENTS_TMUX_SESSION)) continue;
      try {
        runTmux(["kill-pane", "-t", m[1]]);
      } catch {}
    }
  } catch {}
}

/** Run one split-window against `fromSurface` (or the current window when
 *  absent) and return the new pane id. With `command` the pane is born running
 *  it — tmux takes the command as the LAST argv element, so no separate
 *  respawn has to race the pane's default shell. */
function splitPaneOnce(
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
  command?: string,
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
  if (command !== undefined) args.push(command);

  const pane = runTmux(args).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }
  try {
    // Keep a dead child's pane visible with its exit status: a spawn whose
    // command cannot start (missing binary, bad path) would otherwise vanish
    // and only surface as a bare "gone" — remain-on-exit lets the poll read
    // the real exit code ("Pane is dead", status 127 = command not found).
    runTmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
  } catch {
    // Older tmux without pane-scoped options: panes vanish on death as
    // before — the gone-tick path still covers them.
  }
  return pane;
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`). Dead from-panes self-heal once —
 * see splitWithHeal.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const pane = splitWithHeal(direction, fromSurface);

  rebalanceSurfaces(pane);
  return pane;
}

/** Split with the dead-origin heal shared by every pane-creation path: when
 *  the from-pane is dead — its window reaped, or a parent pane id gone stale
 *  after a reload — tmux answers `can't find pane` and every spawn would keep
 *  failing until process restart. Retry exactly once against a live pane of
 *  the dedicated agents session, re-derived from live tmux state (never the
 *  stale cache; the session is recreated on demand when the server is
 *  empty). Any other failure propagates unchanged. See isMuxRecoverableError
 *  for which failure classes heal. */
function splitWithHeal(
  direction: "left" | "right" | "up" | "down",
  fromSurface: string | undefined,
  command?: string,
  sessionName: string = AGENTS_TMUX_SESSION,
): string {
  try {
    return splitPaneOnce(direction, fromSurface, command);
  } catch (err) {
    if (classifyTmuxError(err) === "size") {
      // Geometry refused the split. Never resize the user's own window: a
      // size-refused split from the parent pi's pane moves to the dedicated
      // session and grows that instead; inside the dedicated session, grow
      // the window one step and retry the split once.
      if (fromSurface !== undefined && fromSurface === process.env.TMUX_PANE) {
        agentsSessionBasePanes.delete(sessionName);
        const base = ensureAgentsSessionPane(sessionName);
        try {
          growAgentsWindow(base);
        } catch (growErr) {
          if (!/pane capacity reached/.test(growErr instanceof Error ? growErr.message : "")) {
            throw growErr;
          }
          const victim = oldestEvictablePane(base);
          if (!victim) throw growErr;
          runTmux(["kill-pane", "-t", victim]);
        }
        return splitPaneOnce(direction, base, command);
      }
      const target = fromSurface ?? ensureAgentsSessionPane(sessionName);
      try {
        growAgentsWindow(target);
      } catch (growErr) {
        // Capacity: growth cannot help. Evict the oldest subagent pane in
        // the same window to make room — deliberate capacity policy; the
        // evicted child's watcher finalizes it as gone. The split base is
        // never the victim; with nothing left to evict, the capacity error
        // stands.
        if (!/pane capacity reached/.test(growErr instanceof Error ? growErr.message : "")) {
          throw growErr;
        }
        const victim = oldestEvictablePane(target);
        if (!victim) throw growErr;
        runTmux(["kill-pane", "-t", victim]);
      }
      return splitPaneOnce(direction, target, command);
    }
    if (!isMuxRecoverableError(err)) throw err;
    agentsSessionBasePanes.delete(sessionName);
    return splitPaneOnce(direction, ensureAgentsSessionPane(sessionName), command);
  }
}

/**
 * Create a subagent pane that is BORN running `paneCommand`: one atomic
 * split-window whose command is the last argv element. No default-shell
 * window ever exists, so the pane cannot die between creation and command
 * delivery the way a split-then-respawn sequence can.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceRunning(
  name: string,
  paneCommand: string,
  sessionName: string = AGENTS_TMUX_SESSION,
): string {
  void name; // tmux panes are not named; the pi process inside shows its own title.
  requireTmux();

  const pane = splitWithHeal("right", splitOriginPane(sessionName), paneCommand, sessionName);

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
  const respawnArgs = [
    "respawn-pane",
    "-k",
    "-t",
    surface,
    `bash ${shellEscape(scriptPath)}; exec "\${SHELL:-/bin/sh}"`,
  ];
  try {
    runTmux(respawnArgs);
  } catch (err) {
    // A pane too narrow/short for the respawn (`pane too small`) is a
    // geometry refusal, not a delivery failure — but never grow the user's
    // own window: when the parent pi runs inside tmux the pane lives in the
    // user's window, and resizing it is exactly what the split heal forbids.
    // Grow-and-retry only for panes in the dedicated session.
    if (classifyTmuxError(err) !== "size") throw err;
    if (paneSharesWindowWithParent(surface)) {
      throw new Error("pane too small for script delivery — enlarge the terminal window hosting pi");
    }
    growAgentsWindow(surface);
    runTmux(respawnArgs);
  }
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
  try {
    runTmux(["kill-pane", "-t", surface]);
  } catch (err) {
    // Idempotent close: the pane already reaped (or its window/session
    // gone) is the success state kill-pane aims at, not a failure.
    if (classifyTmuxError(err) !== "pane-gone") throw err;
  }
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

/** Exit status of a dead-but-remained pane (`remain-on-exit on`), or null
 *  when tmux cannot answer. `list-panes -t <pane>` lists the pane's whole
 *  window, so the pane's own line is matched by id. */
async function queryPaneDeadState(
  surface: string,
): Promise<{ dead: boolean; status?: number } | null> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "list-panes",
      "-t",
      surface,
      "-F",
      "#{pane_id} #{pane_dead} #{pane_dead_status}",
    ]);
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.startsWith(`${surface} `));
    const m = line?.match(/^%\d+ ([01])(?: (-?\d+))?$/);
    if (!m) return null;
    return { dead: m[1] === "1", status: m[2] !== undefined ? Number(m[2]) : undefined };
  } catch {
    return null;
  }
}

/** Test hooks for the pane-creation paths: substitute the tmux binary and
 *  reset the state a fake run leaves behind (base-pane cache, availability
 *  cache, pending layout rebalance). */
export const __surfaceTest__ = {
  setTmuxRunner(fn: ((args: string[]) => string) | null): void {
    tmuxRunner = fn;
    agentsSessionBasePanes.clear();
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
    /** wait-for channel the child signals on completion: between ticks the
     *  poll parks on `tmux wait-for <channel>`, so wake is push-driven
     *  instead of bound to the interval. Absent → plain interval ticking. */
    waitChannel?: string;
    /** Screen reader / wait-for runner seams (defaults: readScreenAsync and
     *  the real tmux binary). */
    deps?: {
      readScreen?: (surface: string, lines?: number) => Promise<string> | string;
      waitTmux?: (args: string[]) => Promise<unknown>;
      paneDeadState?: (surface: string) => Promise<{ dead: boolean; status?: number } | null>;
    };
  },
): Promise<PollResult> {
  const start = Date.now();
  let goneTicks = 0;
  const readScreen = options.deps?.readScreen ?? readScreenAsync;
  const paneDeadState = options.deps?.paneDeadState ?? queryPaneDeadState;
  // One wait-for may be outstanding for the whole poll, reused across ticks.
  // A fresh wait-for per tick leaks a blocked tmux subprocess every time the
  // interval timer wins the race, and each `-S` wakes exactly one waiter, so
  // abandoned waiters also steal the signal from the live poll.
  const waitAbort = new AbortController();
  const waitTmux =
    options.deps?.waitTmux ??
    ((args: string[]) => execFileAsync("tmux", args, { signal: waitAbort.signal }));
  // A wait-for that failed once (server down, bad channel) will keep failing:
  // stop racing it and let the interval timer govern the rest of the poll.
  let waitUsable = options.waitChannel !== undefined;
  let waitPromise: Promise<unknown> | null = null;
  const onOuterAbort = () => waitAbort.abort();
  signal.addEventListener("abort", onOuterAbort, { once: true });

  try {
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
      const screen = await readScreen(surface, 5);
      // The real echo prints the marker alone on its own line; a task text
      // that merely mentions the marker is not completion — anchor the match
      // to a whole line or a live pane gets reaped on a false positive.
      const match = screen.match(/^__SUBAGENT_DONE_(\d+)__[ \t\r]*$/m);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
      if (/Pane is dead/.test(screen)) {
        // The pane's process exited and remained (remain-on-exit on): read
        // the true exit status instead of polling a corpse forever. Exit 127
        // means the child command could not start at all (not in PATH).
        const dead = await paneDeadState(surface);
        if (dead?.dead) {
          return {
            reason: "gone",
            exitCode: dead.status ?? -1,
            errorMessage:
              dead.status === 127
                ? "child process not found (exit 127) — the pane command could not start"
                : undefined,
          };
        }
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

    // Sleep until the next tick: the interval timer raced against the ONE
    // persistent wait-for. Whichever fires first wakes the poll; a resolved
    // wait-for is consumed (the next sleep starts a fresh one), and a rejected
    // one marks wait-for unusable for the rest of the poll.
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
      if (waitUsable && options.waitChannel && !waitPromise) {
        waitPromise = waitTmux(["wait-for", options.waitChannel]);
      }
      if (waitPromise) {
        waitPromise.then(
          () => {
            waitPromise = null; // consumed — next sleep issues a fresh one
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          () => {
            waitPromise = null;
            waitUsable = false;
          },
        );
      }
    });
  }
  } finally {
    // Kill any outstanding wait-for subprocess and drop the abort listener —
    // abandoned blocked processes would otherwise outlive the poll forever.
    waitAbort.abort();
    signal.removeEventListener("abort", onOuterAbort);
  }
}
