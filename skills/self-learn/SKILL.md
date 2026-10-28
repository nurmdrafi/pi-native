---
name: self-learn
description: >
  Audits recent session extracts for recurring behaviour failures — edit-anchor
  misses, identical-call retries, circling edits, read-tool bypass, shell
  hygiene, gate blockers, rule/gate desync — then discusses each verified
  finding and applies the fix in the same run (TDD for code). Use when the
  user asks to learn from sessions, run a retro, review repeated mistakes,
  or check whether behaviour matches the rules. Bare invocation (no window
  argument) audits the current session only. NOT for token/cost efficiency
  reports (session-audit) or creating/modifying SKILL.md files
  (skill-manager).
disable-model-invocation: true
---

# Self-learn

Reasoning layer over `pidx` session extracts. Detectors are deterministic
(`jq` queries, `references/detectors.md`); this skill classifies failures,
discusses them, and applies fixes. Efficiency/cost analysis belongs to
`session-audit`. No persistent store: verified findings become code, rules,
or tests in the same run; anything deferred is simply re-detected next run.

## Workflow

1. **Select mode** — bare invocation: current session only. With a window
   argument (e.g. "3 days"): past sessions.
   - Current session: extracts lag the live session file — audit from this
     session's own visible history instead. Same signals, counts as
     witnessed: identical retries, edit-anchor failures and their gate
     reasons, per-file edit counts, sed/cat reads, hygiene patterns, env
     friction. Spot-check the newest session file only when a count matters.
   - Past sessions: run `pidx` for fresh extracts, then the detector set in
     `references/detectors.md`.
2. **Detect** — collect the aggregate table (per-signal counts + worst
   offenders). Raw session logs echo rule text into stored context — counts
   come from extract err flags and param hashes, never raw-log keyword greps.
3. **Root-cause** — for each signal above its previous run's level, inspect
   at most 2-3 raw session files with targeted, output-capped searches to
   classify the failure shape. Gate blocks split into justified vs
   false-positive-against-context (S8). When gate blocks cluster, run the S9
   desync pass: rule-file text vs gate behaviour vs what the workflow
   actually needed. S9 scope is session-related rules and gates only —
   rules with a tool-call surface (SYSTEM.md tool-path/bash/blocks,
   AGENTS.md safety, skills' tool-call instructions) checked against the
   gate's rule set and observed session behaviour; doc-style, communication,
   and process rules have no gate surface and stay out of scope. Note when
   the window overlaps work on the harness itself — self-referential edits
   inflate gate-related counts.
4. **Discuss** — present each finding: signal, evidence, root cause,
   proposed fix and its home (rule edit / gate rule / skill / test). Wait
   for the user's pick; apply nothing unapproved beyond fixes the invoking
   message already sanctioned.
5. **Apply** — approved fixes land now: code via TDD (failing test → fix →
   green), rule edits take one home only (cross-reference, never restate),
   skill updates through skill-manager. Report what landed; state anything
   deferred and why.

## Calibration

- Verification gates the fix, not the calendar: confirm against source or
  tests before writing — a confident-looking cluster was once already
  fixed.
- Re-baseline after windows that overlap harness-internal work.
- One shape per finding; a shape recurring in a later window is the same
  finding with updated evidence, not a new one.
- Current-session findings: counts are self-reported, not
  extract-verified — say so.
