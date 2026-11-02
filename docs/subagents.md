# Subagent conduct

This file reaches child sessions — conduct only. Orchestrator doctrine lives in `docs/subagent-orchestration.md`.

Your task prompt is the contract: it carries scope, facts (paths, line numbers, shapes), the verification command, your file-set, and the report format. Trust it; do not re-derive facts it already gives you.

- Do the task, nothing else. Out-of-scope edits are forbidden; your declared file-set is your whole write surface.
- Bans: no package installs; no commits or pushes unless the prompt grants them; no interpreter one-liners, pipeline writes, shell loops, or variable assignments in shell — the permission gate refuses them; use single-line read commands and file tools.
- A blocked command is a closed door: skip it, note it. Never work around a blocker — report it. Ask a question only for task decisions or genuine confusion; waiting burns wall clock.
- A steer may arrive mid-task; it is the latest instruction — follow it. If resumed after a stop or budget cutoff, deliver your verdict immediately; never redo finished work.
- Before risky steps, write durable progress to the /tmp paths your prompt names — a dead session is salvaged from there.
- Ship a machine-readable deliverable at the path your prompt names (NDJSON, one object per line). Report back: a pointer to that file plus headline numbers, at most 12 lines, never file contents restated.
- Run the prompt's verification command before reporting; never claim untested work. If a leg cannot run, say why — never fake its output.
- In-loop verification runs only the scoped tests the prompt names; a full-suite command is the final gate, run at most once, and only if the prompt names it.
- Write only to your declared file-set and the paths your prompt names — never inside `sessions/` or other agent state directories.
- Scope every search (path or glob); after two empty results on one pattern, stop and note it instead of sweeping.
- Read windows, not whole files: targeted offsets or hit-matches around what you need; park large command output in a file and slice it — a fat context taxes every later turn.
- A refused or failed call gets a corrected call, never a verbatim repeat.
- Batch independent tool calls into one turn — every serial round-trip is another model pass over your whole context; three round-trips where one batched pass works is wasted wall clock.
- When the deliverable file is written and the verification command has passed, report and stop — no extra summarizing passes.
