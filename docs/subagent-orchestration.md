# Subagent orchestration

Orchestrator doctrine. Child conduct: `docs/subagents.md` (reaches child sessions — keep lean). Machinery reference: `extensions/subagents/` README. Verbs: `subagent` (spawn), `subagent_message` (steer/resume), `subagents_list` (list), `subagent_control` (cancel/restart).

Spawn tools inactive (zero prompt tokens) until `/subagents on|off`, any `/subagents [agent] [task]` spawn, or `PI_SUBAGENTS=1`. Spawn from the current session only — never detached/background; a print-mode parent exits before results arrive.

## Machinery limits
- Writes discouraged, not enforced — heuristic command-text filter; every role still carries `pibash`.
- Shipped roles take `budget: none`: no ceiling settable, aggregate wave spend unbounded.
- `files_changed` = hashless git-status delta: concurrent siblings land in it; prior-work injection may be stale — verify before relying.
- Unscoped spawns never queue: always declare `files`, or two writers collide silently.
- `PI_SUBAGENTS_EXTRA_EXTENSIONS` replaces the default permission-gate entry — omit the gate path, child runs ungated.
- Cleanup is pane-scoped: background jobs, servers, browsers can outlive the child.

Terms: fork clone = child cloning the current session (unrestricted toolset). Wave ledger = `plan.md` + `status.jsonl`. Cache = recovered results and history rows.

## Agents
- Definitions in `agents/`, inert while spawn tools are gated. Discovery: project > global; `<project>/.pi/agents/<name>.md` shadows the shipped name outright, `tools:` included. No `model` pin.
- Every definition declares `tools:`; undeclared = denied (deny-by-default; unrestricted toolset reserved for top-level fork clones).
- `tools:` names resolve from extension manifests and the naming convention first (that makes the `-e` path); `registerToolExtension` last. Unresolved names silently fall back to the built-in — so entries name the natives (`piread`, `piedit`, `pibash`) alongside built-in fallbacks.

| Agent | Tools | Role |
| ----- | ----- | ---- |
| architect-reviewer | ls, piread, pibash | architecture review — dependencies, coupling, boundaries |
| auth-worker | write, piread, piedit, pibash (`auth`) | auth/session implementation — login flows, token refresh, guards, access control |
| bench-runner | write, piread, pibash | frozen benchmark/eval arms under hard wall budgets; writes only its result file |
| docs-optimizer | write, piread, piedit, pibash (`documentation-writer`) | optimizes rule/instruction Markdown; drafts README/CHANGELOG proposals |
| frontend-engineer | write, piread, piedit, pibash (`playwright-tester`) | component/UI implementation with component tests |
| map-engineer | write, piread, piedit, pibash (`map-integration`) | map rendering — overlays, composite-layer performance, camera/viewport |
| product-manager | write, piread, pibash (`brainstorming`) | structured product briefs with numbered acceptance criteria |
| researcher | write, piread, pibash (`web-search`) | web research via the `tvly` CLI |
| reviewer | ls, piread, pibash (`code-reviewer`) | pre-commit diff review; never commits/pushes |
| rust-engineer | write, piread, piedit, pibash (`rust-skills`) | Rust implementation; cargo fmt/clippy/test discipline |
| scout | ls, piread, pibash | recon |
| security-reviewer | ls, piread, pibash | security pass over trust-boundary diffs — auth, secrets, injection, data loss, guards |
| session-auditor | ls, piread, pibash, pidx (`session-audit`) | session-history analysis; appends lessons, never edits history |
| ui-verifier | ls, piread, pibash (`browser-tools`) | drives the running app via headless Chromium + CDP |
| verifier | ls, piread, pibash | runs the change; per-criterion PASS/FAIL, never fixes |
| worker | write, piread, piedit, pibash (`systematic-debugging`, `ponytail`; `subagent_agents: scout, researcher`) | general implementer; scoped issue-fixing in worktrees |

## Orchestration rules
- Delegate only when it beats inline on speed, accuracy, or context: 2+ disjoint file-sets, a context-heavy read sweep, or an independent check. Overlapping sets serialize — isolation only, never wall clock. Fresh child context costs many times linear; read-heavy parallel work pays, single-file coding does not.
- Stay linear: single-file tasks without independent verification; work past one wave (~10 min); few-minute fixes — even inside a subagent effort.
- Route by contract against the roster; review-only work never goes to worker. Only an agent declaring `subagent_agents` (today `worker: scout, researcher`) spawns children — that field, not `tools:`, is the enforced allowlist. Depth stops at two (no spawner declares `subagent_agents`); grandchildren inherit the gate, outside the child cap. Table and `agents/` frontmatter stay in sync.
- One task = one agent = one file-set. Disjoint sets spawn in the same turn; any shared file forces the next wave. A directory claim owns its whole subtree — a sibling naming a nested file queues. Queued ack = failed partition: narrow the owner's scope by steer, never wait out the queue. Start a downstream agent early only on a fixed input contract; steer the correction if it changes.
- Bake facts into every prompt: paths, line numbers, shapes, contracts, verification command, report format. Verification names the scoped test, never the full suite (that is the orchestrator's end-of-wave gate, run once). 5–10 anchors cut a child to ~1/3 the turns; a worker that explores is a linear worker plus overhead — scrape facts or send a scout. Deliverable = machine-readable file; report = pointer + headline numbers, never restated contents. Child without file-write tools → hand-walked numbers only.
- Spawn with `agent`, a stable task-specific `name` (resume handle), explicit `files` + `cwd` at the target package — `files`/`cwd` do the locking, not the scope sentence. Paste `cwd` from the session cwd field verbatim, never retype it; carry an absolute repo path in the prompt as recovery. Then end the turn: no polling, sleeping, tailing logs, fabricating results.
- Children run unattended: blocked command = closed door — skip, note; `ask_question` only for task decisions or confusion.
- Budget cutoff = signal, not failure — resume by name. Shipped roles: `budget: none`; a ceiling applies only to a fork clone, sized far above the estimate.
- Provider-transient death (429, 5xx, overload, reset): auto-resume the same session once; the delivery names the resume, never a fresh spawn (that re-pays the whole context). Other failures: resume the same name with a nudge; fresh spawn only for new work. Rate-limited with children live: serialize — one resume per report-back, never a whole wave. Blocked child's question → answer by steer (wait burns wall clock). Run looping or repairing >5 cycles → steer it to stop and report. Pane lost before reporting: resume the same name once; two consecutive losses on one lane = flaky lane — verify inline, never a third identical dispatch.
- Follow-ups resume the same name (warm context); keep prompts prefix-stable. A result recovered from a dead session is information — act only if action is needed.
- Max 6 children at once — doctrine, not code cap (default 5, grandchildren outside both; workflows may set stricter lanes). Ledger each finished wave: one `status.jsonl` line per agent (verdict, paths); work from the ledger, not re-delivered results. Prefer a fresh session over compacting a large effort.
- Every worker prompt carries scope, contract, verification command, and bans: no installs, no working around blockers, no commits unless the template grants them on the child's branch — report a blocker instead. No interpreter one-liners or pipeline writes in child shells (gate refuses them): use file tools, or return the exact payload for the orchestrator to persist.
- Tasks scope-driven and measurable. Before spawning: check ledger, history, cache for equivalent work; reuse, don't duplicate. Plan-driven implementation: confirm the gap is real (git log -S on the plan's key symbols, or one rg) before spawning.
- Wave autonomy: pending work + free file-set → start immediately; ask only scope, priority, cost, or safety decisions the user must own; on wave completion dispatch the next unblocked wave without prompting.
- While children run, the parent keeps its own lane full (ledger rows, next-wave briefs, inline micro-fixes) — a parent that only waits serializes everything behind the children. Delegation health is measured: steers ≥ spawns at wave end = briefs or partition failed → next wave re-chunks (facts sweep first) or goes linear. Before every spawn, clear stale locks: a delivered child must not hold its write scope, or spawns queue behind a ghost.
- One child result = one parent turn: append the ledger line, run the machine check, dispatch the next unblocked wave — boundary turns are idle wall clock.
- End every wave with an independent check before the next; never merge unverified parallel work. Scale: small diffs (under a few hundred lines) or machine-checkable criteria → verification command inline by the orchestrator; larger or subjective → reviewer for diffs, verifier for criteria.

## Effort ledger and resume
- One directory per effort: `~/.pi/efforts/<id>/`, outside repos (in-repo only where `.pi/` is gitignored); short slug id, chosen once. Orchestrator-owned: children never write it, never see it — copy needed facts into the prompt.
- `plan.md`: goal, wave order, one row per task. `status.jsonl`: one line per state change. Formats and reconcile one-liners: README.
- Fresh session: read `plan.md`, replay `status.jsonl` (last line per name wins), `subagents_list`, reconcile:
  - running + live → leave it; running + absent → history row decides (present = delivered, missing = failed)
  - delivered, unverified → run the check; queued + absent → re-dispatch same name unless scope locked; verified → skip
- Dispatch the first wave whose deps are all verified; seed prompts from plan rows. An effort never closes with delivered-but-unverified rows: final reconcile runs each missing check or records why skipped.
- Crash resume: measure ground truth first — error counts and working-tree diff of the scope, not self-report. Resume once; a second termination, or zero progress against that baseline → abandon: re-chunk the remainder into smaller fresh tasks, delete the dead session's untracked scratch/probe files.
