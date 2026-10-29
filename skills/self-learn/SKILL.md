---
name: self-learn
description: >
  Audits recent session extracts for recurring behaviour failures — edit-anchor
  misses, identical-call retries, circling edits, read-tool bypass, shell
  hygiene, gate blockers, rule/gate desync — then discusses each verified
  finding and applies the fix in the same run (TDD for code). Every
  verified lesson routes to its owner: an existing skill whose domain
  covers it gets updated (via skill-manager); ownerless lessons are
  archived in references/lessons/ with trigger, mistake shape, and a fix
  code block. Use when the user asks to learn from sessions, run a retro,
  review repeated mistakes, or check whether behaviour matches the rules.
  Bare invocation (no window argument) audits the current session only.
  NOT for token/cost efficiency reports (session-audit) or authoring
  brand-new skills (skill-manager).
disable-model-invocation: true
---

# Self-learn

Reasoning layer over `pidx` session extracts. Detectors are deterministic
(`jq` queries, `references/detectors.md`); this skill classifies failures,
discusses them, and applies fixes. Efficiency/cost analysis belongs to
`session-audit`. Fixes land in the home that owns them — an existing
skill, a rule, a test — and whatever cannot land yet is archived under
`references/lessons/`, not dropped.

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
   proposed fix and its home. Homes, checked in order: an existing skill
   (`ls ~/.pi/agent/skills/` + read its description — an auth lesson
   belongs in the auth skill, not a new archive file), rule edit, gate
   rule, test, `references/lessons/` when nothing owns the topic. Wait
   for the user's pick; apply nothing unapproved beyond fixes the invoking
   message already sanctioned.
5. **Apply** — approved fixes land now: code via TDD (failing test → fix →
   green), rule edits take one home only (cross-reference, never restate),
   skill updates through skill-manager (keep that skill's trigger scope;
   long material into its `references/` as code blocks, not prose-only
   bullets), ownerless lessons into `references/lessons/`. Report what
   landed; state anything deferred and why.

## Lessons store (`references/lessons/`)

One file per topic, written only when no skill owns the topic — step 4's
home check runs first: a lesson matching an existing skill updates that
skill instead of growing this dir. A re-encountered topic extends its
existing file; never fork a second file for it.

File format — trigger, mistake, fix, evidence, in that order:

1. **Trigger** — the recurring situation, phrased as words a future
   session would recognize.
2. **Mistake shape** — what went wrong; when code was involved, the
   offending code as a fenced block.
3. **Fix** — the corrected code as a fenced block. A prose-only lesson is
   rejected at review: the code block is what gives the next run
   copy-paste context.
4. **Evidence** — source paths the lesson was distilled from.

## Calibration

- Verification gates the fix, not the calendar: confirm against source or
  tests before writing — a confident-looking cluster was once already
  fixed.
- Re-baseline after windows that overlap harness-internal work.
- One shape per finding; a shape recurring in a later window is the same
  finding with updated evidence, not a new one.
- Current-session findings: counts are self-reported, not
  extract-verified — say so.
