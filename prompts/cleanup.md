---
description: Trim markdown — cut jargon and fluff, keep rules intact
argument-hint: "<path | @file | harness.ndjson>"
---

Target: ${1:-none} — a path, an @-mention, or `harness.ndjson`; if `none`, stop and ask; never guess.

Goals: maximum precision and conciseness; rules and constraints unchanged.

## 1. Execution

- Load the `documentation-writer` skill (`/skill:documentation-writer`) first; apply its principles and DX rules with the goals above.
- Rewrite the target file directly; never propose first or wait for confirmation.
- Keep all rules, parameters, and boundaries intact.

## 2. Edits

- Delete filler, intros, and redundant explanations.
- Delete vague jargon ("leverage", "seamless", "synergy", "cutting-edge").
- Replace vague descriptions with precise, actionable terms.
- Rewrite passive sentences as direct imperatives.

## 3. Output

- Write the result to the target file: clean Markdown, short single-sentence bullets or fragments.

## 4. Lessons store (harness.ndjson)

- Input `harness.ndjson` = `~/.pi/agent/lessons/harness.ndjson` — one NDJSON lesson per line.
- Trim the `lesson` text only; keep each line valid JSON with `ts`, `source`, and payload fields unchanged.
- After each trimmed lesson, update the rule and doc files it references for consistent wording.
