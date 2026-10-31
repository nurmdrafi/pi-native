---
description: Orchestrate a set of GitHub issues — input is issue number, link, state file, or nothing to continue; auto triage, group, spawn worker subagents, one draft PR per group; resumable; never merges
argument-hint: "[<issue-number | link | state-file>] [--base <branch>] [note]"
---

Trigger with args = authorization for: branch create/switch, commits, pushes to group branches, draft PRs. Human reviews + merges; agent never merges, never readies a PR, never pushes base or trigger branch. The tracker file is NEVER committed or staged — it lives untracked in the working tree.

PRIME DIRECTIVE: complete the batch as fast as possible — use subagents for ALL real work whenever the task has no dependency (parallel groups, parallel temp branches, independent reviewers); the orchestrator keeps every lane full and does work itself only for micro-tasks and coordination.

## 0. Preflight
- `gh auth status` → fail: stop, report.
- Base branch: `--base` arg, else exact branch name in note verified via `git branch --list`, else state file, else the trigger branch's origin counterpart (`origin/<trigger>`; no counterpart → ask the user). Persist in state; resume reads state, never re-asks.
- HARD RULE: the repo default branch is NEVER touched — no commits, resets, pushes, or PRs targeting it, not even as base. Identify it at preflight; treat it as read-only.
- Base sanity check: before cutting any worktree, verify the base CONTAINS the code the issues reference (`git ls-tree <base> --name-only lib/ components/ redux/` plus one recent-issue symbol's file).
- Record: `git rev-parse HEAD` · `git status --porcelain` (dirty tree → stop, report) · `git branch --show-current` = trigger branch.
- Detect once, reuse for all groups: toolchain pin, test/lint/typecheck commands (validate each command shape once against the real toolchain before templating), commit rules (`fd commitlint.config`, read types/scopes/limits). Never detect or run build.
- Input dispatch: state-file path arg → §2 · nothing/"continue" → `docs/issue-orchestrator-state.md` (ALWAYS this exact path and name, under the repo's docs dir — create the dir if missing): exists → §2, missing → stop + ask for issues link · number/link → §1. "All issues" → every open issue. User-reported bugs without an issue enter §1 as work items `UR-1..N` (PR body states no issue auto-closes).

## 1. Seed + triage
- Seed: given number/link → that issue plus one hop of references in body + comments; only open issues of this repo; closed/foreign refs noted, skipped; dedupe; record chain in state. Seed empty after expansion → report, stop.
- Fetch records: `gh issue list --state open --limit 300 --json number,title,body,labels,comments,createdAt,url`; gaps → `gh issue view <n>`.
- Per issue: number · title · module (label, else `rg` the issue's symbols → file paths) · type · acceptance criteria (verbatim; derive only if missing, mark "derived") · dependencies ("#N" refs, shared files).
- One batched `git log --all --grep` sweep over issue keywords at triage: issues already fixed in base ancestry → mark done-upstream, at most add a regression test inline.
- Note arg = constraints: exclusions override inclusion.

## 2. Resume + drift check (state file exists)
- Cross-check state vs live: `gh issue list --state open` · `gh pr list --state open,merged --json number,state,headRefName,url`.
- Recompute per issue: closed or merged PR covers it → resolved, skip. Manually closed → drop. Open PR exists → keep waiting. Rest → pending.
- `blocked-waiting-merge`: dependency merged → unblock, rebase group branch off base; conflict → keep `blocked` with reason. User may direct "proceed without merges": run overlapping groups on temp branches, fold into the group branch locally, list expected cross-PR conflicts in the PR body with a merge order.
- Args on resume may extend the note; never shrink executed scope.

## 3. Group + order
- Group by file/module ownership, 3-8 issues per group; file overlap between groups → merge or sequence.
- Order: shared types/schema/config first → core → UI/integrations → docs/tests last; high risk early.
- Branches: `feat/|fix/|chore/<module>-<short-goal>`, one per group. Max 3 concurrent subagents total (workers + reviewers combined); one worktree per group, never two agents in one worktree. Intra-group parallelism: temp branches in separate worktrees, folded into the group branch once free.
- Pre-spawn check: one clear outcome per group · no two LIVE groups share files · every seed issue in exactly one group · acceptance criteria present · cascade-prone issues (typing/refactor sweeps) get split into explicit sequential sub-tasks with scope caps at planning time — never let one worker discover its own cascade.
- Write the plan into `docs/issue-orchestrator-state.md` (fixed name; never commit or stage it). No approval stop — proceed.
- State schema: run header (base, note, seed chain) · per group: name, order, branch, PR URL · per issue: status ∈ `pending|fixing|in-review|pr-open|blocked-waiting-merge|blocked|skipped|done` + reason. Edits: one surgical replacement per target line, never oldText spanning section headers, verify each batch landed.

## 4. Execute (per group, in order)
- Workspace: `git worktree add <dir> -b <branch> <base>` (exists → worktree on it, rebase; conflict → `blocked`, skip). Main checkout never leaves the trigger branch. Symlink node_modules from the main checkout.
- Subagent mechanics: move the worktree's `.pi/` dir aside before spawning fresh in a reused worktree; resume only continues stopped/running sessions (finished ones replay); confirm every spawn landed (probe names) and respawn the missing; on a budget-stopped agent, resume once with "deliver your verdict/result NOW"; a lost/stalled agent may still deliver late from its durable inbox — wait one beat before spawning a duplicate. After any death, read the agent's durable /tmp report first (`/tmp/fix-<issue>.md`, `/tmp/review-<branch>.md`, `/tmp/progress-<task>.md`) — verdict or milestones may already be complete there; salvage before respawning.
- LANE-KEEPING: an idle orchestrator is a bug — wait only on true dependencies (same-worktree successor, review of an unpushed diff, unmerged-PR dependency). After every return: verify → update state → assign the next item immediately. Backlog when groups finish: reviewer-nit fixes on open PR branches, blocked re-attempts with a changed approach, UR items, close-out drafting. MICRO-TASKS (≤5 lines, obvious shape): orchestrator does them inline in the worktree — no worker round-trip.
- Per issue cluster, sequential: spawn `fixer` with the template below — batch 2-3 issues per spawn when they share a file cluster; one per spawn only for large/risky work. Answer any ask_question within seconds — first line of the answer is exactly `DECISION:` followed by the ruling, so it cannot be mistaken for commentary; workers idle on the orchestrator. On return, verify tiered: always commit exists + scoped diff; code fixes → re-run new test files + check-types; test-only/mechanical → diff review suffices; a test that fails only under parallel load → rerun in isolation before treating it as a failure. `SKIP: <reason>` → mark `skipped`, continue.
- Same-target failure policy: two failures at the same step → the third attempt changes approach (hardened run discipline, different repro); three → `blocked` with repro details. Preserve orphaned partial work (stash/temp branch) — suspect until proven, never destroyed.
- Review gate before push: freeze `git -C <dir> diff <base>...HEAD > /tmp/review-<group>.diff` → spawn `reviewer` on that file only — read-only, verdict `APPROVE | REQUEST_CHANGES`, numbered findings, priority order given, verdict as soon as priorities are checked. Reviewer `SKIP: <reason>` → group `blocked`, no push, continue. Reviewer dies → resume for verdict once; if truly dead, read its durable report `/tmp/review-<branch>.md` for a recorded verdict before self-reviewing; only then does the orchestrator review itself running every verification leg.
- Fix loop: `REQUEST_CHANGES` → fixer with the numbered findings + diff path → re-freeze → reviewer round 2 on the fix hunks only, max 3 rounds. `APPROVE` → push. Still `REQUEST_CHANGES` → push anyway, findings in PR body, status `blocked`.
- Before freezing the review diff (after any fold-ins/fix landings): run the full gate (lint + typecheck + tests) once on the assembled branch.
- Push + PR: `git -C <dir> push -u origin <branch>` → `gh pr create` with explicit `--repo` + `--head` from the main checkout → ONE draft PR per group. Title per commitlint INCLUDING issue refs: `type(scope): summary #N #M`. Body: Summary · per-issue commit-reference list, one line per commit, issue first, full subject, hash as trailing pointer (`#N: fix(scope): full subject (abc1234)`), never a bare-hash line · `Closes #N` per issue (partial work → "partially addresses #N, do not close") · verification evidence · risks · unresolved findings · merge order when cross-PR conflicts are known → `git worktree remove <dir>`.
- Update state (`pr-open`|`blocked`, PR URL, timestamp). Group depends on an unmerged upstream PR → `blocked-waiting-merge`, continue independent groups.

## Worker task template
```text
ROLE: solve issue(s) #N[, #M] in worktree <dir>, branch <branch>, base <base> — batch = one file cluster, solve in listed order, one commit per issue. (Commits already on branch are completed sibling tasks — keep, never report as yours.) When the orchestrator answers your ask_question, restate the decision in one line, then proceed.
SCOPE: <file list>; anything outside → ask_question, never edit. Pre-authorized: files the issue names + tests for files you change.
Per issue: `gh issue view <n>` → defect site + callers → acceptance criteria verbatim → failing test → minimal fix → scoped verification (changed files only) → commit per commitlint rules here, message referencing its issue (`fix(scope): summary (#N)`); hook reject → fix the message, re-run to completion.
RUN DISCIPLINE (hard): test runner ALWAYS one-shot, timeout-wrapped, output fully redirected — `timeout 120 bunx vitest run <files> > /tmp/t<N>.log 2>&1; tail -30 /tmp/t<N>.log`; never the bare runner, never watch mode, never unbounded console output.
TOOLCHAIN: <validated commands>. node_modules symlinked — NEVER install deps or edit lockfiles.
NEVER: push, create PR, merge, build (regenerates shared artifacts, breaks parallel agents), install deps, edit lockfiles, touch docs/issue-orchestrator-state.md, leave the worktree, edit outside SCOPE.
RETURN: per issue — summary · files changed · verification output (commands + exit codes) · risks. Blocker → ask_question immediately.
SKIP: anything confusing · backend dependency needed · risk beyond SCOPE · runner kills the session twice → "SKIP: <reason with repro details>", stop immediately.
```

## 5. Close-out report
- Per group: issues · branch · PR URL · status. Blocked: cause + proposed fix. Human decisions parked in PR bodies. Merge order when cross-PR conflicts are known. Human next actions: review + merge in dependency order, rerun to resume blocked groups.

## Rules
- Full auto after trigger: no approval stops, no questions.
- One PR per group, always draft; PR = review unit. Never per-issue PRs.
- State file = live tracker at `docs/issue-orchestrator-state.md` (always the same path and name); single writer = orchestrator; edited only on the trigger branch; every transition written immediately; NEVER committed or staged — exclude it from every `git add`.
- Never: merge, mark PR ready, push base/trigger branch, force-push, delete branches. NEVER touch the repo default branch in any way.
- Never comment on or close issues directly; `Closes #N` in the PR body; partial fixes never auto-close.
- Every commit references its issue; every PR title references its issues; every PR body lists per-issue commit refs.
- Scoped verification only (changed files); NEVER build — a build regenerates shared artifacts (.next, version modules, caches) and collides with parallel agents in other worktrees; no dep installs, lockfile edits, repo-wide format/generate, port binds, or shared-cache writes under parallel agents.
- Worker blocker → mark blocked, continue elsewhere, surface at close-out; never work around, never stall.
- `skipped` persists across resumes unless the note explicitly retries; never respawn the same skip.
- Never idle while work exists; wait only on true dependencies.
- Never fabricate tool output; every state entry backed by a command run this session.
