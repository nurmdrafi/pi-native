# Subagents

First-party code at `extensions/subagents/` — machinery reference is that extension's README. Verbs: spawn `subagent`, steer or resume `subagent_message`, list `subagents_list`, cancel or restart `subagent_control`.

Spawning tools register inactive (zero prompt tokens) until `/subagents on|off`, any `/subagents [agent] [task]` spawn, or `PI_SUBAGENTS=1`. Spawn from the current session only — never detached or background; a print-mode parent exits before results arrive.

Machinery limits — act on these:

- Writes are discouraged, not enforced — heuristic command-text filter; every role still carries `pibash`.
- Shipped roles take `budget: none`: no ceiling can be set, and aggregate wave spend is unbounded.
- `files_changed` is a hashless git-status delta: concurrent siblings land in it, and prior-work injection may be stale — verify before relying.
- Unscoped spawns never queue: always declare `files`, or two writers collide silently.
- `PI_SUBAGENT_EXTRA_EXTENSIONS` replaces the default permission-gate entry — omit the gate path and the child runs ungated.
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

- Delegate only when it beats inline on speed, accuracy, or quality: two or more files, or an independent check. Single-file tasks with no independent verification, and work past one wave (≈10 minutes), stay linear — a child's fresh context costs many times linear.
- Route by contract against the roster; review-only work never goes to worker. Only an agent declaring `subagent_agents` — today `worker: scout, researcher` — spawns children; that field, not `tools:`, is the enforced allowlist. Depth stops at two (no spawning agent declares `subagent_agents` itself); grandchildren inherit the gate without counting toward the child cap. Keep the table and `agents/` frontmatter in sync on roster changes.
- One task = one agent = one file-set: disjoint sets spawn in the same turn; any shared file forces the next wave. Start a downstream agent early only on a fixed input contract — steer the correction if it changes.
- Bake facts into every task prompt: paths, line numbers, shapes, contracts, verification command, report format. A worker that must explore is a linear worker plus overhead — scrape the facts or send a scout.
- Spawn with `agent`, a stable task-specific `name` (resume handle), and explicit `files` plus `cwd` at the target package — `files`/`cwd` do the locking, not the prompt's scope sentence. After spawning, end the turn: no polling, sleeping, tailing logs, or fabricating results.
- Children run unattended: a blocked command is a closed door — skip it, note it; ask_question only for task decisions or confusion.
- A budget cutoff is a signal, not a failure — resume by name. Shipped roles take `budget: none`; a ceiling applies only to a fork clone, sized far above the estimate.
- Provider-transient death (429, 5xx, overload, reset) auto-resumes the same session once; the delivery names the resume, never a fresh spawn — that re-pays the child's whole context. Other failures: resume the same named agent with a retry nudge; fresh spawn only for new work. Under rate limit with children live, serialize — resume one per report-back, never a whole wave. Answer a blocked child's question by steer; its wait burns wall clock. A run looping or repairing >5 cycles: steer it to stop and report.
- Follow-ups resume the same named agent (warm context); keep prompts prefix-stable. A result recovered from a dead session is information — act only if action is needed.
- At most 6 children at once — doctrine, not the code cap (default 5, grandchildren outside both; a workflow may set stricter lanes). Append each finished wave to the ledger (one `status.jsonl` line per agent — verdict, paths) and work from it, not re-delivered results; prefer a fresh session over compacting through a large effort.
- Every worker prompt carries scope, contract, verification command, and the bans: no installs, no working around blockers, no commits unless the template grants them on the child's branch — report a blocker instead.
- Every task scope-driven and measurable. Before spawning, check the ledger, history and cache for equivalent work; reuse instead of duplicating.
- Wave autonomy: pending work with a free file-set starts immediately; ask only for scope, priority, cost or safety decisions the user must own; on wave completion dispatch the next unblocked wave without prompting.
- End every wave with an independent check — reviewer for diffs, verifier for criteria — before the next wave; never merge unverified parallel work.

## Effort ledger and resume

One directory per effort: `~/.pi/efforts/<id>/`, outside every repo (in-repo only where `.pi/` is already gitignored); the id is a short slug chosen once. Orchestrator-owned — children never write it, and it is never injected into a child prompt: copy the facts a task needs into that prompt. `plan.md` (goal, wave order, one row per task) and `status.jsonl` (one line per state change); formats and reconcile one-liners: README.

A fresh session reads `plan.md`, replays `status.jsonl` (last line per name wins), calls `subagents_list`, and reconciles: running and live — leave it; running and absent — its history row decides (present = delivered, missing = failed); delivered with no verified line — run the independent check; queued and absent — re-dispatch by the same name unless its scope is locked; verified — skip. Dispatch the first wave whose deps are all verified; seed each prompt from its plan row.
