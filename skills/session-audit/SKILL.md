---
name: session-audit
description: >
  Audit pi agent session logs (~/.pi/agent/sessions) for token/cost waste and
  produce a ranked, attributed efficiency report (habit / skill_file / config).
  Use when the user asks to audit session efficiency, analyze token waste or
  cost blowups, review usage cost, or asks "where are my tokens going".
disable-model-invocation: true
---

# Session-Audit (pi)

You = reasoning layer (L2/L3) of layered audit engine. Deterministic scripts (L0/L1) digest raw session logs into metadata-only artifacts; you reason over aggregates, escalate to content only via budget-capped fetch interface.

`<skill-dir>` = this skill's directory (`location` attribute on injected skill tag; normally `~/.pi/agent/skills/session-audit`). Set workdir once:

```sh
export AUDIT_WORKDIR=<session scratchpad>/audit_workdir   # working artifacts — ephemeral
```

## Two lifetimes

JSON artifacts = intermediates, ephemeral workdir. **Report = deliverable, must outlive session** — dated file in stable archive:

```sh
mkdir -p ~/.pi/agent/audit-reports
# final report -> ~/.pi/agent/audit-reports/<YYYY-MM-DDTHHMMSSZ>.md
```

Past reports = only way to answer "am I improving?": trend comes from comparing today's report to archive, not data layer.

## Invariants (non-negotiable)

- (I1) **Never read raw session JSONL directly** (no read/cat/grep on `~/.pi/agent/sessions/**/*.jsonl`). All access via `run` + `fetch`.
- (I2) Metadata by default; fetch content only to resolve specific hypothesis, `--max-bytes ≤ 2000`, ≤~10 fetches/audit.
- (I3) Waste math never trusts raw `input` token sums (streaming placeholders). Anchor on `cacheRead`, `cacheWrite`, content bytes.
- (I4) All aggregation deduped by `responseId` (scripts do it — never hand-roll parsing).
- (I5) No side effects outside `$AUDIT_WORKDIR` and the report path.
- (I6) Log every fetch to `$AUDIT_WORKDIR/fetch_log.jsonl` — self-cost is part of the report.
- (I7) Scripts are read-only over sessions; never edit them mid-audit (running from installed bundle).

Relative target words ("current repo", "previous session", "recent") ambiguous: each retarget orphans every call spent on prior reading (measured: ~25% of audit `2026-10-10T121209Z`). Relative request → ask once, wait:

- Target — which repo/project, or session id?
- Window — last 1 / last N / date range / whole project?
- Depth — numbers only (L0/L1, no verdicts) or full audit (L2/L3 + report)?
- Output — archived report or chat summary?

One cheap ask beats rerun. Bare "yes" ≠ scope — re-ask. Confirmed → run cheap: `run --max 50` when target recent (single session/last day), `views --project <name>` directly instead of global view (capped global output forces spill-file re-reads).

## Phase 0 — Digest (L0 + L1, zero LLM)

```sh
node <skill-dir>/scripts/audit.mjs run            # full directory
node <skill-dir>/scripts/audit.mjs run --max 50   # quick pass, newest 50 sessions
```

Writes to `$AUDIT_WORKDIR`: `manifest.json` (thresholds + `pricing`: per-model input rates derived from logged `usage.cost`, unpriced models, priced waste share), `l1_findings.json` (rule findings: `{rule, severity, sessionId, turnPointers, evidenceStats, estWasteTokens, project}`), `overview.json` (aggregates: `projects`, `tools`, `models`, `gapBuckets`, `dates`, `skills`, `sessions` by waste). Per-session/per-project rollups carry `wasteUsd` + `wasteTokens`, `models`, `usdPerMTok`, `pricedShare`, `compactions`.

Rules: `CACHE_TTL_EXPIRY`, `DUP_TOOL_CALL`, `BIG_TOOL_OUTPUT`, `RETRY_STORM`, `CACHE_MISS_RATE`, `CONTEXT_GROWTH`.

## Phase 1 — Aggregate landscape

**User names target (project/path/session) absent from digest → stop, ask.** Never substitute closest match; wrong-target audit wastes entire run, reports confidently about wrong code. Includes targets excluded as active: report exclusion, ask inspect-via-fetch / audit-after-close / different target — user decides, not auditor.

```sh
node <skill-dir>/scripts/audit.mjs views
node <skill-dir>/scripts/audit.mjs views --project <name>   # per-project slice: sessions, finding detail, per-date trend
```

Confirmed scope = single project/session → slice with `views --project <name>` first; global view only for directory-wide questions.

One bounded block: totals (tokens + dollars), findings-by-rule with sessions-affected count, cache hit-ratio distribution, projects + worst sessions by waste (full session ids + `fetch` command to inspect one), idle-gap cost curve, tools by bytes, dup-read targets, BIG_TOOL_OUTPUT by tool, peak-context + compactions, per-date trend, skill usage.

Never read `overview.json`/`l1_findings.json` wholesale (>100KB); never hand-roll node one-liners for anything `views` prints — every query + output lands in transcript = audit's real self-cost.

**Missing stat → say so in report — never add to `views.mjs`.** Running from installed bundle (I7). Record gap under "stats this report wanted and could not get"; human ports it to repo. Missing stat blocks specific claim → single narrow query acceptable — state in report you ran it; transcript cost real + unlogged.

Two traps the view prevents:

- **Finding counts ≠ population counts.** Every rule has entry gates — `CACHE_MISS_RATE` needs ratio < 0.5 *and* ≥5 turns — so "1 finding" never means "1 session with that property". Read distribution block, never rule count.
- Raw vs cost-equivalent tokens. `gapBuckets.cacheCreation` raw; rule waste cost-equivalent (`creation × (write − read)`). View prints gap curve in both units. Compare like with like before claiming corroboration.

## Phase 2 — L2 hypothesis loop

1. From landscape, form candidate patterns. Recurring high-value:
   - TTL expiry after idle gaps (check `gapBuckets` — cost per resume vs `lt_1m` baseline)
   - large-file re-read loops (DUP + BIG on `read`/`bash` same sessions)
   - marathon sessions near context ceiling
   - compaction-heavy sessions
   - unbatched round-trips (many single-tool turns)
   - image-heavy low-cache sessions.
2. Confirm/dismiss with narrower queries over per-session `findingsByRule` + finding details.
3. Metadata can't resolve intent → escalate with fetch:

```sh
node <skill-dir>/scripts/audit.mjs fetch <session-id> --kind <kind> [--limit N] [--max-bytes B] [--uuid U] [--radius K]
```

| kind | returns | judge |
|---|---|---|
| `user_text` | user messages (skill injections excluded) | intent vs agent behavior |
| `error_head` | head of errored tool results | transient vs deterministic failure |
| `tool_input` | tool call params | which file/command duplicated |
| `assistant_head` | head of assistant text | verbosity / narration |
| `turn_window` | metadata around `--uuid` responseId | sequence reconstruction |

4. Write `$AUDIT_WORKDIR/l2_hypotheses.json`:

```json
[{ "pattern": "NAME", "evidence": ["stat or fetch ref", "..."], "confidence": "high|medium|low",
   "escalation_fetches": ["..."], "resolution": "resolved|escalate", "interpretation": "one sentence" }]
```

## Phase 3 — L3 attribution

Reason over hypotheses + fetched snippets only. Write `$AUDIT_WORKDIR/attribution.json`, ranked by waste:

```json
[{ "rank": 1, "finding": "...", "attribution": "habit|skill_file|config",
   "estWasteShare": "~N% (xK of yK)", "trend": "improving|worsening|steady",
   "fix": "concrete behavior change, named skill edit, or config change" }]
```

Attribution guide: **habit** = working style (resuming big sessions after breaks, inline scanning, whole-file re-reads, unbatched commands); **skill_file** = named skill drives pattern (which SKILL.md + what to change — instructions made agent read too much, or description fires it on wrong tasks); **config** = model default, thinking level, AGENTS.md/skill-catalog bloat (permanently re-sent prefix), provider cache behavior.

## Phase 4 — Report

Write `~/.pi/agent/audit-reports/<YYYY-MM-DDTHHMMSSZ>.md` (create dir if absent). Timestamp: `date -u +%Y-%m-%dT%H%M%SZ` (UTC, second-precision).

Required content (header, totals, findings-by-rule with sessions-affected, per-project breakdown, ranked fixes, do-this-first pick, trend, self-cost) + two-version ASCII chart format: [references/report-format.md](references/report-format.md).

Then summarize top 3 changes in chat, in user's own context, say where report saved.

## Interpretation notes

- `CONTEXT_GROWTH` carries zero direct waste — amplifier of everything else in session. Compaction counts same way: compaction re-sends summary in place of prefix; cost not separately priced.
- `CACHE_TTL_EXPIRY` findings carry `evidenceStats.gapKind`. Only `user_idle` gaps priced as waste; `tool_runtime` gaps reported zero by design — wait was long-running command, not habit. Check `gapKind` before calling TTL finding a habit.
- Rank by prefix persistence: early, long-riding costs beat late one-offs same size.
- Dollars priced per session from own model mix (rates derived from sessions' own logged `usage.cost`) — token ranking + dollar ranking can legitimately disagree. When they do, dollar order = one to act on; call it out.
- `DUP_TOOL_CALL` on `read` was path-keyed in pre-2026-10-10 digests (normalizer dropped `offset`/`limit`) — before attributing read dup as waste, fetch `tool_input`, compare windows: disjoint windows = continuation reads, not dups. Keying fixed for `read` 2026-10-10 (same class as 2026-09-14 `edit` fix); old reports + archived digests still carry false positives.
- Peak context can exceed 200K on large-context models; not a bug.
- Healthy directory (hit ratio >0.95, near-linear growth) → short report saying so; never manufacture findings.
