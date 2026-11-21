# Development and repository maintenance

## Repository layout

`~/.pi/agent/` is the pi-native repository when installed as the Pi agent home.

| Path | Responsibility |
|---|---|
| `AGENTS.md` | Global behavioral core and conditional documentation pointers |
| `docs/` | Scoped design, operations, portability, and architecture references |
| `settings.json`, `models.json` | Tracked Pi configuration and model definitions; never store credentials here |
| `skills/` | On-demand capabilities and their supporting assets |
| `extensions/` | Runtime hooks, tools, and deterministic enforcement |
| `agents/` | Subagent definitions |
| `prompts/` | User-invoked prompt templates |
| `rust-tools/` | Rust implementations of native tools |
| `tests/`, `benchmark/` | Regression, parity, evaluation, and measurement assets |
| `scripts/` | Bootstrap, validation, synchronization, and maintenance scripts |

Machine-local artifacts such as credentials, generated binaries, dependency caches, sessions, and private reports must remain untracked.

## Requirements and setup
Use the versions declared by `.nvmrc` and the Rust toolchain configuration. Follow `README.md` for the current bootstrap command and prerequisites. Bootstrap must report missing toolchains rather than silently installing privileged system dependencies.

## Validation
The authoritative commands are the scripts declared in `package.json`. Run the narrowest relevant test during development and the full repository gate before proposing a complete change when practical.

Do not copy command inventories into this document. Update this page when repository structure or maintenance responsibilities change; use `package.json` as the source of truth for command names.

## Maintaining documentation
- Update `README.md` when user-facing capabilities, installation, supported platforms, or architecture change.
- Update `CHANGELOG.md` for shipped harness changes according to the release policy.
- Update generated rosters only through their source-of-truth definitions and generator.
- Run the documentation checker and agent linter after changing documented paths, commands, environment variables, skills, or subagent definitions.
- Keep machine-specific paths, private project names, credentials, and private service endpoints out of public artifacts.
