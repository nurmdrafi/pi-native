---
description: Standup — dash-only bullet report from nurmdrafi commits in Barikoi repos, commit message/body only
argument-hint: [repo-path ...]
---

Standup report from git history.

Scope:
- Repos: paths given as arguments; otherwise every git repo under `~/Barikoi` (its subdirectories) — never assume cwd. Only projects under the Barikoi org — verify `git remote get-url origin` matches barikoi (github.com/barikoi/*); skip everything else.
- Author "nurmdrafi" only — `git log --all --author=nurmdrafi`; never include others' commits.
- Window: yesterday 5 pm through today 5 pm — `--since="yesterday 17:00" --until="today 17:00"`.

Execution — one pass, read-only:
- One command over `~/Barikoi/*/`: verify each origin remote matches github.com/barikoi/*, then `git log --all --author=nurmdrafi --since="yesterday 17:00" --until="today 17:00" --pretty=format:'%h %s'` prefixed with the repo slug; skip repos with no hits. Subjects only — keep total output under ~40 lines / 2KB so nothing truncates or spills.
- A second command only if a subject is too vague for a feature-level summary: batch `git log -1 --pretty=format:%B <sha>` for just those shas.
- Never write, create, or delete any file — no temp files, no redirection to disk. No destructive commands of any kind (rm, kill, git reset/clean/checkout/push, branch deletion); everything read-only and straight to stdout.

Source of truth: commit subject + body only — no diffs, no files, no code, no branches.
Content: feature level only — state the feature and what was implemented; no file names, paths, component/module names, no technical jargon.

Output — strict:
- Every line starts with "-"; no headings, no bold labels, no intro or closing sentence.
- Merge related work aggressively — one bullet per meaningful change, trivial or duplicate commits folded in; maximum 10 bullets total for the window. If the cap forces a merge across repos, name both projects in the brackets.
- Plain action verbs; short sha prefix only when it helps.
- End each bullet with the project display name in square brackets, same for blockers: repo slug with separators as spaces, words capitalized, known acronyms uppercase (UBL, JTI, AKG, CNL, BKOI, MQTT, API, JS); then drop the generic words dashboard, frontend, backend, survey from the display name — e.g. `ubl-survey-dashboard` → `[UBL]`, `jti-dashboard` → `[JTI]`, `polar-backend` → `[Polar]`; if nothing would remain, keep the full name.
- Order: the window's work, then blockers (or "- No blockers").
- Print to terminal only; never create, write, or save any file.
