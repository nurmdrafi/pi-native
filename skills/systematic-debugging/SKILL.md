---
name: systematic-debugging
description: Use BEFORE proposing any fix when something is broken — runtime errors (TypeError / Cannot read properties of undefined), wrong/null API data, build/test failures, "did not redirect / stopped working", "stuck loading", regressions, unexpected behavior, recurring errors that survive fixes ("same error again", "error keeps coming back"), repeated TypeScript strict errors (TS2345 null, TS2304 cannot-find-name), tests importing nonexistent modules. Find root cause first; never patch symptoms. NOT for features or greenfield work.
disable-model-invocation: true
---

# Systematic Debugging

## Overview

Root cause before any fix. Symptom fix leaves cause in place = same error returns. Fix proposals before Phase 1 done = guessing.

## When to Use

Any technical issue: test failures, prod bugs, unexpected behavior, perf, build failures, integration issues.

Especially when:
- Time pressure (emergencies tempt guessing)
- "Quick fix" seems obvious
- Multiple fixes already tried
- Previous fix didn't work
- Issue not fully understood

## The Error-Class Loop

Same error class second time (TS2345 null-check, TS2304 cannot-find-name, test importing nonexistent module, same build error in another file): stop instance-patching. Error surviving two fixes = fixes hit instances, not cause.

1. `rg` pattern repo-wide — every occurrence, not just the one compiler showed first
2. Fix whole class as one change (shared guard, real import path, actual module name)
3. Run narrow check once (`tsc --noEmit` / single failing test file), confirm zero occurrences — not one turn per instance

Don't skip when:
- Issue seems simple (simple bugs have root causes too)
- Hurrying (rushing = rework guaranteed)
- Manager wants it NOW (systematic beats thrashing)

## The Four Phases

Each phase before next — each produces evidence the next consumes.

### Phase 1: Root Cause Investigation

**BEFORE any fix:**

1. Read errors carefully — don't skip; often contain exact solution. Full stack traces, note line numbers, paths, error codes
2. Reproduce consistently — exact steps? every time? Not reproducible → gather more data, don't guess
3. Check recent changes — git diff, recent commits, new deps, config, env differences. Bug reports quote code at the filed commit — re-read current HEAD first; may already be fixed, or that fix may itself be the bug you're chasing
4. Multi-component systems (CI → build → signing, API → service → database): instrument each component boundary, run once, localize failing layer — full technique + multi-layer example + intermittent external-API throttle-counter case in [references/evidence-gathering.md](references/evidence-gathering.md)
5. Error deep in call stack: see [references/root-cause-tracing.md](references/root-cause-tracing.md) for full backward-trace technique. Quick version: where does bad value originate? what called this with it? trace up to source, fix at source not symptom

### Phase 2: Pattern Analysis

1. Find working examples — similar working code in same codebase. Wrong/null API data: read sibling consumer of same endpoint/hook + endpoint definition (transformResponse?) — actual post-unwrap shape settles it in one glance; variable names like `res.data` lie (`.unwrap()` already returns body)
2. Compare against references — implementing a pattern? read reference implementation COMPLETELY, every line
3. Identify differences — list every difference, however small; never assume "that can't matter"
4. Understand dependencies — needed components, settings, config, environment, assumptions

### Phase 3: Hypothesis and Testing

1. Single hypothesis — "X is root cause because Y", write it down, be specific
2. Test minimally — smallest possible change, one variable at a time
3. Verify before continuing — worked → Phase 4; didn't → NEW hypothesis; DON'T stack fixes
4. Don't know? Say "I don't understand X". Don't pretend. Ask, research

### Phase 4: Implementation

Fix root cause, not symptom:

1. Failing test case first — simplest reproduction, automated test or one-off script, required before fixing. Written after fix exists? Flip fix back once, confirm test goes red — regression test that never failed proves nothing
2. Single fix — root cause only, ONE change, no "while I'm here", no bundled refactoring
3. Verify — test passes? no other tests broken? issue resolved? original failing command re-run end-to-end green? Failures stack — one root cause masks the next; green on fixed layer alone ≠ done. Adjacent-path check (fixes = most common regression source): enumerate every other path the touched guard/effect/state participates in, verify each. Guard closing reported hole must neither skip legit run nor fire when silent; re-entered blocks must not stack handlers/listeners (remove-then-add or flag the right event resets)
4. Fix doesn't work → STOP. Count fixes tried. <3 → Phase 1 with new info. **≥3 → STOP, question architecture (step 5)**. No fix #4 without architectural discussion
5. 3+ fixes failed = architecture problem. Signals: each fix reveals new shared state/coupling elsewhere, fixes need "massive refactoring", each fix creates new symptoms. STOP, question fundamentals: pattern sound? inertia alone? refactor architecture vs keep patching symptoms? Discuss with human partner first. Not failed hypothesis — wrong architecture

## Red Flags — STOP and Follow Process

Red-flag thoughts, human partner's redirect signals, rationalization→reality table in [references/red-flags.md](references/red-flags.md) — read when caught (or told) guessing. ALL red flags: STOP, return to Phase 1. 3+ fixes failed → question architecture (Phase 4 step 5).

## Quick Reference

| Phase | Key Activities | Success Criteria |
|-------|---------------|------------------|
| **1. Root Cause** | Read errors, reproduce, check changes, gather evidence | Understand WHAT and WHY |
| **2. Pattern** | Find working examples, compare | Identify differences |
| **3. Hypothesis** | Form theory, test minimally | Confirmed or new hypothesis |
| **4. Implementation** | Create test, fix, verify | Bug resolved, tests pass |

## When Process Reveals "No Root Cause"

Truly environmental / timing-dependent / external:
1. Process complete
2. Document what was investigated
3. Implement appropriate handling (retry, timeout, error message)
4. Add monitoring/logging for future

But: 95% of "no root cause" = incomplete investigation.

## Supporting Techniques

- [references/root-cause-tracing.md](references/root-cause-tracing.md) — trace bugs backward through call stack to original trigger
- [references/defense-in-depth.md](references/defense-in-depth.md) — validation at multiple layers after finding root cause
- [references/condition-based-waiting.md](references/condition-based-waiting.md) — replace arbitrary timeouts with condition polling
- [references/evidence-gathering.md](references/evidence-gathering.md) — multi-component instrumentation + external-API throttle-counter case
- [references/red-flags.md](references/red-flags.md) — red-flag thoughts, human-partner signals, rationalization→reality table
