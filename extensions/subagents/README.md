# Subagents extension

Interactive tmux-backed subagents for pi: the `subagent` (spawn),
`subagent_message` (steer/resume), and `subagents_list` tools plus the
`/subagents` command. Vendored from
`amosblomqvist/pi-interactive-subagents@c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`
with local patches folded in.

## Requirements

- **tmux ≥ 3.0** on `PATH`, working headless — subagents spawn panes via
  `tmux new-session`, no terminal needed. Verify in one line (prints
  `tmux OK` on macOS and Linux alike):

      tmux -V && tmux new-session -d -s pi-probe && tmux kill-session -t pi-probe && echo tmux OK

  Install: `brew install tmux` (macOS); `sudo apt install tmux`,
  `sudo dnf install tmux`, or `sudo pacman -S tmux` (Linux). Windows is not
  supported for subagents.
  **PATH-shadowing gotcha:** an AppImage `tmux` earlier on `PATH`
  (e.g. `~/.local/bin/tmux`) shadows the package-manager binary and fails
  where FUSE is unavailable (containers, no `/dev/fuse`) —
  `fusermount: mount failed` → every subagent spawn dies at pane creation.
  Diagnose with `command -v tmux`; if it resolves to an AppImage, rename it
  aside (keep it for FUSE-capable machines) or extract it with
  `--appimage-extract`. Prefer the distro/brew build in restricted
  environments.
- The parent pi does **not** need to run inside tmux:
  - parent inside tmux → subagent panes split next to the parent pane;
  - parent outside tmux (plain terminal, or headless `pi -p`) → panes live in
    a dedicated detached session. Attach with `tmux attach -t pi-agents`,
    detach with `Ctrl+b d`.

## Activation

Spawning tools are registered but gated (zero prompt tokens) until a trigger:
`PI_SUBAGENTS=1` at process start, `/subagents on`, or any
`/subagents <agent> [task]` spawn. Subagent sessions always register active.

## Concurrency

Parallel spawns share one provider quota; several simultaneous children
429-storm it and every run slows to retry backoff. Spawns are therefore
capped: extra ones queue FIFO and launch as slots free. `PI_SUBAGENT_MAX_CONCURRENT`
sets the cap (default 3; values < 1 mean unlimited). A slot is held from launch
until the child's watcher settles.

## Detached subagents

When a parent session ends while children still run, their watchers abort and
nothing can be delivered to the dying session. Each orphan is persisted as a
`subagent-pending/<id>.json` sidecar under the parent session's artifacts dir
(name, session file, surface, timestamps); the next session in the same project
surfaces them at start. The child keeps running in its tmux pane — its result
lands in its session file, recoverable via `subagent_message`. That session
also adopts the orphans: live panes are re-watched and their results
delivered; dead ones finalize as `pane_lost`.

## How a spawn works

1. A tmux pane is split off (parent pane, or the `pi-agents` detached session).
2. A launch script is written to
   `<session-artifacts>/subagent-scripts/<name>-<id>.sh` — the full child
   `pi` invocation (session file, extensions, tool allowlist, env identity).
3. The pane's shell is **replaced** with that script via
   `tmux respawn-pane -k` (`… ; exec "$SHELL"` keeps the pane and its
   scrollback alive afterwards). No keystrokes are typed into the pane.
4. The script ends by echoing a `__SUBAGENT_DONE_<rc>__` sentinel; a watcher
   in the parent polls for it (or a `.exit` sidecar on error) and delivers the
   child's final assistant message back to the parent as a steer message.

## Steering and resume

`subagent_message({ name, message })` steers a running child — delivered at
its next turn boundary — or, by the same name, resumes a finished session.
Resume replays the sandbox snapshot recorded at spawn (tools, model, identity,
nested-spawn allowlist); it is refused without the snapshot rather than
relaunching unrestricted, and a name still running is steered instead of
resumed (two processes on one session file would corrupt it). Both paths are
fire-and-forget: the result arrives later as a steer message. Resumed and
auto-restarted runs are not re-budgeted.

## Pane recovery

Any pane touch can fail with tmux `can't find pane` — a reaped window, an
externally killed pane, a stale cached pane id. Each lifecycle step self-heals:

- **split origin** — a `split-window` whose from-pane is dead resets the cached
  agents-session pane id and re-splits once from a live pane (`tmux.ts`
  `createSurfaceSplit`);
- **delivery** — spawn and resume deliver the launch script by replacing the
  pane process; on pane loss one replacement surface is created and the script
  redelivered exactly once; a second loss fails the call with retry guidance
  (`index.ts` `deliverLaunchScript`);
- **steer** — a message that hits a lost pane waits up to 5 s (200 ms steps)
  for the watcher to restart the child or finalize the entry, then delivers to
  the replacement pane; otherwise it errors, and a resend resolves to resume
  (`index.ts` `steerSubagent`);
- **watch** — on pane loss the watcher attempts exactly one automatic restart:
  a fresh pane resumes the durable session file with the spawn-time sandbox
  snapshot replayed (pi-CLI auto-exit children only, never after a budget
  breach). A refused or failed restart synthesizes a `pane_lost` result from
  the session file; a confirmed budget breach reports `budget_exceeded`
  instead (`index.ts` `watchSubagent`, `restartLostPane`).

## Headless / print-mode parents (2026-10 fixes)

A `pi -p` parent exits as soon as its turn ends. Children are independent
tmux processes, so they **detach and keep running** — the watcher is torn
down without killing the pane. The result is not steered anywhere (the parent
is gone); recover it from the child's session file:

- `<parent-artifacts>/subagent-registry.json` maps each subagent name to its
  session file; the result is the last assistant message in that file.
- A resumed parent (`pi --session <parent-file> "…"`) can read it, or steer it
  in manually between markers.

History — four defects fixed 2026-10-10, all reproducing only outside the
TUI:

| symptom | root cause | fix |
| --- | --- | --- |
| child never launched; pane showed the command typed but not executed | command was typed into the pane's shell ~500 ms after split; shells with slow init (oh-my-zsh/powerlevel10k/nvm can take seconds) swallow the Enter key sent mid-init | deliver via `respawn-pane -k` instead of keystrokes (`tmux.ts` `sendLongCommand`) |
| `split-window could not find pane %0` when another pane was already alive | `list-panes -f '#M'` matches every pane on tmux 3.5a, so a multi-line "pane id" was cached and used as a split target | list panes unfiltered, take the first line matching `^%\d+$` (`tmux.ts` `ensureAgentsSessionPane`) |
| headless parent crashed (rc=1, stale-ctx stack) after a child died | `updateWidget()` touched a replaced session's ctx from a `.then`/`.catch` continuation → unhandled rejection | widget updates wrapped in try/catch — cosmetic UI must never crash the host (`index.ts`) |
| children died mid-turn when the headless parent exited | watcher abort on `session_shutdown` killed the pane | abort now only stops watching; the pane is left running (`index.ts` `watchSubagent`) |

`PI_SUBAGENT_SHELL_READY_DELAY_MS` (default 500) is now legacy: it throttled
the pre-typing delay and is unnecessary for `respawn-pane` delivery.

## Triage

| observation | meaning |
| --- | --- |
| model says it has no `subagent` tool | tools gated — `PI_SUBAGENTS=1`, `/subagents on`, or a `/subagents <agent> <task>` spawn |
| `Install tmux (…)` result | tmux binary missing |
| spawn fails, `can't find pane` | rare — split and delivery self-heal (see Pane recovery); persistent failures mean stale `pi-agents` state — `tmux kill-session -t pi-agents` and retry |
| child result missing after a headless run | expected on parent exit — see recovery above; the child kept running in `pi-agents` |

## Tests

```sh
npm run test:subagents                      # unit, mocked tmux
node tests/subagents/system-prompt-mode.test.ts
npm run typecheck
```

Integration (real pi + real model inside tmux):
`tests/subagents/integration/` — model/timeout knobs (defined in the harness
there); the harness injects `PI_SUBAGENTS=1`.
