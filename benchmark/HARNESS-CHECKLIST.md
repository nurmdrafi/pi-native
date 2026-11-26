# Harness optimization checklist

Update this checklist when a change is verified. For each performance change, record the workload, sample size, before/after results, and any correctness tradeoff. Keep raw session contents and machine-specific paths out of reports.

## Done

- [x] **Warm tool baseline.** 100 timed calls per tool, after warmup, through isolated permission-gate hooks and native dispatch. One-line `piread`: 0.080 ms p50 / 0.120 ms p95. Trivial `pibash`: 2.013 ms p50 / 2.586 ms p95; native execution dominated. These are local fixture results, not model round-trip times.
- [x] **Session and tool audit.** 100 recent sessions: 12,474 calls, 12,471 results, 745 error results (291 gate blocks), and 417 recognizable advisory results. Logged usage: 11.86M input, 857.85M cache-read, and 4.93M output tokens. Read results accounted for about 9.81 MB of 14.67 MB of tool text. Cache reads count repeated prefixes, not unique tokens; UI-only warnings were outside the sample.
- [x] **Reader-bypass recovery.** Direct blocks suggest exact `piread` arguments for supported literal reads when they fit the message budget. Ambiguous reads and warning escalation keep the existing guidance. Block and approval rules were unchanged. [Gate code](../extensions/permission-gate/index.ts) · [Regression tests](../tests/gate/reader-bypass-error.test.mjs).
- [x] **Audit correctness.** `pidx` counts identical edit resends only after a recognized gate block (6 instead of 21 in the audited sample). The recovery audit matches the next assistant batch to its results rather than counting any next call as recovery. [Lifecycle report](../rust-tools/pidx/src/main.rs) · [Recovery audit](../tests/tools/audit/block-recovery.mjs).
- [x] **Startup and resume baseline.** Seven measured samples per case. Fresh-process SDK import: 341 ms median; gate import plus empty-session initialization: 91 ms median. Isolated gate session replay: 0.15 ms with no history, 6.19 ms for 500 read pairs, 62.97 ms for 5,000. This was not a full Pi startup or resume measurement.
- [x] **On-demand local skills.** All 31 local skills are eligible for model selection; only metadata is advertised, and bodies load on demand. The local formatted catalog grew from 4.18 KB to 20.24 KB by request. ECC was left unchanged. [Skill behavior](../docs/skills.md).
- [x] **Verification.** 67 gate and audit tests, 10 `pidx` tests, TypeScript, and whitespace checks passed. `rustfmt` was unavailable.
- [x] **Repeatable workflow audit.** `bin/pidx --report audit --max 100` reports aggregate token usage, tool outcomes and bytes, recognizable gate blocks and warnings, and next-batch recovery without printing payloads. One 100-session smoke run took 186 ms cold and 58 ms warm, reusing all 100 cached extracts and returning identical output. Eleven Rust and 12 Node tests passed. [Report usage and classification limits](../rust-tools/pidx/README.md#recent-session-workflow-audit).

## Next, in priority order

- [ ] **Measure whether exact hints reduce retries.** Compare eligible reader-bypass blocks before and after reload: exact-hint coverage, accepted replacement reads, and same-family reblocks. Segment by command shape and model. A successful next batch is not proof the original task recovered.
- [ ] **Reduce repeated or oversized reads.** Find the read shapes that contribute most bytes and repeated rounds; try smaller windows or cheaper search-to-read paths first. Compare result bytes and task completion using the existing [model-visible baseline](../tests/tools/bench/model-visible-baseline.mjs). Preserve edit anchors and coverage semantics.
- [ ] **Benchmark full startup and long-session resume.** Measure time to ready in fresh processes, then resume fixed short and long histories. Attribute time to resource discovery, extension loading, and gate replay. Only optimize a phase that shows material cost; preserve freshness checks and project trust. Compare prompt growth and task continuity with compaction off versus on in isolated sessions before changing defaults.
- [ ] **Profile slow tool tails, not tiny warm calls.** Track cold daemon startup, fallback, large reads and edits, and concurrent shell workloads. Record p50/p95 and fallback frequency before changing native dispatch. Reuse the [native performance guide](../docs/native-tools.md) and existing parity tests.

## Scope decisions

- ECC skill filtering is out of scope. Do not trade correctness, approval checks, or diagnostics for lower latency.
- Keep the existing native architecture unless a representative workload shows a sustained bottleneck.
