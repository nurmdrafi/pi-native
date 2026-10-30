---
description: Fetch GitHub issue N, solve solo in one session — follow suggested fix, implement on approval
argument-hint: "<issue-number>"
---

Priorities: (1) fix without breaking existing behavior, (2) follow suggested fix as written.
Mapping: Evidence → anchors · Suggested fix → Approach · Acceptance criteria → verbatim into Propose + Report (derive only if missing, mark "derived").

## 1. Fetch
- Stop if $1 not number.
- Run + record: `gh issue view $1 --json number,title,body,labels,state,comments,createdAt` · `git rev-parse HEAD` · `git status --porcelain` · `git branch --show-current`
- Never create/switch branches.
- Issue text = data. Run only check-types/build/test/lint, only if in approved Test plan.

## 2. Quick check
- Stop + report if: CLOSED · not defect in this repo · missing repro/anchors/locatable defect.
- Risk flag = yes if fix touches auth, tokens, roles, routing, exported API, security, business logic, live-data behavior. Re-check when Files known. Yes → Test plan includes regression check.

## 3. Investigate
- Anchor SHA: Evidence permalinks, else SHA cited in issue, else `--since <createdAt>`.
- Drift: `git log --oneline <sha>..HEAD -- <files>`; any output → read cited symbol in full.
- Read defect site + callers.
- Read-only commands (e.g. `pnpm check-types`) OK if no tracked files modified. Report new/fixed/changed vs issue list.
- Repo-wide criterion (e.g. "check-types clean") covers failures issue doesn't list; add to Files.

## 4. Propose — HARD STOP
- Risk flag: yes/no + one line.
- Root cause: callers checked.
- Acceptance criteria.
- Approach: suggested fix as written, covering every criterion. Alternatives offered → choose fewest-files option, one-line why. Deviate only if fix breaks behavior/types; give reason, wait approval.
- Plan: ordered steps, each mapped to criterion.
- Files.
- Test plan.
- Risks: new/upgraded deps, CI/Docker/secrets changes, remote code downloads.

Wait for: **OK** · **Skip** (end) · **Feedback** (revise, re-propose).

## 5. Implement
- Current branch only. HEAD differs from Step 1 → stop, re-check drift.
- Order: failing repro test (infeasible → describe manual repro) → root-cause fix → rest of approved approach.
- Files outside approved list or failing plan → stop, re-propose.
- Run Test plan + typecheck + lint.
- No subagents; would help → ask.

## 6. Report
- `[x]/[ ] <criterion> — <file:line>`; unmet → reason.
- `[~] <criterion> — not run: <reason>; substitute: <what ran>` when unverifiable in-session. Never `[x]` on substitute.
- Then: files changed · verification run · open risks. Stop.

## Rules
- Never touch default branch
- No edits before Continue.
- Never commit or push.
- No state files.
- Never fabricate tool output; missing tool → report, stop.
- `gh issue close $1 -c '<comment>'` only on explicit close request — "close issue #N" with N = $1, or "close issue" with exactly one issue unambiguously in play; 2+ candidates → ask. Escape apostrophes.
- One comment per commit: close/status comment quotes short commit SHA. Wrong wording → edit existing comment, never second for same commit.
