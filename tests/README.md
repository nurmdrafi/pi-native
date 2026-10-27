# Tests

`npm test` runs `node --test "tests/**/*.test.mjs"` — every `*.test.mjs` at any depth.
Files without that suffix are drivers, benchmarks, or helpers and never run in CI.

## Tree

```
unit/           9 files   single module, no pi session, no daemon
                          compact-editor · doc-check · pidx-params · progress-ui
                          read-coverage · search-guard-locate · protected-path
                          sync-agent-bin · sync-impeccable
integration/   10 files   real processes, daemons, extension wiring
                          daemon-exit · daemon-process-group · piread-daemon-settle
                          pibash-large-output · self-heal · session-metrics
                          install-native · native-bin-sign · pidoc-portability
parity/         5 files   native tool vs the built-in it replaces
                          piread-parity · piedit-parity · pibash-parity · piread-huge
                          PARITY_DEVIATIONS.md
benchmark/      1 file    mirrors the repo's benchmark/ package: suite.test.mjs
gate/                     permission-gate — see gate/README.md
subagents/                TypeScript suite: runner.ts + harness.ts + test-env.ts
                          + *.test.ts (+ integration/)
tools/                    manual drivers, not in CI
  bench/                  pibash · piedit · piread · model-visible-baseline
  audit/                  bin-diff · block-recovery · replay · diff-fuzz · hotpath-profile
fixtures/                 shared inputs: bench/, doc-check/, session-metrics/
```

## Entry points

| Command | Runs |
|---|---|
| `npm test` | every `*.test.mjs` (unit + integration + parity + benchmark + gate) |
| `npm run test:subagents` | `tests/subagents/runner.ts` |
| `npm run gate:eval` | `tests/gate/eval/run.mjs` — 92 fixtures, block-recovery audit, replay probe |
| `npm run bench:model-visible` | `tests/tools/bench/model-visible-baseline.mjs` (`:compare`, `:update`) |
| `npm run bench:piread` | `tests/tools/bench/piread.mjs` — oracle vs daemon vs one-shot, wall-clock only |
| `npm run bench:pibash` | `tests/tools/bench/pibash.mjs` — the same arms for the bash path |
| `npm run audit:bin-diff` | `tests/tools/audit/bin-diff.mjs` — byte differential between two builds of one native tool (`--old`/`--new`, corpus x arg grid, optional `--serve`) |

## Placing a new test

- **unit/** — imports one module, asserts pure behavior. No `pibash`, no daemons.
- **integration/** — spawns a binary/daemon or drives an extension end to end.
- **parity/** — the same input through a native tool and its built-in counterpart.
- **benchmark/** — asserts the `benchmark/` package itself (manifests, workdir, CLI).
- **gate/** — anything asserting permission-gate rules; follow `gate/README.md`.
- **tools/** — a manual driver with no CI assertions: `bench/` measures, `audit/` inspects
  recorded sessions or hunts divergence.

Naming: `<subject>.test.mjs` for suites, `<verb>-<object>.mjs` for drivers
(`block-recovery.mjs`, `hotpath-profile.mjs`). No spec codes (`s8-`, `B12-`) in filenames —
the spec reference belongs in the file header, where it has context.

## Conventions

- Relative paths resolve from the file's own location. A file that needs the repo root does
  `resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')` at depth 2, one `'..'`
  per level. Moving a file means re-deriving every `../` in it.
- Scratch state goes to `mkdtempSync(join(tmpdir(), 'prefix-'))` and the test cleans it up;
  nothing writes into the repo except an explicitly committed fixture.
- Fixtures live under `fixtures/`; a suite-specific set gets its own subdirectory.
- Parity suites only prove the code paths the current tree exercises — a ported checker also
  needs fixture tests driving each FAIL branch (the docheck port shipped with a missing
  skills-inventory FAIL path that repo-tree parity could never see, because the real table is
  complete).
- Test expectations come from the oracle's source, never from memory — every wrong expectation
  found while porting doc-check was an invented one.
- `npm test` stays green, and the gate case count does not change without an explicit
  reason (see `gate/README.md`).
