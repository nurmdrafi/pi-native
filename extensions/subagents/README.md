# Subagents extension

Interactive tmux-backed subagents for pi: the `subagent` (spawn),
`subagent_message` (steer/resume), and `subagents_list` tools plus the
`/subagents` command. Vendored from
`amosblomqvist/pi-interactive-subagents@c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`
with local patches folded in.

## Requirements

- **tmux ≥ 3.0** — `brew install tmux` (macOS) or `sudo apt install tmux`
  (Linux). Windows is not supported for subagents.
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
lands in its session file, recoverable via `subagent_message`.

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

## Headless / print-mode parents (2026-10 fixes)

A `pi -p` parent exits as soon as its turn ends. Children are independent
tmux processes, so they **detach and keep running** — the watcher is torn
down without killing the pane. The result is not steered anywhere (the parent
is gone); recover it from the child's session file:

- `<parent-artifacts>/subagent-registry.json` maps each subagent name to its
  session file; the result is the last assistant message in that file.
- A resumed parent (`pi --session <parent-file> "…"`) can read it, or steer it
  in manually between markers.

History — three defects fixed 2026-10-10, all reproducing only outside the
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
| spawn fails, `can't find pane` | stale `pi-agents` state — `tmux kill-session -t pi-agents` and retry |
| child result missing after a headless run | expected on parent exit — see recovery above; the child kept running in `pi-agents` |

## Tests

```sh
node --test tests/subagents/test.ts          # unit, mocked tmux
node tests/subagents/system-prompt-mode.test.ts
npm run typecheck
```

Integration (real pi + real model inside tmux):
`tests/subagents/integration/` — model/timeout knobs (defined in the harness
there); the harness injects `PI_SUBAGENTS=1`.
