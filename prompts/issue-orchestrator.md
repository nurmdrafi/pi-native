---
description: Orchestrate a set of GitHub issues — input is issue number, link, state file, or nothing to continue; auto triage, group, spawn worker subagents, one draft PR per group; resumable; never merges
argument-hint: "[<issue-number | link | state-file>] [--base <branch>] [note]"
---

Trigger with args = authorization for: branch create/switch, commits, pushes to group branches, draft PRs. Human reviews + merges; agent never merges, never readies a PR, never pushes base or trigger branch.

## 0. Preflight
- `gh auth status` → fail: stop, report.
- Base branch: `--base` arg, else exact branch name in note verified via `git branch --list`, else state file, else `gh repo view --json defaultBranchRef` → persist in state; resume reads state, never re-asks.
- Record: `git rev-parse HEAD` · `git status --porcelain` (dirty tree → stop, report) · `git branch --show-current` = trigger branch.
- Detect once, reuse for all groups: toolchain pin (`.nvmrc`/`.python-version`/…), test/lint/typecheck commands, commit rules — locate `commitlint.config.*` (`fd commitlint.config`) and read types/scopes/length limits; pass them to every worker task. Never detect or run build.
- Input dispatch: state-file path arg → §2 resume from it · nothing/"continue" → `issue-orchestrator-state.md` at repo root: exists → §2 resume, missing → stop + ask for issues link · number/link → §1.

## 1. Seed + triage
- Seed set: given number/link → that issue plus one hop of references in body + comments (`#N`, issue/PR links — several issues often point at one tracker; include all, record chain in state). Only open issues of this repo — closed or foreign-repo refs noted in state, skipped; dedupe. Explicit "all issues" request → every open issue. Seed empty after expansion → report, stop.
- Fetch records: `gh issue list --state open --limit 300 --json number,title,body,labels,comments,createdAt,url`, filter to seed; gaps → `gh issue view <n> --json number,title,body,labels,comments,createdAt,url`.
- Per issue: number · title · module (`module:`/`area:`/`scope:` label if present, else `rg` the issue's named symbols → file paths) · type (bug/feature/chore/docs) · acceptance criteria (verbatim, derive only if missing, mark "derived") · dependencies (explicit "#N" refs, shared files).
- Note arg = constraints: exclusions override inclusion.

## 2. Resume + drift check (state file exists)
- Cross-check state vs live: `gh issue list --state open` · `gh pr list --state open,merged --json number,state,headRefName,url`.
- Recompute per issue: closed OR merged PR covers it → resolved, skip. Manually closed → drop. Open PR exists → keep waiting, no rework. Rest → pending.
- `blocked-waiting-merge` group: dependency merged → unblock, rebase group branch off base, continue; rebase conflict → keep `blocked`, reason = conflicting files.
- Args on resume may extend the note; never shrink already-executed scope.

## 3. Group + order
- Group by file/module ownership boundary, 3-8 issues per group. File overlap between groups → merge groups or run sequentially.
- Order: shared types/schema/config/migrations first → core modules → UI/integrations → docs/tests/cleanup last. High risk early, not last.
- Branches: `feat/|fix/|chore/<module>-<short-goal>`, one per group.
- Re-review pass before spawning: one clear outcome per group · no two groups share files · every seed issue in exactly one group · acceptance criteria present (derived marked) · violations fixed before the plan is written.
- Write full plan into state file. Commit on trigger branch. No approval stop — proceed.
- State schema: run header (base, note, seed chain) · per group: name, order, branch, PR URL · per issue: number, status ∈ `pending|fixing|in-review|pr-open|blocked-waiting-merge|blocked|skipped|done`, plus skip/blocked reason.

## 4. Execute (per group, in order)
- Group workspace: `git worktree add <worktree-dir> -b <group-branch> <base>` (branch exists → worktree on it, rebase off base; rebase conflict → mark `blocked`, reason = conflicting files, skip). Main checkout never leaves the trigger branch. Independent groups may run parallel — one worktree per group, never two agents in one worktree.
- Per issue in the group, sequential: spawn `worker` subagent (`agents/worker.md`) with the template below — one issue per spawn. On return: verify claims — diff exists, scoped tests actually run; never trust summary alone. Worker returns `SKIP: <reason>` → mark issue `skipped`, continue next.
- Review gate before push: freeze `git -C <worktree-dir> diff <base>...HEAD > /tmp/review-<group>.diff` → spawn `reviewer` subagent (`agents/reviewer.md`) on that diff file only — read-only, verdict `APPROVE | REQUEST_CHANGES`, numbered findings. Reviewer exits with `SKIP: <reason>` → group `blocked`, no push, continue.
- Fix loop: `REQUEST_CHANGES` → respawn worker with the numbered findings + diff path → re-freeze → reviewer again, max 3 rounds. `APPROVE` → push. Still `REQUEST_CHANGES` → push anyway, unresolved findings go into the PR body, status `blocked`.
- Push + PR: `git -C <worktree-dir> push -u origin <group-branch>` → `gh pr create --draft --base <base> --title "<type>(<scope>): <summary> #N #M" (same commitlint rules as commits) --body-file <tmp>`; body: Summary · `Closes #N` per issue · verification evidence · risks · unresolved findings if any → `git worktree remove <worktree-dir>`.
- Update state (`pr-open`|`blocked`, PR URL, timestamp) → commit on trigger branch.
- Group depends on unmerged upstream PR → mark `blocked-waiting-merge`, continue next independent group.

## Worker task template
```text
ROLE: solve issue #N in worktree <dir>, branch <branch>, base <base>.
SCOPE: <file list>; anything outside → ask_question, never edit.
Per issue: `gh issue view <n>` → defect site + callers → acceptance criteria verbatim → failing test → minimal fix → scoped lint/typecheck/tests (changed files only) → commit per the commitlint rules in this task; hook reject → fix the message, re-run to completion.
NEVER: push, create PR, merge, build, install deps, edit lockfiles, touch issue-orchestrator-state.md, leave the worktree, edit outside SCOPE.
RETURN: per issue — summary · files changed · verification output · risks. Blocker → ask_question immediately.
SKIP: anything confusing · backend dependency needed · risk beyond SCOPE → final message "SKIP: <reason>", stop immediately.
```

## 5. Close-out report
- Per group: issues · branch · PR URL · status.
- Blocked: issue/group · cause · proposed fix.
- Human next actions: review + merge in dependency order, then rerun this prompt to resume blocked groups.

## Rules
- Full auto after trigger: no approval stops; plan lands in state file, execution starts immediately.
- One PR per group, always draft; PR = review unit, never per-issue PRs.
- State file = live tracker: single writer = orchestrator, edit only on trigger branch, never on a group branch. Every transition — issue start → `fixing` → `in-review` → `pr-open|blocked|skipped|done`, group blocked/unblocked, skip reason, worker/reviewer verdict — is written and committed immediately; never batched at close-out.
- Never: merge, mark PR ready, push base/trigger branch, force-push, delete branches.
- Never comment on or close issues directly; `Closes #N` in the PR body closes them on merge.
- Scoped verification only (changed files): lint/typecheck/tests. NEVER build or anything conflicting with parallel subagents: no dep installs, lockfile edits, repo-wide format/generate, port binds, shared-cache writes.
- Worker blocker → mark blocked in state, continue elsewhere, surface at close-out; never work around, never stall the batch.
- Any subagent may self-terminate (`SKIP: <reason>`) on confusion, backend dependency, or risk — orchestrator records the reason, never respawns the same skip; `skipped` persists across resumes unless the note explicitly retries.
- Never fabricate tool output; every state entry backed by a command run this session.
