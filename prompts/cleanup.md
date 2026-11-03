---
description: Trim markdown — cut jargon and fluff, keep rules intact
argument-hint: "<file> | harness.ndjson"
---

Goals: (1) maximum precision and conciseness, (2) rules and constraints unchanged.

## 1. Execution`

- Rewrite the target file directly; never propose first or wait for confirmation.
- Keep all rules, parameters, and boundaries intact.

## 2. Edits

- Delete conversational filler, intros, and redundant explanations.
- Delete vague jargon ("leverage", "seamless", "synergy", "cutting-edge").
- Replace vague descriptions with precise, actionable terms.
- Rewrite passive sentences as direct imperatives.

## 3. Output

- Write the result back to the target file: clean Markdown, short single-sentence bullets or fragments.

## 4. Lessons store (harness.ndjson)

- Input `harness.ndjson` targets `~/.pi/agent/lessons/harness.ndjson` — session lessons, one NDJSON object per line.
- Trim the `lesson` text; keep each line valid JSON with `ts`, `source`, and payload fields unchanged.
- After each trimmed lesson, update the associated rule and doc files it references so wording stays consistent.
