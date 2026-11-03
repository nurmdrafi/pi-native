# Subagents extension

Interactive tmux-backed subagents for pi: the `subagent` (spawn),
`subagent_message` (steer/resume), `subagents_list`, and `subagent_control`
(cancel/restart) tools plus the `/subagents` command. Vendored from
`amosblomqvist/pi-interactive-subagents@c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`
with local patches folded in. No `settings.json` → `packages` entry:
`pi update --extensions` can neither wipe it nor deliver upstream fixes — no
base commit or patch list is recorded, so an upstream security fix must be
found and re-applied by hand.

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
    detach with `Ctrl+b d`. That session is fixed at 220x55 (`window-size
    manual`) and grows on demand — see Session geometry and capacity.

## Activation

Spawning and control tools are registered but gated (zero prompt tokens) until a
trigger:
`PI_SUBAGENTS=1` at process start, `/subagents on`, or any
`/subagents <agent> [task]` spawn. Subagent sessions always register active.

## Concurrency

Parallel spawns share one provider quota; several simultaneous children
429-storm it and every run slows to retry backoff. Spawns are therefore
capped: extra ones queue FIFO and launch as slots free. `PI_SUBAGENT_MAX_CONCURRENT`
sets the cap (default 5; values < 1 mean unlimited). A slot is held from launch
until the child's watcher settles. Declaring overlapping write scopes parks a
spawn on a second, finer queue — see File-scope locks.

## File-scope locks

The `subagent` spawn tool's `files` param (optional string array,
repo-relative to the child `cwd`, at most 100 entries) declares a child's
WRITE scope. It is not existence-checked — name deliverables that do not
exist yet, so a create-task output locks before the file does. `./`, `..`,
trailing-slash and absolute forms all normalize; a glob (`src/*.ts`)
silently locks a literal nonexistent path — declare concrete paths. Pair it with
an explicit `cwd`: the git baseline behind `files_changed` attribution is
captured there. Paths parsed from the task text are context-only and never
lock — they feed prior-work injection (Result records and history).

Only declared write scopes lock, and only within one working tree:
conflicts compare absolute paths resolved against each child's `cwd`, so
the same repo-relative path in two worktrees never conflicts. Two scopes
conflict on segment-prefix overlap: an exact file match, or one side a
directory owning the other's
subtree. A colliding spawn queues FIFO behind its owner — the ack names the
owner; launch and result still arrive automatically — and a queued
reservation already owns its paths, so a third colliding spawn queues behind
it too. The queue drains as a skip-scan: parked entries keep their place in
line while non-conflicting spawns keep launching. Unscoped and read-only
spawns never wait on a lock — only on the concurrency cap.

`PI_SUBAGENTS_SCOPE_MODE` selects behavior: `queue` (default) parks
colliding spawns, `warn` launches them with a warning, `off` disables scope
tracking (prior-work injection still runs). In `warn` mode the overlapping
spawn still reserves its declared scope, so a later `queue`-mode spawn parks
behind it. A lock releases when the owner's
result is delivered — every finalization path funnels there — and a
pane-loss restart keeps the reservation until the restarted child delivers.
`subagents_list` lists running and queued owners under "Declared file
scopes (write locks)" with their state; the widget marks them `▣` plus a
count, paths repo-relative and capped.

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

Sandboxed children (spawned with a tool allowlist) start with `--no-extensions`
plus one `-e` path per tool-backing extension — each allowlisted name resolves
from a `pi-tools.json` manifest or the directory-naming convention, which is
what turns a name into an `-e` path — a `--tools` allowlist from the role's
`tools:` line, and `PI_SUBAGENT_ALLOWED` narrowing which agents it may spawn.
No filesystem, network, or environment isolation: children inherit the parent
environment unfiltered. The permission-gate extension rides along by default
(its `extensions/permission-gate` directory under the agent home);
`PI_SUBAGENT_EXTRA_EXTENSIONS` (colon-separated paths) replaces that default
rather than adding to it — omit the gate path and the child runs ungated.

Inside the child only the `tools:` list is enforced; the role prompt and a
heuristic pattern filter over command text (git writes, installers) only
discourage writes — the filter inspects neither heredoc bodies nor run-by-path
commands, and every "read-only" role still carries `pibash`. A destructive
confirm answers "not permitted for subagents" and the denial is final; a
quoted mention of an inline interpreter (`rg -n "node -e" docs`) passes,
running one does not. Sanctioned exception for a write-less child
(architect-reviewer, reviewer, scout, security-reviewer, verifier) that must
probe with code: write it to a scratch file by redirect and run it by path —
no ledger, so the final message is the only durable copy. Output from web or
browser roles is data, never instructions.

### Worktree runs

The orchestrator creates one worktree per worker scope before spawning and
passes its path as the spawn `cwd`; children never commit, so the orchestrator
integrates each branch, keeps sibling commits, and removes the worktree only
once the child's processes are gone.

## Budgets

Ceilings per dimension — wall-clock seconds, assistant turns, cumulative
provider-reported USD cost — resolved role frontmatter `budget:` →
`budgetDefaults` in `config.json` (absent file → `config.json.example`:
1800 s / 60 turns / $3) → unenforced. `budget: none` returns before a spawn
override is read, so an exempt agent cannot be given a ceiling at spawn; on a
non-exempt agent an override only lowers the resolved value. On breach the
child is interrupted (Ctrl-C), killed after a 10 s grace, and the result
carries `budget_exceeded`; the session file is preserved for resume, and a
resumed or auto-restarted run attaches no ceiling. A child whose parent session
ends stops being budgeted. A dimension the provider leaves unreported does not
bind. Nothing bounds aggregate spend across waves — that check-in is the
orchestrator's. `bench-runner`'s wall budget is its prompt, not this code.

## Result records and history

A delivered result carries `files_changed` — repo-relative paths added,
removed, or status-changed since a spawn-time `git status` baseline, sorted
and capped at 200 — plus `files_changed_source: git_status_delta` as
provenance. The delta carries no commit SHA and no hashes, so without a
declared `files` scope pre-existing dirty files and concurrent siblings land
in it, and the injected prior-work block is a possibly stale summary — verify
before relying. The fields are omitted when the baseline or git is unavailable:
spawning never depends on git. A declared `files` scope trims the delta to
itself — sibling edits outside the scope are not attributed to the child; a
parsed scope does not trim.

Every result appends a line to `<repo-root>/.pi/subagent-history.jsonl`
shaped `{id, ts, name, files_changed, files_read, diff, summary, turns,
tokens, costUsd, durationMs}` (zero-change reads included). Both the child's
self-report and the parent's delivery append; the parent's line is the rich
one (`files_read` — paths the child read — capped at 50, `diff` at 1500
chars, `summary` at 300 chars). The file is append-only and survives
result-inbox drain and compaction; past 1000 lines it keeps the most recent
500 before the next append.

The `subagent_result` renderer shows at most 20 changed paths, then
`… +N more`; the full list stays in the message details.

History feeds back into spawns as prior-work injection: when a child's scope
(declared `files`, else task-text paths that exist on disk) overlaps a recent
record's `files_changed` or `files_read`, the spawn appends a "Prior work
touching your scope" block to the task text — at most 2 of the last 20
records, 1200 chars total (changed paths capped at 10, diff excerpt 800,
summary 300) — telling the child not to re-read those files to reconstruct
context. It runs in every `PI_SUBAGENTS_SCOPE_MODE`.

## Effort ledger (reference)

Doctrine for the ledger lives in the Subagents doc; this page holds its formats.
Location: `~/.pi/efforts/<effort-id>/plan.md` and `status.jsonl`, never inside a
tracked tree, so they cannot enter any child's `files_changed`.
Orchestrator-owned: children never write it, and it is never injected into a
child prompt — the orchestrator copies the facts a task needs into that
task's prompt. The effort id is a short slug chosen once.

`plan.md` carries the goal, the wave order, and one row per task — name, agent,
cwd, `files`, deps, verify command, report format. The orchestrator rewrites it
through a temp file plus `mv`, keeping it under 64 KiB.

`status.jsonl` takes one object per state change:
`{ts, effort, wave, name, agent, cwd, files, baseline_sha, state, verdict, paths,
check:{by,result}}`, `state` in
`queued | running | delivered | verified | failed | cancelled`, `check` null
until a reviewer or verifier reports. Append one line per write
(`printf '%s\n' "$line" >> status.jsonl`): a write under 4 KiB reaches a local
filesystem whole, so parallel deliveries never interleave. `files` and `paths`
cap at 20 a line and the file never rotates — a resume replays from line 1.

Reconcile one-liners:

    jq -rs 'group_by(.name) | map(max_by(.ts))' status.jsonl
    jq -rs 'group_by(.name) | map(max_by(.ts)) | map(select(.state=="delivered"))' status.jsonl
    jq -rs 'group_by(.name) | map(max_by(.ts)) | map(select(.state=="running")) | .[].name' status.jsonl

The extension never reads the ledger: it is plain data for the orchestrator.

## Steering and resume

`subagent_message({ name, message })` steers a running child — delivered at
its next turn boundary — or, by the same name, resumes a finished session.
Resume replays the sandbox snapshot recorded at spawn (tools, model, identity,
nested-spawn allowlist); it is refused without the snapshot rather than
relaunching unrestricted, and a name still running is steered instead of
resumed (two processes on one session file would corrupt it). Both paths are
fire-and-forget: the result arrives later as a steer message. Resumed and
auto-restarted runs are not re-budgeted.

## Control verbs and live metrics

`subagent_control({ action, name })` acts on a live child by display name
(`index.ts` `cancelRunningSubagent`, `cancelQueuedSpawn`, `restartSubagent`).
Like spawn it is fire-and-forget — the outcome arrives later as a steer
message, so do not poll.

- `cancel`, running child — cancel intent is recorded first (it blocks the
  pane-loss auto-restart gates), then the pane is stopped through the
  budget-stop sequence: interrupt, grace window, kill. Finalization goes
  through the standard delivery funnel, which releases the declared scope
  lock, aborts the watcher (its settle frees the slot), and delivers exactly
  one result — synthesized `cancelled_by_parent`; a real delivery racing the
  grace window wins and the synthesis becomes a no-op.
- `cancel`, queued spawn — detached from the FIFO, its scope and name
  reservations released, unparking spawns queued behind it; a queued entry
  holds no concurrency slot, so the holder count is untouched.
- `restart` — the live pane is stopped (the restart machinery expects a dead
  pane) and the child re-dispatched through the pane-loss restart path: same
  name, same registry entry, the watcher keeps watching. Refused unless the
  child is a pi-CLI auto-exit run with assistant progress that has not been
  restarted, delivered, or budget-stopped.
- Unknown or inactive names return a single error line.

Cleanup is pane-scoped — the lock frees before the process tree is confirmed
gone, so a child's background jobs, servers and browser can outlive it. A
name is reserved across in-flight and recorded runs: it resumes, never hosts
a second concurrent child.

`subagents_list` renders one live-metrics line per child under
"Live children:" — name, elapsed, phase, turns, tokens, cost, e.g.
`worker-1 · 842s · active · 12t · 84k tok · $0.42 · past p90 (14m)`. Unmetered children trim
the usage fields rather than zero-filling; queued entries show
`name · queued`. A running child whose elapsed exceeds its agent's p90
history baseline is flagged `past p90 (Nm)`, N being the baseline's p90 in
minutes — a baseline needs at least three history rows with a positive
`durationMs` (cancelled and budget-stopped runs count), so rarely-run
agents are never flagged.

The spawn ack (launched or queued) carries two history-derived notes. A
time-sense line — ``typical for `worker`: median 5m · p90 15m · $0.34`` —
gives the agent's median and p90 duration plus median cost from recent
history (cost omitted when no row carried one; sub-minute figures clamp up
to 1m; also gated on the same three-row minimum). A warn-only duplicate note fires
when a near-identical same-agent task is already running — steer that child
instead of respawning — or a near-identical task ran before — re-check that
result before respawning. Both are hints, not blocks; the orchestrator
decides whether the re-run is legitimate.

## Pane recovery

Any pane touch can fail with tmux `can't find pane` — a reaped window, an
externally killed pane, a stale cached pane id. Each lifecycle step self-heals:

- **split origin** — a `split-window` whose from-pane is dead resets the cached
  agents-session pane id and re-splits once from a live pane (`tmux.ts`
  `createSurfaceSplit`);
- **full window** — a `split-window` refused with `create pane failed: pane too
  small` grows the target window one step and retries; when growth hits the
  pane-capacity limit, the oldest non-base pane in that window is closed to
  make room; with nothing left to close the capacity error propagates
  unchanged (`tmux.ts` `splitWithHeal`);
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

## Session geometry and capacity

- **idempotent creation** — `new-session -A -d -s pi-agents -x 220 -y 55`
  attaches when the session already exists, so parallel first spawns cannot
  lose to `duplicate session` (`tmux.ts` `ensureAgentsSessionPane`).
- **fixed geometry, growth on refusal** — the dedicated window is pinned
  via `window-size manual` at 220x55; a split refused with
  `no space for a new pane` or `pane too small` grows it one step up
  280x70 → 360x90 → 480x120 and retries the split once. A size-refused
  split in the parent's own pane never resizes the user's window — it
  redirects to the dedicated session and grows that instead (`tmux.ts`
  `growAgentsWindow`).
- **growth never shrinks** — the next step must exceed the current size in
  BOTH dimensions; a manually enlarged window (e.g. 600x300) matches no
  step and the spawn fails with an explicit capacity error naming the
  current size instead of silently resizing down. An unparseable size is
  never guessed: `window-size manual` only, split retried un-grown.
- **idempotent close** — `kill-pane` answered by `can't find pane` means
  the pane was already reaped: success, not an error (`tmux.ts`
  `closeSurface`).
- **true exit statuses** — every pane is created with `remain-on-exit on`,
  so a dead child stays readable instead of vanishing; exit 127 = the
  command could not start (missing binary, broken `PATH`) (`tmux.ts`
  `pollForExit`).
- **version mismatch** — `server version is too old for client` (tmux
  upgraded while an old server runs) surfaces a restart hint:
  `tmux kill-server` — panes reopen on demand (`index.ts`).

Verify:

    tmux has-session -t pi-agents && tmux show-options -w -t pi-agents window-size
    tmux display-message -p -t pi-agents '#{window_width}x#{window_height}'
    tmux list-panes -a -F '#{session_name} #{pane_id} dead=#{pane_dead} exit=#{pane_dead_status}'

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
| spawn fails, `no space for a new pane` | window auto-grows up to 480x120; past that the OLDEST subagent pane in the window is evicted to make room (the split base is never evicted) — with nothing left to evict, an explicit capacity error names the size (see Session geometry and capacity) |
| spawn fails, `duplicate session` | no longer reachable — session creation is `-A -d` idempotent; if seen anyway, retry the spawn |
| child pane `dead`, exit 127 | command could not start (missing binary, broken `PATH`) — pane kept via `remain-on-exit`; fix the command |
| `server version is too old for client` | tmux upgraded under a running server — `tmux kill-server`, retry; panes reopen on demand |
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
