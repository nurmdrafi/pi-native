---
description: Update CHANGELOG.md from session context — arg version wins, else auto-bump major.minor.patch
argument-hint: "[version]"
---

Target version: ${1:-none}

`none` → derive. Placeholder text on the target line → take version from the invoking message; absent → derive.

Source: session transcript only; no `git log`/`git diff`, no codebase reads. Allowed: CHANGELOG.md head (15 lines), `rg -n '^## \[' CHANGELOG.md` + matched section, `git status --porcelain`.

Version given: use verbatim, never bump. Section exists → append, never rewrite. Not exists → new `## [X.Y.Z] - <date>` below header, above newest.

No version: bump newest once — MAJOR breaking / MINOR feat / PATCH fix; uncommitted section present → continue it. Never bump twice pre-commit.

Format: mirror newest section style; empty changelog → Keep a Changelog (Added/Changed/Deprecated/Removed/Fixed/Security). Skip empty sections.

Bullets: one per user-visible change, ≤2 lines, what not how. No history, no I/we, no emoji.

End: `[X.Y.Z] <reason> — N entries (sections) → CHANGELOG.md`
