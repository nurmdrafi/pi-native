# Pi Native structure plan

**Status:** Structure changes in place. Gortex was trialed and not adopted.

## Decision

Keep the current layout. [ECC](https://github.com/affaan-m/ECC/tree/4adeee6732a1) separates reusable rules, skills, and agents from host-specific adapters and their tests. Borrow that boundary, not the multi-host directory tree. Pi is this repo's only host: `extensions/` integrates with it, `rust-tools/` contains native implementations, `dashboard/` is a separate app, and `skills/` and `docs/` hold task-specific material. Browse ECC manually when a specific pattern is useful; do not install or wire it into Pi.

## Sequence

1. **Remove leftover ECC wiring.** The package is already uninstalled. Remove the [local hook toggle](../../extensions/ecc-session/index.ts), its [dedicated test](../../tests/extensions/ecc-session.test.mjs), and the ECC entry under `extensionChangelogVersions` in [settings.json](../../settings.json). The toggle does not inject rules itself; it sets a flag for the removed package. Verify in a fresh Pi session that the package and `/ecc-session` are absent and unrelated settings are unchanged.
2. **Improve navigation without moving runtime code.** Add a short repository map to the [README architecture section](../../README.md#architecture). Point contributors to runtime code, the relevant tests, and benchmarks. Keep task-specific guidance out of always-loaded instructions and link to existing docs rather than repeating them.
3. **Clarify where benchmarks belong.** [Package scripts](../../package.json) currently run performance tools from both `tests/tools/bench/` and [`benchmark/`](../../benchmark/README.md). Inventory script, test, docs, and CI references before moving anything. When a suite is next changed, move its standalone performance runner to `benchmark/` if that makes it easier to find; keep CI assertions in `tests/`. Preserve historical results and update references in the same change. No bulk migration.
4. **Adapt selected ECC skills and agents.** Apply the docs pattern while writing the repo map. Trial the benchmark method on the next measured harness change and the test-review checklist on one representative diff.
5. **Evaluate Gortex separately.** Run the isolated CLI trial below only after approval. The structure work does not depend on it.

## Verification

- A fresh `pi --mode rpc --no-session` listed no `/ecc-session`; `pi list` reported no packages. Comparing parsed settings against the previous revision showed only ECC entries removed.
- The benchmark entry points remain in [package scripts](../../package.json) and [the test index](../../tests/README.md). The reference inventory included tests, docs, and CI; no runner moved. The experiment method is ready for the next measured change.
- Manual reviewer dry run on `b67023a` (Piwrite title): registration alone does not assert the visible title; the frame comparisons and title test do. The checklist flags the registration-only comparison and accepts the actual coverage. Both renderer suites passed (24 tests).

## ECC: what to borrow

The session audit showed recurring documentation, test, and diff-review work. **Adopt the docs pattern first.** Trial the test-review checklist in the existing reviewer on a known coverage gap and a covered comparison case; keep it only if it distinguishes the two. Use the benchmark method on the next measured optimization, not as a standalone migration. Keep the incident, MCP, and silent-failure resources as manual references. None warrants copying an entire skill or agent.

### Skills

| ECC skill | Fit and destination |
| --- | --- |
| [`living-docs-governance`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/skills/living-docs-governance/SKILL.md) | **Adapt for the repo map.** Keep rules in [AGENTS.md](../../AGENTS.md), the map in the README, and release history in the [changelog](../../CHANGELOG.md). Reuse existing status notes; don't create a new file just to fill a slot. |
| [`benchmark-optimization-loop`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/skills/benchmark-optimization-loop/SKILL.md) | **Trial in the [benchmark workflow](../../benchmark/README.md).** The existing runner executes frozen cases; borrow the experiment design: write down the objective, independent expected result, and run budget before trying one change at a time. On the next native-tool optimization, reproduce the baseline and candidate under the same conditions. Reject speed gains that break output parity. |
| [`agent-introspection-debugging`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/skills/agent-introspection-debugging/SKILL.md) | **Manual incident reference.** On a repeated failure, capture the goal, last good step, first failure, and smallest repro before retrying. Use the existing [harness incident workflow](../harness-watch.md) and session index rather than introducing another diagnostic skill. |
| [`mcp-dependency-review`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/skills/mcp-dependency-review/SKILL.md) | **Manual integration reference.** When reviewing MCP configuration, inspect whether package or image references can change without another review. Do not run the server to classify a reference. |

### Agents

| ECC agent | Fit and destination |
| --- | --- |
| [`pr-test-analyzer`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/agents/pr-test-analyzer.md) | **Adapt in the [existing reviewer](../../agents/reviewer.md).** Map changed behavior to test assertions and flag consequential gaps, including failure paths. Keep the checklist item only if it catches a known gap on a representative diff without flagging covered behavior. |
| [`silent-failure-hunter`](https://github.com/affaan-m/ECC/blob/4adeee6732a1/agents/silent-failure-hunter.md) | **Manual review lens.** When changing retries, daemon fallback, or error reporting, ask the existing reviewer to trace whether the caller can distinguish a terminal failure from an empty but successful result. No separate agent. |

Do not import ECC's generic TDD, verification, build-resolver, or harness-optimizer resources; Pi Native already has owners for those jobs. No skill or agent needs a wholesale copy for these steps. Do not register ECC as a package or enable its hooks, rules, or skills.

## Gortex: trial before adoption

**Result:** Cosign verified `v0.64.11` for Linux amd64. The isolated, clean checkout at `bf770ab` exceeded the agreed 1 GiB limit during indexing: Gortex reported about 2.35 GiB peak RSS, even though the trial requested a 1 GiB systemd scope limit. The run timed out before the caller comparisons. The daemon was stopped; no Pi package, settings, hooks, or MCP integration were changed. Keep using source navigation; there is no verified query-speed gain.

[Gortex](https://github.com/zzet/gortex/tree/69d71d89b489) provides indexed callers, dependencies, and cross-repo relationships. `rg`, `outline`, and `piread` already cover routine navigation. The added value would be faster, accurate answers to recurring call-graph questions, not smaller output alone.

Defer the trial until caller tracing becomes a recurring bottleneck. Agree on time and memory budgets before running it. Do not add Gortex as a project dependency or Pi package. Once approved, run the comparison:

1. Verify a pinned release using the [upstream release instructions](https://github.com/zzet/gortex/blob/69d71d89b489/docs/installation.md#verifying-releases-supply-chain-security). Use the [CLI](https://github.com/zzet/gortex/blob/69d71d89b489/docs/cli.md#query-subcommands) against a clean temporary checkout with isolated state. Skip `gortex install` and `gortex init`: the [Pi adapter](https://github.com/zzet/gortex/blob/69d71d89b489/docs/agents.md#L49) writes Pi settings. Do not enable MCP, hooks, or hosted services for the trial.
2. Pick at least four representative caller or dependency tasks spanning TypeScript and Rust. Run both approaches against the same revision and verify answers against source. Record missed and spurious callers, time to a verified answer, cold indexing time, and daemon memory use. Include a cross-repo case only if it reflects real work.
3. Keep it as a manual CLI only if it improves time to a verified answer on most tasks without missing known callers and its overhead is acceptable. Record the decision, stop the trial daemon, and verify Pi settings and hooks are unchanged. Graph results never replace required source reads or permission checks.
