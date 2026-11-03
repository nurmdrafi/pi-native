# Subagent orchestration

Orchestrator-facing doctrine. Child-facing conduct lives in `docs/subagents.md` — that file reaches child sessions; keep it lean. First-party code at `extensions/subagents/` — machinery reference is that extension's README. Verbs: spawn `subagent`, steer or resume `subagent_message`, list `subagents_list`, cancel or restart `subagent_control`.

Spawning tools register inactive (zero prompt tokens) until `/subagents on|off`, any `/subagents [agent] [task]` spawn, or `PI_SUBAGENTS=1`. Spawn from the current session only — never detached or background; a print-mode parent exits before results arrive.

Machinery limits — act on these:

- Writes are discouraged, not enforced — heuristic command-text filter; every role still carries `pibash`.
- Shipped roles take `budget: none`: no ceiling can be set, and aggregate wave spend is unbounded.
- `files_changed` is a hashless git-status delta: concurrent siblings land in it, and prior-work injection may be stale — verify before relying.
- Unscoped spawns never queue: always declare `files`, or two writers collide silently.
- `PI_SUBAGENTS_EXTRA_EXTENSIONS` replaces the default permission-gate entry — omit the gate path and the child runs ungated.
- Cleanup is pane-scoped: background jobs, servers and browsers can outlive the child.

Terms — fork clone: a child that clones the current session instead of a named profile, taking the unrestricted toolset. Wave ledger: the effort ledger (`plan.md` plus `status.jsonl`). Cache: recovered results and recorded history rows.

## Agents

Definitions live in `agents/`, inert while the spawn tools are gated; discovery is project > global — `<project>/.pi/agents/<name>.md` shadows the shipped name outright, `tools:` included. No `model` pin. Every definition must declare `tools:`; undeclared is denied (deny-by-default; the unrestricted toolset is reserved for top-level fork clones).

`tools:` names resolve from extension manifests and the naming convention first — that is what turns a name into an `-e` path — with `registerToolExtension` as last resort; unresolved names silently fall back to the built-in, so entries name the natives (`piread`, `piedit`, `pibash`) alongside built-in fallbacks.

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

- Delegate only when it beats inline on speed, accuracy, or context: two or more disjoint file-sets, a context-heavy read sweep that would bloat the orchestrator window, or an independent check. Overlapping file-sets serialize, so they win only on isolation, never wall clock. A child's fresh context costs many times linear, so the task's value must pay that back — read-heavy parallel work qualifies, single-file coding does not. Single-file tasks with no independent verification, and work past one wave (≈10 minutes), stay linear. Even inside a subagent-driven effort, single-file and few-minute fixes stay linear — delegation pays only on parallel-disjoint file-sets or context-heavy sweeps.
- Route by contract against the roster; review-only work never goes to worker. Only an agent declaring `subagent_agents` — today `worker: scout, researcher` — spawns children; that field, not `tools:`, is the enforced allowlist. Depth stops at two (no spawning agent declares `subagent_agents` itself); grandchildren inherit the gate without counting toward the child cap. Keep the table and `agents/` frontmatter in sync on roster changes.
- One task = one agent = one file-set: disjoint sets spawn in the same turn; any shared file forces the next wave. Parallel write scopes are pairwise-disjoint file lists — claim a directory only when nothing beneath it is claimed elsewhere: the directory owns its whole subtree, so a sibling naming a nested file queues behind it. A spawn acknowledgement that queues the task says the partition failed — narrow the running owner's scope by steer, never wait out the queue. Start a downstream agent early only on a fixed input contract — steer the correction if it changes.
- Bake facts into every task prompt: paths, line numbers, shapes, contracts, verification command, report format. The verification command names the scoped test, never the full suite — the full suite is the orchestrator's end-of-wave gate, run once. Anchor-rich briefs are the turn lever: a brief carrying 5-10 anchors (paths, line refs, symbols, verification, report format) runs a child in roughly a third of the turns an under-briefed one needs. A worker that must explore is a linear worker plus overhead — scrape the facts or send a scout. The deliverable is a machine-readable file; the report back is a pointer plus headline numbers, never file contents restated — a payload pasted into a report still truncates. A child without file-write tools returns hand-walked numbers only.
- Spawn with `agent`, a stable task-specific `name` (resume handle), and explicit `files` plus `cwd` at the target package — `files`/`cwd` do the locking, not the prompt's scope sentence. After spawning, end the turn: no polling, sleeping, tailing logs, or fabricating results.
- Children run unattended: a blocked command is a closed door — skip it, note it; ask_question only for task decisions or confusion.
- A budget cutoff is a signal, not a failure — resume by name. Shipped roles take `budget: none`; a ceiling applies only to a fork clone, sized far above the estimate.
- Provider-transient death (429, 5xx, overload, reset) auto-resumes the same session once; the delivery names the resume, never a fresh spawn — that re-pays the child's whole context. Other failures: resume the same named agent with a retry nudge; fresh spawn only for new work. Under rate limit with children live, serialize — resume one per report-back, never a whole wave. Answer a blocked child's question by steer; its wait burns wall clock. A run looping or repairing >5 cycles: steer it to stop and report.
- Follow-ups resume the same named agent (warm context); keep prompts prefix-stable. A result recovered from a dead session is information — act only if action is needed.
- At most 6 children at once — doctrine, not the code cap (default 5, grandchildren outside both; a workflow may set stricter lanes). Append each finished wave to the ledger (one `status.jsonl` line per agent — verdict, paths) and work from it, not re-delivered results; prefer a fresh session over compacting through a large effort.
- Every worker prompt carries scope, contract, verification command, and the bans: no installs, no working around blockers, no commits unless the template grants them on the child's branch — report a blocker instead. No interpreter one-liners or pipeline writes in child shells — the permission gate refuses them; use file tools, or return the exact payload verbatim for the orchestrator to persist.
- Every task scope-driven and measurable. Before spawning, check the ledger, history and cache for equivalent work; reuse instead of duplicating.
- Wave autonomy: pending work with a free file-set starts immediately; ask only for scope, priority, cost or safety decisions the user must own; on wave completion dispatch the next unblocked wave without prompting.
- While children run, the parent keeps its own lane full: linear backlog (ledger rows, next-wave briefs, inline micro-fixes) proceeds between dispatches — a parent that only waits has serialized the whole effort behind the children. Delegation health is measured, not assumed: at wave end, steers ≥ spawns means the briefs or the partition failed — the next wave re-chunks with a facts sweep first or goes linear; and before every spawn, clear stale locks: a child that already delivered must not hold its write scope, or later spawns queue behind a ghost.
- One child result = one parent turn: append the ledger line, run the machine check, and dispatch the next unblocked wave in that same turn — every boundary turn between them is idle wall clock.
- End every wave with an independent check before the next wave; never merge unverified parallel work. Scale the check to the change: small diffs (under a few hundred lines) or machine-checkable criteria get the verification command run inline by the orchestrator; larger diffs or subjective criteria get a reviewer for diffs, a verifier for criteria.

## Effort ledger and resume

One directory per effort: `~/.pi/efforts/<id>/`, outside every repo (in-repo only where `.pi/` is already gitignored); the id is a short slug chosen once. Orchestrator-owned — children never write it, and it is never injected into a child prompt: copy the facts a task needs into that prompt. `plan.md` (goal, wave order, one row per task) and `status.jsonl` (one line per state change); formats and reconcile one-liners: README.

A fresh session reads `plan.md`, replays `status.jsonl` (last line per name wins), calls `subagents_list`, and reconciles: running and live — leave it; running and absent — its history row decides (present = delivered, missing = failed); delivered with no verified line — run the independent check; queued and absent — re-dispatch by the same name unless its scope is locked; verified — skip. Dispatch the first wave whose deps are all verified; seed each prompt from its plan row. An effort never closes with delivered-but-unverified rows: the final reconcile runs each missing check, or records in the ledger why it was skipped.

Crash-resume discipline: before resuming a dead child, measure its ground-truth progress — expected error counts and the working-tree diff of its scope, not the child's self-report. Resume once; a second termination, or a resume window with zero progress against that baseline, abandons the session — re-chunk the remainder into smaller fresh tasks and delete the untracked scratch/probe files the dead session left.
