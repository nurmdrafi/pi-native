---
description: Merge-readiness review of open PRs — validate AC delta, blast radius, verification evidence, base drift and conflict forecast; read-only verdict, never merges
argument-hint: "[<pr-number | url> …] [note]"
---

Read-only: review PRs and report. NEVER merge, ready, push, force-push, close, comment on PR or issue, or edit any file. Findings go to the user; fixes return to the implementer lane in a follow-up turn — never self-fix on the PR branch mid-review.

## 0. Dispatch + gather
- Args: PR number(s)/URL(s) → exactly those. Nothing → every open PR of this repo, ascending PR number (the orchestrator's stacked set opens in `seq` order, so ascending number = merge order). Note arg = constraints; exclusions override inclusion.
- Per PR, record before judging: `gh pr view <n> --json number,title,body,headRefName,baseRefName,commits,isDraft,mergeable` · `gh pr diff <n> > /tmp/pr-<n>.diff` (frozen; every later check cites this file) · linked issues' acceptance criteria (`gh issue view`, creator comments included — they amend criteria) · base tip `git rev-parse origin/<base>` · merge-base `git merge-base origin/<base> origin/<head>`.
- Dirty tree → review from origin refs only, never the working tree.

## 1. Merge blockers (checked first, in order)
- Double delivery: changes already in base — the PR's key hunks present at the base tip (`git diff origin/<base>...origin/<head>` then `rg` the head's central changes against base) → report `contained` — the PR merges empty or duplicates; never assume the branch-vs-base diff is the real delta. A group branch previously merged into base locally is exactly this failure.
- Conflict forecast: base moved since merge-base → `git merge-tree --write-tree origin/<base> origin/<head>` names conflicted files without touching any checkout. Per conflicted file, state both sides' intent in one line. Conflicts are NOT a verdict — they are a merge-time task list for the human or implementer.
- Dropped-side check: any conflict-resolution merge commit on the branch (`git log --merges origin/<base>..origin/<head>`) → diff its result against BOTH parents on the conflicted files; each side's surviving intent must be visible. A merge whose result matches one parent wholesale on a conflicted file is a blocker — silent data loss, found later as repair commits.
- AC delta: the PR body must LEAD with a per-issue table — one line per acceptance criterion, verbatim, status `met | partial | skipped`, evidence `path:line`. Missing table, or a criterion absent from body and diff alike = blocker. Validate every `met` claim against the code at the PR head (`rg` the criterion's symbols in the diff's files) — a body claim is not evidence. Every `partial | skipped` names why (business risk, business-rule conflict) — business-logic criteria are named exactly that way, never softened to edge case or out of scope.
- Blast radius: the body states what MUST change vs what MUST NOT change (files, user-visible behavior, UI/copy, business rules). Any diff touch outside it — UI/UX, copy, business rules, user behavior — is a numbered finding. A UI-bearing diff with no visual evidence (screenshot path or recorded ui-verifier verdict) does not pass.

## 2. Evidence + hygiene
- Verification evidence: body lists exact commands + exit codes, scoped/impact-selected only (changed files → their test files and direct importers). Re-run impact-selected tests + typecheck against the frozen diff yourself — one shot, timeout-wrapped, output redirected. NEVER run the full suite or any build — that is CI's job; a body claiming full-suite runs locally is itself a finding (parallel-agent hazard).
- Commits: commitlint-shaped subjects, every commit references its issue; body lists one line per commit (`#N: subject (short-sha)`); `Closes #N` only when every criterion is `met` — partial work says "partially addresses #N, do not close".
- Stack sanity: branch contains earlier-sequence groups' commits (stacked) → each PR's own delta must stay its own group — verify with `git diff <predecessor-branch>...origin/<head>`; a later PR whose delta swallows an earlier PR's changes means merge order was broken — report the correct ascending chain.

## 3. Verdict
- Per PR, machine facts first: `#n · head · base moved Y/N · merge-tree conflicts <files> · AC met/partial/skipped <a/b/c> · tests+typecheck exit codes`. Then verdict `APPROVE | REQUEST_CHANGES` with numbered findings in priority order: blockers (§1) first, blast-radius breaches, then nits. Every finding carries `path:line` from the frozen diff.
- Scale to the diff: large or subjective diffs → `reviewer` on `/tmp/pr-<n>.diff`; per-criterion re-checks → `verifier`; rendered UI → `ui-verifier`; auth/secrets/validation in the diff → `security-reviewer`. Small machine-checkable diffs stay inline. Review-only work never goes to `worker`.
- Close with the merge plan: ascending PR numbers, per-PR one-line summary, expected conflict tasks if any, and every business-logic decision parked for the user — one batched question, never a guess.
