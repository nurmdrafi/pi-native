# Contributing

Time to first PR: **about 30 minutes** for a docs or rule change, an afternoon for
a native-tool change (the Rust crates pin their output against the built-in tools,
so every behavioral edit needs the parity suites).

## Set up

```sh
git clone <this repo> && cd agent
sh scripts/bootstrap.sh        # deps, pi package links, native binaries when cargo exists
npm run check                  # typecheck + agents lint + doc check + tests
```

`bootstrap.sh` never installs a toolchain: if `node` or `cargo` is missing it prints
the exact command and exits. Requirements: Node per `.nvmrc` (24) and a Rust
toolchain for `rust-tools/` work.

## Daily loop

| Task | Command |
| --- | --- |
| Full gate | `npm run check` |
| Tests only | `npm test` (add `-- tests/unit/<file>.test.mjs` to scope) |
| One Rust crate | `cargo test -p <crate> --offline` from `rust-tools/` |
| Lints | `npm run typecheck`, `npm run lint:agents` |
| Docs | `npm run doc:check` — verifies documented commands, paths and env vars resolve |
| Gate fixtures | `npm run gate:eval` |
| After a native rebuild | `npm run daemons:kill` (a running daemon serves the old binary) |

Benchmarks and audits are manual drivers, never part of the gate:
`npm run bench:piread`, `npm run bench:piedit`, `npm run bench:pibash`,
`npm run audit:session`, `npm run audit:bin-diff` (see `tests/README.md`).

## Conventions

- **Commits**: Conventional Commits, enforced by commitlint via husky. Body lines
  stay under 72 characters; scope the subject by area (`piread:`, `gate:`, `docs:`).
- **Rules live in one place**: agent-behavior rules go in `AGENTS.md` (loaded every
  session); deeper detail goes in `docs/` and is linked, never restated.
- **Native tools**: they must stay byte-identical to the built-in tools they replace.
  Change one seam at a time and follow `docs/rust-tools-optimization.md` — model the
  cost, freeze the old binary, pin the seam with tests, then run the verification
  ladder including `npm run audit:bin-diff`.
- **Docs**: reference material in `docs/`, session/historical records in `research/`,
  entry points in `tests/README.md`. Run `npm run doc:check` before pushing; the one
  known finding (`rg --max-age`) is the accepted baseline.
- **Never invent literals**: copy route paths, permission strings and env names from
  source (`rg -n` first). `npm run doc:check` catches the env-var half of this.

## Where things live

| Path | Contents |
| --- | --- |
| `extensions/` | TypeScript extensions (permission gate, native tool dispatch) |
| `rust-tools/` | native binaries: `piread`, `piedit`, `pibash`, `pidx`, `docheck` |
| `tests/` | unit, integration, parity, gate, benchmark, tools (bench/audit drivers) |
| `docs/` | reference documentation and plans |
| `skills/` | agent skills, each a `SKILL.md` with YAML frontmatter |

## Pull requests

- Run `npm run check` locally; CI runs the same gate.
- Include the verification output in the description when touching a native tool
  (which suites ran, and any parity or differential evidence).
- Changelog: propose an entry, do not bump versions. The maintainer applies both.
