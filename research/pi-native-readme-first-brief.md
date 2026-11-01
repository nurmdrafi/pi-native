# Product Brief — pi-native README relaunch (marketing wave 1)

**Status:** outdated — treat as historical; do not implement. Figures and positioning were never verified against the repo and the marketing direction was superseded by the owner.
**Date:** 2026-11-01
**Deliverable:** Optimized GitHub README (marketing-first) + repo About description + topics
**Provenance:** all figures in this brief come from the marketing review of the pi-native README. No local checkout of nurmdrafi/pi-native exists in this environment, so no figure was verified against source — see Open Questions.

## Problem

pi-native (3 stars today) has differentiated, measured results — 3.4× reads, 2.7× edits, 75× indexing, 94.3% context reduction (273 KB → 15.6 KB), a 23-rule fail-closed gate with 93% one-shot recovery — but the repository front page is technical-depth-first and does not lead with them. Every planned promotion channel (launch post, X thread, graphics, blog) sends its audience to this one page. Promotion before the landing page converts buys traffic that bounces.

## Recommendation (first deliverable) and rationale

**The optimized GitHub README ships first.** One-line rationale: every other deliverable links to the repo, so the landing page must convert before any traffic is pointed at it.

## Audience

- **Primary:** existing users of the Pi harness (ecosystem ~118k stars) who feel token cost and tool latency on large codebases.
- **Secondary:** measurement-driven engineers who pick tooling by before/after numbers.

## Positioning (fixed copy — do not paraphrase)

> pi-native is the performance-focused, measured Pi harness — native Rust tools, 94% context reduction, and a fail-closed safety gate that never breaks your session.

Forbidden framing: "best coding agent"; any capability comparison against Claude Code or Codex; any quantified claim without a documented measurement.

## Scope

In scope:
- Rework the repository `README.md` front page: a "Why pi-native?" section plus a pi-native vs plain Pi comparison table, keeping all existing technical depth below them.
- Update the GitHub repository About description and topics.

Out of scope (later waves): launch announcement post, X thread, comparison graphic, "why pi-native exists" blog post, demo recording (a link may be added only if a recording already exists), logo/branding, website.

## Figures cleared for use in copy

| Figure | Value | Pillar |
|---|---|---|
| Read speedup | 3.4× | speed |
| Edit speedup | 2.7× | speed |
| Indexing speedup | 75× | speed |
| Context reduction | 273 KB → 15.6 KB (94.3%) | token efficiency |
| Gate rule count | 23 | safety |
| One-shot recovery | 93% | safety |
| Portability | single `~/.pi/agent/` directory | portability |

No other numbers may appear: any number not in this table or the repo's existing benchmark tables is out of bounds (AC4). If any figure above is absent or stale in the repo README at HEAD, flag it — do not smooth it over.

## Acceptance criteria

1. A section headed "Why pi-native?" appears in `README.md` before any horizontal rule and within the first 40 rendered lines, and opens with this sentence verbatim: "pi-native is the performance-focused, measured Pi harness — native Rust tools, 94% context reduction, and a fail-closed safety gate that never breaks your session."
2. The "Why pi-native?" section contains each of these literal strings: "3.4×", "2.7×", "75×", "273 KB", "15.6 KB", "94.3%".
3. A markdown table in `README.md` compares pi-native against plain Pi, one row per dimension, covering at least: read latency, edit latency, indexing speed, context size before/after, session resilience (fail-open ladder), blocked-recovery behavior (fail-closed gate), and portability (single `~/.pi/agent/` directory).
4. A diff of numeric tokens between the pre-rework and post-rework `README.md` shows the new file introduces no number that neither the old README nor the repo's benchmark tables contained.
5. The strings "Claude Code", "Codex", and "best coding agent" (case-insensitive) appear nowhere in `README.md`.
6. The pre-rework `README.md` sections covering the three-rung fail-open ladder, the fail-closed gate, and installation remain present after the "Why pi-native?" and comparison sections.
7. `README.md` contains no "TODO", "FIXME", or "WIP" markers; every http(s) URL in the file resolves (HTTP 200, or a redirect chain ending in 200); every relative link resolves to an existing file in the repo.
8. The GitHub repository About description is at most 350 characters and contains both the phrase "native Rust" and the phrase "94.3% context reduction".
9. The repository topic list contains at least four topics from this set: pi, pi-harness, coding-agent, rust, cli, llm, performance, token-efficiency.
10. If a terminal demo recording exists at publish time, `README.md` links to it under a heading containing "Demo"; if no recording exists, `README.md` contains no "Demo" heading (no empty sections).

## Non-goals

- No new benchmarks, benchmark re-runs, or code changes — copy work only.
- No competitor comparisons (Claude Code, Codex) anywhere in the artifact.
- No unmeasured claims: any benefit without a documented number is described qualitatively or omitted, never quantified.
- No new assets (logo, diagram, video) produced in this wave beyond linking what already exists.

## Open questions

1. Confirm every figure (3.4×, 2.7×, 75×, 273 KB → 15.6 KB, 23 rules, 93%) matches the repo README at HEAD before publishing — they are taken from the marketing review, not a live checkout.
2. Does a plain-Pi baseline measurement exist in the repo for every comparison-table row, or do some rows need a fresh measurement run (scope increase)?
3. Record the 60–90 s terminal demo before this README ships (embedded "Demo" section), or ship without and add later?
4. Owner must set the success bar for this asset (e.g., stars 3 → N in 14 days after community seeding, or README view/clone target) so the follow-on waves can be judged.

## Follow-on order after this ships

1. Launch announcement post (X, Reddit, Discord, HN) — reuses the positioning sentence and the demo; links here.
2. X thread — one hard number per post; links here.
3. Comparison graphic — export of the README table plus side-by-side terminal screenshots.
4. "Why pi-native exists" short blog post — depth for readers the announcement converts.
