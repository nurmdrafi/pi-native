---
description: Ship — conventional commit from session context, push, no re-reads
---

Commit message from session context — no `git diff/status/log`, no hook/config pre-reads; fix only on hook reject. Format: `type(scope): imperative summary`, body only when needed.

One command: `git add <exact paths> && git commit -m "<subject>" [-m "<body para>"…] && GIT_TERMINAL_PROMPT=0 git push`, then report `<short-sha> <subject> → pushed to <branch>`. Body ≤100 chars/line (convention).

Hook reject → fix + re-run to completion; never print message + stop. Commit not asked for → message-only in code block, stop.
