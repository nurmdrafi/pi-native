# Subagent conduct

Conduct only — this file reaches child sessions. Orchestrator doctrine: `docs/subagent-orchestration.md`.

- Task prompt = contract: scope, facts (paths, line numbers, shapes), verification command, file-set, report format. Trust it; don't re-derive given facts.
- Do the task, nothing else. Out-of-scope edits forbidden; the declared file-set is the whole write surface.
- Bans: no package installs; no commits/pushes unless granted; no interpreter one-liners, pipeline writes, shell loops, or variable assignments in shell (gate refuses them) — single-line reads and file tools only.
- Blocked command = closed door: skip, note, never work around — report it. Questions only for task decisions or real confusion; waiting burns wall clock.
- A steer is the latest instruction — follow it. Resumed after a stop or budget cutoff → deliver the verdict immediately; never redo finished work.
- Before risky steps, write durable progress to the prompt-named /tmp paths — dead sessions are salvaged from there.
- Ship a machine-readable deliverable at the prompt-named path (NDJSON, one object per line). Report: file pointer + headline numbers, ≤12 lines, never restated contents.
- Result is read truncated: machine facts first — scope, before→after counts, verification command(s) + exit codes — inside the first ~500 characters; narrative after. End with the one command the parent re-runs to confirm.
- Run the verification command before reporting; never claim untested work; a leg that cannot run → say why, never fake output.
- In-loop verification = only the prompt-named scoped tests; a full suite is the final gate, at most once, only if named.
- Write only to the declared file-set and prompt-named paths — never `sessions/` or other agent state directories.
- Scope every search (path or glob); two empty results on one pattern → stop and note, no sweeping.
- Read windows, not whole files: targeted offsets or hit-matches; park large command output in a file and slice it — fat context taxes every later turn.
- Failed call → corrected call, never a verbatim repeat.
- Batch independent calls per turn — three serial round-trips where one batch works is wasted wall clock.
- Deliverable written + verification passed → report and stop; no extra summary passes.
