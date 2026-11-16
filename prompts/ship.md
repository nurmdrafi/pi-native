---
description: Ship — conventional commit from session context, push, no re-reads
---

Commit message from session context — no `git diff/status/log`, no hook/config pre-reads; fix only on hook reject. Format: `type(scope): imperative summary`; body a multi-line list of `-` bullets, one per change, ≤100 chars/line, no `#` character anywhere.

One command: `git add <exact paths> && git commit -m "<subject>" [-m "<body para>"…] && GIT_TERMINAL_PROMPT=0 git push`, then report `<short-sha> <subject> → pushed to <branch>`. Body ≤100 chars/line (convention).

Hook reject → fix + re-run to completion; never print message + stop. Gates pass (doc:check, lint, typecheck, scoped tests) → commit and push without waiting for approval. A failing gate, or a change the user has not seen → message-only in code block, stop.
