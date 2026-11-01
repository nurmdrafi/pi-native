# Subagents

Owned first-party code at `extensions/subagents/` (`subagent` / `subagent_message` /
`subagents_list` / `subagent_control` + `/subagents` command), vendored upstream with local patches folded in — agents-only tmux and permission-gate re-enabled inside sandboxed spawns. No `settings.json` → `packages` entry, so `pi update --extensions` cannot wipe it.

**Gated by default** — the spawning and control tools are registered inactive in top-level sessions (zero prompt tokens) until a trigger activates them:

- `/subagents on` / `/subagents off` — toggle for the session
- `/subagents [agent] [task]` — any spawn auto-enables; with no agent named, the session model routes by task
- `PI_SUBAGENTS=1` — start active (scripted opt-in)

**Invoked from the current session only** — spawn subagents via the `/subagents` slash command in the existing session; never run a subagent as a detached/background session.

Sandboxed spawns re-enable the permission-gate extension inside the child by
default (its `extensions/permission-gate` directory under the agent home);
`PI_SUBAGENT_EXTRA_EXTENSIONS` (colon-separated paths) overrides.

**Budgets** — ceilings per dimension: wall-clock seconds, assistant turns, and cumulative provider-reported USD cost. Resolution per dimension: role frontmatter `budget:` block → `budgetDefaults` in `extensions/subagents/config.json` (absent file → the shipped `config.json.example`: 1800 s / 60 turns / $3) → unenforced. Role `budget: none` exempts the agent entirely — every shipped role agent declares it, so ceilings bind fork clones and any definition without the exemption. A spawn `budget` override may only lower a ceiling, never raise it. On breach the child is interrupted (Ctrl-C), killed after a 10 s grace, and the result reports `budget_exceeded`; the session file is preserved for resume, and resumed or auto-restarted runs are not re-budgeted. Detached subagents are not budgeted once the parent session ends.

**Result records** — finished results carry `files_changed`: repo-relative
paths changed since a spawn-time git baseline, sorted, capped at 200,
provenance `files_changed_source`; omitted when git or the baseline is
unavailable. Each result appends
`{id, ts, name, files_changed, files_read, diff, summary, turns, tokens,
costUsd, durationMs}` (zero-change reads included) to
`.pi/subagent-history.jsonl` — append-only, `diff`/`summary` capped, rotated
to the last 500 lines past 1000, surviving result-inbox drain. The rendered
result shows at most 20 paths plus `… +N more`.

**Declared scopes and locks** — a spawn may declare `files`: its write scope,
repo-relative to the child `cwd` and not existence-checked, so planned
deliverables lock too; pair it with an explicit `cwd` — git attribution for
`files_changed` uses it. Only declared scopes lock — and only within one
working tree: conflicts compare absolute paths resolved against each
child's `cwd`, so the same repo-relative path in two worktrees never
conflicts. On segment-prefix overlap (exact file, or a directory owning the
subtree) the colliding spawn queues FIFO behind the owner while
non-conflicting spawns keep launching; unscoped
and read-only spawns never queue. `PI_SUBAGENTS_SCOPE_MODE` = `queue`
(default) | `warn` | `off`; injection still runs in `off`. Locks release at
result delivery and survive pane-loss restart; `subagents_list` shows each
owner under "Declared file scopes (write locks)" (widget: `▣` + count). A
scope overlapping recent history injects a capped prior-work block into the
task (≤2 records: paths, diff excerpt, summary) so the child does not re-read
changed files.

**Control verbs** — `subagent_control` stops or re-dispatches a live child by
name. `cancel` on a running child goes interrupt → grace → kill and finalizes
with a synthesized `cancelled_by_parent` result through the standard delivery
funnel, which releases the scope lock and — once the watcher settles — the
slot; a delivery racing the grace window wins, so exactly one result lands.
On a queued child `cancel` drops the queue entry and releases its scope and
name reservations (queued entries hold no slot); an unknown name returns a
single error line. `restart` stops the pane and re-dispatches through the
pane-loss restart machinery under the same name and entry — refused unless
the child is an auto-exit run with assistant progress that was not already
restarted, delivered, or budget-stopped. Recorded cancel intent blocks
pane-loss auto-restart. `subagents_list` prints one live line per child —
name, phase, elapsed, turns, tokens, cost — with unmetered fields trimmed,
queued entries shown as `name · queued`, and a running child past its
agent's p90 history baseline (≥3 usable rows required) flagged
`past p90 (Nm)` — N is the baseline's p90 in minutes. Spawn acks (launched
or queued) add a per-agent time-sense line — ``typical for `agent`: median
Xm · p90 Ym · $Z`` (median cost, omitted when no row carried one) — and a
warn-only duplicate note when a near-identical same-agent task is already
running or a history summary matches: steer that child or re-check the
prior result before respawning.

Setup, control verbs, pane recovery, headless/print-mode behavior, scope
locks, result records, and triage: [`extensions/subagents/README.md`](../extensions/subagents/README.md).

Agent definitions live in `agents/` — plain files, inert while the spawn tools are gated; discovery is project > global. No `model` pin: subagents inherit the harness default. Every definition must declare `tools:` — a spawn naming an agent without the declaration is denied (deny-by-default; the unrestricted toolset is reserved for top-level fork clones).

A spawn runs with `--no-extensions` plus one `-e` per tool-backing extension, so agent `tools:` lists name the native tools alongside their built-in fallbacks (`piread`, `piedit`, `pibash`). Each native extension announces itself to the subagents extension via `registerToolExtension`, which is what makes those names resolve to an `-e` path — without it a sandboxed subagent would silently get the built-in implementations.

| Agent         | Tools | Role |
| ------------- | ----- | ---- |
| architect-reviewer | ls, piread, pibash | read-only architecture review — dependency direction, pattern adherence, coupling, boundaries |
| bench-runner  | write, piread, pibash | runs frozen benchmark/eval arms under hard wall budgets; writes only its result file |
| docs-optimizer | write, piread, piedit, pibash (auto-loads `documentation-writer`) | optimizes rule/instruction Markdown; drafts README/CHANGELOG proposals |
| frontend-worker | write, piread, piedit, pibash (auto-loads `playwright-tester`) | component/UI implementation with component tests |
| product-manager | write, piread, pibash (auto-loads `brainstorming`) | drafts structured product briefs with numbered acceptance criteria |
| researcher    | write, piread, pibash (auto-loads `web-search`) | web research via the `tvly` CLI |
| rust-engineer | write, piread, piedit, pibash (auto-loads `rust-skills`) | Rust workspace implementation; cargo fmt/clippy/test discipline |
| security-reviewer | ls, piread, pibash | read-only security pass over trust-boundary diffs (auth, secrets, injection, data loss, guard logic) |
| session-auditor | ls, piread, pibash, pidx (auto-loads `session-audit`) | session-history analysis; appends lessons, never edits history |
| reviewer      | ls, piread, pibash (auto-loads `code-reviewer`) | pre-commit diff review; never commits/pushes |
| scout         | ls, piread, pibash | read-only recon |
| ui-verifier   | ls, piread, pibash (auto-loads `browser-tools`) | drives the running app via headless Chromium + CDP; verifies rendered behavior |
| verifier      | ls, piread, pibash | runs the change; reports per-criterion PASS/FAIL, never fixes |
| worker        | write, piread, piedit, pibash (auto-loads `systematic-debugging`, `ponytail`; may spawn scout, researcher) | general implementer; scoped issue-fixing in worktrees |

**Orchestration rules** — doctrine for the session that spawns agents:

- Gate each delegation: it must beat working inline on speed, accuracy, or quality — a complete deliverable, a well-scoped file-set, facts already known; otherwise work inline. A child costs a fresh-context reload at many times linear chat cost: tasks under the sizing bar, single-file edits, or steps whose files collide with running children stay linear; parallelize only independent, multi-step work with a declared scope.
- Route by contract against the roster table above; read-only work never goes to worker. Only worker spawns children (scout, researcher) — no deeper nesting. Keep the table and `agents/` frontmatter in sync on every roster change.
- One task = one agent = one file-set: disjoint file-sets spawn in the same turn; any shared file forces the next wave. Start a downstream agent early only when its input contract is fixed — steer the correction if it changes.
- Bake facts into every task prompt: paths, line numbers, shapes, contracts, verification command, report format (state one only to deviate). A worker that must explore is a linear worker plus overhead: scrape the facts yourself, or send a scout and spawn the worker on its report.
- Spawn with `agent` (the profile) plus a stable task-specific `name` (label and resume handle) and `cwd` at the target package so the child loads its local rules. After spawning, end the turn — never poll, sleep, tail logs, or fabricate results; finished work arrives on its own.
- Children run unattended — no user is watching. A blocked command is a closed door: skip it, note it in the result; never ask permission for one. ask_question carries only task decisions or confusion.
- Budgets never end work: spawn unbudgeted by default; where cost control demands a ceiling, size it far above the estimate. A cutoff is a signal, not a failure — resume by name and continue.
- Transient failure (provider 5xx, rate limit): resume the same named agent with a retry nudge — fresh spawn only for new work. A blocked worker asks one question and waits — answer it via steer. A run looping or repairing >5 cycles: steer it to stop and report.
- Follow-ups resume the same named agent (warm context); keep prompts prefix-stable so the warm context holds. A result recovered from a dead session is information — act only if it needs action.
- Guard orchestrator context: at most 6 children at once; digest each finished wave into a scratch file (one line per agent — verdict, paths) and work from that file, not re-delivered results; prefer a fresh session over compacting one session through a large effort.
- Every worker prompt carries scope (files it may touch), contract, verification command, and the bans: no commits, no installs, no working around blockers — report them.
- Task sizing: every task scope-driven and measurable, ~10 minutes or less — split bigger scopes into sequential waves. Before spawning, check the wave ledger/history/cache for equivalent in-flight or completed work; reuse instead of duplicating.
- Wave autonomy: pending work with a free file-set starts immediately — never wait to be told; ask only for scope, priority, cost, or safety decisions the user must own. On every wave completion, dispatch the next unblocked wave without prompting.
- End every wave with an independent check of the combined result — reviewer for diffs, verifier for criteria; never merge unverified parallel work.
