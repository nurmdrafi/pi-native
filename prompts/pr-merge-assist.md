---
description: Merge-assist for issue-associated PRs — validate AC and business rules, resolve merge conflicts, one bounded fix round, then merge in order and close associated issues; blockers and business-logic doubt stop the merge, never guessed past
argument-hint: "[<pr-number | url> …] [note]"
---

Two phases with one gate between them: review is read-only by nature; resolution, merge, and issue-closure EXECUTE — but only on this trigger, only after the review passes. NEVER force-push, rebase, or rewrite a pushed branch (append-only commits); never merge past an open blocker, a red gate, or an unruled business-logic decision; never guess.

## 0. Dispatch + gather

- Scope: PRs associated with GH issues only — a linked issue, an `#N` ref in title or body, or the orchestrator footer/AC table. A PR with no issue association → skip with a one-line reason, no review, no merge; the note may name it explicitly to override.
- Args: PR number(s)/URLs) → exactly those (association gate still applies). Nothing → every open issue-associated PR of this repo, ascending PR number = merge order. Note arg = constraints: exclusions override inclusion; it may set the merge method (`--squash`/`--rebase`, default `--merge`), allow `--delete-branch`, waive red CI explicitly, or restrict to review-only.
- `git fetch origin --prune` — remote refs only until the merge step.
- Per PR, record before judging: `gh pr view <n> --json number,title,body,headRefName,baseRefName,commits,files,isDraft,mergeable` · `gh pr diff <n> > /tmp/pr-<n>.diff` (frozen; every later check cites this file) · linked issues' acceptance criteria (`gh issue view`, creator comments included — they amend criteria) · base tip `git rev-parse origin/<base>` · merge-base `git merge-base origin/<base> origin/<head>`.
- Orchestrator footer: `<!-- orchestrator: base=… head=… gate=… stack=… -->` in the body marks an orchestrator PR. Absent → not an orchestrator PR; footer, skipped-table, and flat/stack checks are n/a.
- Re-review (footer `head` ≠ current head, or the PR was reviewed earlier this session): commits after the footer `head` came from fix mode or the human. Review `<footer-head>..origin/<head>` as the delta, re-validate every AC row those commits touch, and still run §1 on the whole PR — base may have moved. Report "since last handoff" in the verdict.
- Dirty tree → review from origin refs; the resolve/merge phases require a clean tree (stop, report).

## 1. Merge blockers (checked first, in order — any open blocker stops the merge)

- Double delivery: changes already in base — the PR's key hunks present at the base tip (`git diff origin/<base>...origin/<head>` then `rg` the head's central changes against base) → report `contained` — the PR merges empty or duplicates; never assume the branch-vs-base diff is the real delta.
- Conflict forecast vs base: `git merge-tree --write-tree origin/<base> origin/<head>` names conflicted files without touching any checkout. Conflicts are merge-TIME TASKS for §2, not verdicts.
- Conflict forecast across open PRs: for each pair whose changed files overlap (`files` from `gh pr view`), `git merge-tree --write-tree origin/<headA> origin/<headB>` → name files, both sides' intent, and the ascending-PR-number merge order that makes the later PR the resolver.
- Dropped-side check: any conflict-resolution merge commit on the branch (`git log --merges origin/<base>..origin/<head>`) → diff its result against BOTH parents on the conflicted files; each side's surviving intent must be visible. One-parent-wholesale = blocker (silent data loss).
- AC delta: the body LEADS with a per-issue table — one line per criterion, verbatim, status `met | partial | skipped`, evidence `path:line`. Missing table, or a criterion absent from body and diff alike = blocker. Validate every `met` claim against the code at the PR head (`rg` the criterion's symbols in the diff's files) — a body claim is not evidence. Every `partial | skipped` names why; business-logic criteria are named exactly that way ("business logic", "business rule", "client requirement"), never softened.
- Business-rule check: every criterion stamped `met` is also checked AGAINST the governing business rule — code may satisfy the letter of a criterion while violating the rule it serves (`rg` the rule's constants/guards at the touched sites). A contradiction = parked decision, merge blocked on that issue until the user rules; the ruling options are fix-the-code, amend-the-issue-AC, or accept-as-is — recorded verbatim in the report.
- Issue accounting (orchestrator PRs): every issue in title, body, and linked set appears exactly once — solved in the AC table or listed under Skipped issues; a missing one = blocker. Each skipped issue carries category · reason · unblocks when · `Next`. `Closes #N` only where every criterion of N is `met`.
- Clean drop: files or symbols unique to a skipped issue showing hunks in the diff = blocker (half-dropped work).
- Blast radius: the body states what MUST change vs what MUST NOT change. Any diff touch outside it — UI/UX, copy, business rules, user behavior — is a numbered finding. A UI-bearing diff with no visual evidence (screenshot path or recorded ui-verifier verdict) does not pass.
- Unrequested behavior change: the diff alters a default, error handling, exported API shape, rendered output, or copy that no criterion names → numbered finding with `path:line`.

## 2. Resolve (executes on this trigger, per PR, in merge order)

- Conflicts: `git worktree add <dir> <branch>` tracking origin → `git merge origin/<base>` → resolve hunk-by-hunk so BOTH sides' intent stays visible (dropped-side rule) → scoped tests + typecheck on the conflicted files → plain `git push` (never force). Too entangled → stop, report, that PR does not merge. Worktree removed after.
- Findings and unmet criteria: ONE fix round on the PR branch — append-only commits, each referencing its issue, scoped verification (impact-selected tests + typecheck + lint); re-review only the fix delta. Still failing → that issue keeps its finding, merge stays blocked on it; no second round, no loops.
- Parked decisions: business-logic contradictions and judgement calls go to the user as ONE batched question; never guess, never merge past an unruled decision.
- Gate before merge: lint + typecheck + the FULL test suite on the final head — this lane is the ONLY one that runs the full suite, once, right before merge (single worktree, no parallel agents); fix rounds stay scoped/impact-selected · `gh pr checks` — red CI blocks the merge unless the note explicitly waives it; pending checks are waited on only at this point, once.

## 3. Merge + close (per PR, ascending PR number)

- Preconditions, all required: no §1 blocker open · verdict APPROVE after any fix round · §2 gate green · every parked decision ruled.
- Draft PR → `gh pr ready <n>` first.
- Merge: `gh pr merge <n> --<method>` (method from note, default `--merge`; `--delete-branch` only when the note asks). Rejected → fetch, merge, retry once, else stop and report.
- Issues: after the merge lands, verify closure — merged into the default branch, `Closes #N` auto-closes; confirm with `gh issue view <n> --json state`, and for any still-open associated issue whose criteria are fully met, `gh issue close <n> --comment "<evidence + PR link>"`. Non-default base: issues stay open until the base lands — report exactly that, close nothing prematurely.
- Between merges: after each PR merges, re-run the §1 conflict forecast for the remaining PRs against the moved base and already-merged siblings — report refreshed conflict tasks before the next merge.
- Report: per PR — merged SHA or blocked-reason · full-suite + typecheck + lint exit codes · issues closed/parked/still-open and why · refreshed conflict map for what remains · next actions.

## 4. Verdict + scaling

- Per PR, machine facts first: `#n · head · base moved Y/N · merge-tree conflicts <files> · cross-PR conflicts <#m files> · AC met/partial/skipped <a/b/c> · skipped issues <n> · gate sha = head Y/N · tests+typecheck exit codes · CI <green/red/pending>`. Then verdict `APPROVE | REQUEST_CHANGES` with numbered findings in priority order: blockers (§1) first, blast-radius breaches, then nits. Every finding carries `path:line` from the frozen diff. REQUEST_CHANGES = merge blocked; §2 runs only on APPROVE (or after its one fix round).
- Scale to the diff: large or subjective diffs → `reviewer` on `/tmp/pr-<n>.diff`; per-criterion re-checks → `verifier`; rendered UI → `ui-verifier`; auth/secrets/validation → `security-reviewer`; conflict resolution in a worktree → `worker` with the files[] scope. Small machine-checkable diffs stay inline — no agent spawn for them.
- Close with the merge plan: ascending PR numbers, per-PR one-line summary, conflict tasks resolved or remaining, issues to close or parked for the user — one batched question where a human decision is needed, never a guess.
