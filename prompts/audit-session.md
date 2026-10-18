---
description: Audit the running session — blocked calls, rule-understanding gaps, approach validation; inline report
---

Scope: the running session only (all its compacted forks). Evidence: the transcript already in context + gate telemetry. Do NOT run digest/views scripts — they exclude active sessions by design. Do not re-read session files.
Mode: read-only. Budget: ≤8 tool calls total, then report inline, ≤50 lines.

## 1. Blocks (telemetry: ~/.pi/agent/logs/violation-memory.ndjson)
- Current sid = sid of the newest adoption record. Sid is process-scoped and over-counts across sessions — attribute only blocks the transcript corroborates.
- Per block this session: family · rule text that should have prevented it (quote `file:line`) · classification: habit-override | rule-ambiguous | rule-missing.
- Report blocks/native-calls for the visible turn window only.

## 2. Approach
- Anomalous calls only (blocked, retried, duplicated, unused result) — no full per-call table, no per-call tagging.
- Cheapest sufficient path taken? Name the detours, if any.

## 3. Report
- Verdict: PASS · PASS WITH GAPS · NEEDS IMPROVEMENT · FAIL (FAIL = gate bypass or fabricated evidence).
- Findings by severity, evidence attached; hypotheses labelled as such.
- Fixes: rule rewrites only where classification is rule-ambiguous or rule-missing. Behavioral gaps (habit-override) get one line of coaching, not rule edits.

## Rules
- Never invent calls or violations. Telemetry absent → UNVERIFIABLE, never PASS.
- No edits, commits, or settings changes — report only.
