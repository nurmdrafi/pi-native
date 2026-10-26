---
name: harness-engineer
description: >
  Inspect, audit/score, and improve THIS pi harness — AGENTS.md budget, skill
  catalog, token efficiency, portability, prompt anti-patterns (emphasis
  boosters, verification rituals, stale examples, contradictions, dated
  configs, secret hygiene). Use when: "audit harness", "anti-pattern audit",
  "audit my skills/prompts/extensions", "health score", "trim skills",
  "improve the harness", or the harness feels bloated.
disable-model-invocation: true
---

# Harness Engineer

Make harness leaner, more cache-stable, fully portable (macOS+Linux). Evidence over opinion. Prefer deletion + lazy-loading.

## Non-negotiable principles

1. Minimal core — delete before add. Never bloat permanent prefix.
2. Cache sacred — system prompt + tool defs + AGENTS.md + skill *descriptions* byte-stable per session. Fresh session after prefix changes.
3. rg first — code navigation via `rg`. Bash only for real side-effects (tests, builds, git, pkg managers).
4. Progressive disclosure — skills expose name + description only; bodies load on demand.
5. Portability — no absolute user paths in functional files (`~`/`$HOME` only). No unguarded OS-only commands. No pi env vars for config location (default `~/.pi/agent`).
6. Never move permanent behavioral rules out of `AGENTS.md` into skills.

## Snapshot loop (mandatory)

Before any edit + at end, capture:

```sh
wc -c ~/.pi/agent/AGENTS.md
# skill count + description byte sizes
ls ~/.pi/agent/prompts/*.md 2>/dev/null | wc -l
# portability hits (check below)
```

Report BEFORE → AFTER every field. No improvement claim without number.

## Scope

- `~/.pi/agent/` (+ project `.pi/`): `AGENTS.md`, `settings.json`, `models.json`, skills, prompts
- `README.md`, `CHANGELOG.md`, `audit-reports/skills/skills-audit.md` — living map; re-read before any change

`README.md` missing → create minimal first.

## Audit mode

One skill = full loop: inspect → audit/score → diagnose → change → measure → log. Audit-only: **modify nothing** (except report, watermark advance, 30-day session prune) unless user asks.

0. Watermark check — read `~/.pi/agent/audit-reports/.watermark.json` (`auditedThrough`, ISO ts). Session-derived scans scope strictly to session files whose filename timestamp is newer (parse it — filenames dash the time `YYYY-MM-DDTHH-MM-SS…`; plain string compare mis-orders same-hour case vs colon-format watermark); never re-audit covered sessions. No watermark → everything unaudited.
1. Inventory (chars/4 = token heuristic):
   - Context files: `AGENTS.md` (+ always-loaded files) byte size → tokens.
   - Every skill: `description` char count → tokens (extract frontmatter only, never load bodies).
   ```sh
   wc -c ~/.pi/agent/AGENTS.md
   awk '/^description:/{f=1;next} /^---/{f=0} f' ~/.pi/agent/skills/*/SKILL.md | wc -c
   ```
2. Permanent floor = context tokens + Σ skill-description tokens.
3. Health Score — start 100, deduct:
   - context > 800 tok: −10
   - context > 1,300 tok (hard ceiling): −30 + report carries a trim proposal or a recorded user sign-off — floor growth is a decision, never drift
   - skill count > 15: −10
   - any single desc > 250 tok: −10
   - avg desc > 100 tok: −10
   - huge body (>2,000 tok) AND long desc (>100 tok): −5/skill (progressive-disclosure failure)
   - AGENTS.md ↔ skill rule duplication: −5/overlap
   - vague/missing descriptions: −5 each
   - skills-dir pollution (node_modules, .zip, ._*): −5/class
   - portability quick-check hits in functional files: −5/class
4. Anti-pattern sweep — prompt-quality + security checks orthogonal to score: run `references/anti-pattern-audit.md` checklist over skills, prompts, extensions (rg-signature pass first, read flagged regions only, calibrate earned emphasis vs boosters). Findings get own report section; fixes = separate proposals (Workflow step 3).
5. Report → matching `~/.pi/agent/audit-reports/{harness,skills,sessions}/` subdir, `<date>T<time>Z-<topic>.md` (filename carries date; header records machine provenance — `uname -srm` + `uname -n`, repo runs from multiple machines/OSes) — structure: executive summary, inventory table, top consumers, overlaps, score breakdown, delta vs previous report if present. If permission-gate/extensions changed since the previous report: run `npm run gate:eval` first and include the pass-rate delta (standing eval cadence — harness changes re-verify like releases).
6. Report BEFORE → AFTER numbers; recommendations ranked by impact. Implement only on request, then log per *Workflow* step 5.
7. Close audit — advance `.watermark.json` `auditedThrough` to newest covered session; prune: delete `~/.pi/agent/sessions/**/*.jsonl` unmodified 30 days, remove emptied cwd-slug dirs.

## Workflow

1. Discover — loaded context files, skills (name + desc + path), prompts, non-portable items. Re-read `README.md`. BEFORE snapshot.
2. Diagnose — rank by impact: unused/overlapping skills, AGENTS.md bloat belonging in a skill, bash-used-for-search, non-portable paths, unstable prefix material.
3. Propose — prefer deletions/merges. Per change: path, before→after, why (cache/tokens/portability), risk, rollback.
4. Implement — approved/safe edits only. Ask before destructive/large writes. Tell user fresh session after prefix changes.
5. Persist — dated entry at TOP of `CHANGELOG.md` (latest-first; include `Measured:` before→after). Update `README.md`/`skills-audit.md` when architecture or skill set changes.

Optional deep evidence (only on request — skill-usage/token audit):

- `python3 scripts/usage-metrics.py` (skill dir) — per-model token profile (input/output/reasoning per turn, cache %, cost), top-5 cost-tail sessions, first-turn prefix trend. Prefer over hand-written JSONL analysis.
- `python3 scripts/audit_toolcall_rules.py [path]` — checks session .jsonl (or dir; default last 5) for AGENTS.md Token-Economy violations (grep-on-file, cat-for-viewing, re-runs, speculative previews, pollution) + per-turn call batching stats.
- `python3 scripts/error_audit.py [path]` — error mining: joins toolResult.isError back to originating toolCall input; reports by tool/kind/project + top failing command heads (default all sessions).
- A/B prefix cost: `bash scripts/make_test_home.sh <skills-csv> [dest]` builds temp HOME with those skills model-visible (real harness untouched); `bash scripts/ab_prefix.sh "<prompt>" <dest> [model]` runs one prompt under both configs, prints first-turn tokens / cache-read / cost / wall time.
- Evidence (L2-vs-L3 benchmark, 10 runs): `assets/l2-vs-l3-matrix.json` — only tavily-search fired (enabled model-visible as result); L3-as-a-set failed ≤20% median-cost rule.
- pi sessions: `~/.pi/agent/sessions/*/*.jsonl` — skill loads, `/skill:` invocations, correction words
- Rank skills: auto-load vs explicit vs never fire — `uv run --script scripts/skill_usage_audit.py` (from skill dir) counts per-skill invocations across all sessions, tiers high/medium/low/unused

## Portability quick-check

```sh
rg -n '/Users/|/home/|pbcopy|pbpaste|osascript|/opt/homebrew|launchctl' \
  ~/.pi/agent/AGENTS.md ~/.pi/agent/settings.json ~/.pi/agent/models.json \
  ~/.pi/agent/*.sh ~/.pi/agent/prompts/ ~/.pi/agent/skills/ \
  --glob '!**/harness-engineer/**' --glob '!**/node_modules/**'
```

Zero hits required in functional files.

## Output format

- BEFORE snapshot
- Problems (by impact)
- Recommended changes (diffs + risk)
- Actions taken
- AFTER snapshot + delta
- Portability status
- Changelog entry (`Measured:` line required)

## Goal

Smaller, stable, cache-friendly, rg-first, fully portable harness.
