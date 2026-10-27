# permission-gate: tests and tooling

Everything for the gate lives under `tests/gate/`: cases, harness, fixtures, and the eval
driver. The extension itself keeps only the composition root plus config
(`index.ts`, `config.ts`, `config.json`); rule modules live in
`extensions/permission-gate/rules/`.

```
runner.test.mjs                       runner: assemble, assert, diet-cap, exit non-zero
harness/helpers.mjs                   extension import, stub API, fixtures, read/edit/bash helpers
harness/preambles.mjs                 preambles, keyed by exact case name
harness/stub.mjs                      minimal ExtensionAPI stub (shared with parity suites)
cases/index.mjs                       assembles every case module into one ordered list
cases/rules/<ruleKey>.mjs             cases for rules.<ruleKey>
cases/rules/editAnchorGuard/          split by area:
  anchor-guard.mjs                      anchor existence / uniqueness / overlap
  validation-binding.mjs                S5 M2/M3 coverage binding
  validation-freshness.mjs              S5 W stale / unread / drift
  validation-anchors.mjs                S5 D4 exact+fuzzy twins
  validation-protected-policy.mjs       S5 H2 policy on protected paths
  compaction-gap.mjs                    C2/C3 compaction dead-zone
cases/scenes/*.mjs                    multi-rule scenes (interplay, normalization, security-*)
fixtures/bash-{allow,block}.txt       fixture tables for the eval
eval/fixtures.mjs                     fixture-driven evaluation (92 fixtures)
eval/run.mjs                          driver behind `npm run gate:eval`
config.test.mjs                       config parsing, severity matrix, destructive table
bypass.test.mjs                       bypass checks against the cap/compression predicates
region-off.test.mjs                   PGATE_EDIT_REGION_GUARD=0 behavior
```

Rule modules in the extension: `anchor-guard`, `bash-cap`, `commitlint`, `destructive`,
`output-scrub`, `read-coverage`, `search-guard`, `toolchain`, `phase`.

Naming: `cases/rules/<ruleKey>.mjs` is camelCase because the filename **is** the rule key
(`rules.commitMessageLint` ↔ `cases/rules/commitMessageLint.mjs`), which makes the pair
greppable in one shot. Section files inside a single rule's directory are kebab-case
(`validation-freshness.mjs`), as are scene filenames.

## Adding a case

1. Put it under the rule it primarily asserts. Multi-rule scenes go in the matching
   `scenes/` module; a new scene gets a new file there.
2. Shape: `[name, "pass" | "blocked", async (pi) => ({ blocked: boolean, reason?: string })]`.
3. Needs prior state? Add a preamble in `harness/preambles.mjs` keyed by the exact case name.
4. Helpers come from `harness/helpers.mjs`. Imported bindings are read-only, so mutable state
   is exposed through functions (`nextId`, `getHydT`/`setHydT`).

## Adding a rule

1. Add the module under `extensions/permission-gate/rules/`.
2. Register the key in `config.ts` (`RULE_IDS`, and `WARN_BY_DEFAULT`/`HARD_RULES` as fits).
3. Add the row to the catalog in `extensions/README.md` — a test fails otherwise.
4. Add `cases/rules/<ruleKey>.mjs`.

## Invariants

- The runner prints `N/N PASS`; a move or split must not change `N` (307 at the 2026-10-27
  split, including the R11 and PH1 cases added that day).
- Block reasons keep their family prefix and stay within the diet cap (220 chars; Anchor
  Guard 800).
- Attribution is per section, not per assertion: a case that exercises a sibling rule may
  live in the file it was split into. Move it when you touch it.
