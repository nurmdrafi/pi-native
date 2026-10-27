# Development, sync, and repo layout

## Repo layout

```text
~/.pi/agent/
├── AGENTS.md                 # Always-on behavioral core (kept short & byte-stable)
├── docs/                     # Scoped rule sets — load on demand via AGENTS.md links
├── settings.json             # Provider / model / theme / thinking (no secrets)
├── auth.json                 # API keys — gitignored, copied once per machine
├── models.json               # Custom model defs (glm-5.3-flash)
├── models-store.json         # Catalog cache (machine-local, auto-regenerated)
│
├── skills/                   # one dir per skill: SKILL.md + scripts/ references/ assets/
├── extensions/               # Always-on TS extensions (permission-gate, subagents, handoff)
├── agents/                   # Subagent definitions
├── rust-tools/             # Rust workspace: piread, piedit, pibash, pidx
├── benchmark/                # Model-graded benchmark tasks + validators; runs/ = wall-clock harness reports
├── scripts/                  # Repo tooling (bootstrap, agents-lint, gate-eval; doc:check runs the native docheck binary)
├── prompts/                  # /command prompt templates (/issue, /ship, /update-changelog)
├── tests/                    # Node test runner suite (permission-gate, parity, doc-check)
├── .github/workflows/        # Release CI/CD
├── package.json              # husky + commitlint (conventional commits)
│
├── README.md
├── CHANGELOG.md              # Harness change log, latest-first
├── .nvmrc                    # Pins Node 24
└── .gitignore                # Secrets/caches hygiene
```

**Not bundled** (machine-local, auto-regenerated): `bin/`, `npm/`, `git/`, `sessions/`, `audit-reports/`, `handoff/`, `skills/**/node_modules/`, `*.log`.

## Requirements

| Requirement  | Detail                                                |
| ------------ | ----------------------------------------------------- |
| Node.js      | ≥ 22.19 (`.nvmrc` pins 24, the current LTS)           |
| OS           | macOS or Linux                                        |
| Terminal     | Any modern terminal                                   |
| tmux         | Only if using subagents — see [Subagents](subagents.md) |
| Rust (cargo) | Builds the native tools `piread`, `piedit`, `pibash`, and `pidx` |
| Git          | For sync; `~/.pi/agent` is itself a repo              |

Native tools are default-on and opt out per tool: `PI_NATIVE_READ=0`, `PI_NATIVE_EDIT=0`, `PI_NATIVE_BASH=0`, `PI_NATIVE_PIDX=0` — each fails open to the built-in tool or Node parser. Bootstrap prints the rustup command if cargo is missing.

## Providers

`zai` is the default provider (`glm-5.3`; `models.json` adds `glm-5.3-flash` with a 1M context window and reasoning). `deepseek` is available via `/model`. Keys live only in `auth.json`; pi also accepts `ZAI_API_KEY` / `DEEPSEEK_API_KEY` but does not auto-load any `.env`.

## Machine-local (gitignored, never synced)

| Path                      | Why                                                                               |
| ------------------------- | --------------------------------------------------------------------------------- |
| `auth.json`               | Secrets — copy once per machine                                                   |
| `bin/`                    | Platform binaries, rebuilt per machine                                            |
| `npm/`, `git/`            | pi-managed package stores, re-created on next install                             |
| `skills/**/node_modules/` | Per-skill deps — regenerable via `npm install` in the skill dir                   |
| `models-store.json`       | Provider model catalog (regenerable cache)                                        |
| `sessions/`               | Session history, keyed by absolute project paths → per-machine                    |
| `audit-reports/`, `handoff/` | Dated audit artifacts and handoff drafts; reports name private projects        |
| `*.log`, `logs/`          | Debug logs and gate telemetry                                                     |

Everything else — `AGENTS.md`, `docs/`, `settings.json`, `models.json`, `skills/`, `extensions/`, `agents/`, `prompts/`, `tests/`, `rust-tools/` (workspace + lockfile), `.github/workflows/`, `package.json`, `CHANGELOG.md`, `LICENSE`, `.nvmrc` — is tracked in git and portable across OSes.

## Sync between machines

```sh
# Machine A (source of changes)
cd ~/.pi/agent && git add -A && git commit -m "harness: <what>" && git push

# Machine B
cd ~/.pi/agent && git pull
# fresh clone instead? sh scripts/bootstrap.sh (deps + shims + native tools + health check)
```

`auth.json` (secrets) is copied manually **once per machine** via `scp` (or `/login` per provider). It is never in git. On key rotation, update it on each machine.

## Maintaining this harness

Every repo script is exposed through `package.json` — run `npm run <name>` from the repo root.

| Script              | Command                  | What it does                                                                 |
| ------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `bootstrap`         | `sh scripts/bootstrap.sh` | Fresh clone → working setup: npm deps, pi links, `pidoc` shim, Rust tool builds. Never installs toolchains; prints the command instead |
| `after-pull`        | `sh scripts/after-pull.sh` | Post-pull re-sync (run automatically by husky `post-merge`/`post-rewrite`): refresh deps when the lockfile moved, recreate the shim, rebuild stale native tools, then `pidoc --fix` |
| `link-pi`           | `node scripts/link-pi.mjs` | Links the host pi packages into the gitignored `node_modules` so extensions and tests resolve their imports |
| `typecheck`         | `tsc -p tsconfig.json`    | Links pi, then type-checks the TypeScript extensions                       |
| `test`             | `node --test`             | Full suite: permission-gate, parity, and doc-check suites                  |
| `test:subagents`    | `node --test`             | Subagent unit suite (mock-based, no tmux or model needed)                  |
| `lint:agents`       | `node scripts/agents-lint.mjs` | AGENTS.md lint — flags duplicated rules and contradictory directives (one JSON line) |
| `doc:check`         | `~/.pi/agent/bin/docheck` | Verifies harness commands, paths, tool and env-var inventories declared in markdown actually resolve (native Rust port; the former `scripts/doc-check.mjs` is deleted) |
| `gate:eval`         | `node tests/gate/eval/run.mjs` | Aggregates the fixture suite with the block-recovery and bash-replay audits; prints one final JSON metrics line |
| `check`             | all of the above          | typecheck → agents lint → doc check → tests; the full pre-commit gate        |

Conventional commits are enforced by husky + commitlint. Release CI extracts the version from `CHANGELOG.md` on push to `main`.

### Update when

| File                           | Update when                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| [`CHANGELOG.md`](../CHANGELOG.md) | every harness change (what / why / risk / measured delta)         |
| `README.md`                    | structure, skill roster, budget, or sync/portability contract change |

**Goal:** smaller, more stable, cache-friendly, rg-first, fully portable harness.

## Always-on extensions (summary)

- **`permission-gate/`**, **`subagents/`** — see their own docs; full rule catalog and hook tables: [`extensions/README.md`](../extensions/README.md).
- **`piread/`, `piedit/`, `pibash/`, `pidx/`** — register the native tools ([native tools](native-tools.md)).
- **`compact-editor/`** — caps the prompt editor height (default 10 lines, `PI_COMPACT_EDITOR_LINES`) so a long prompt or paste cannot push the transcript off screen; keeps the buffer head and tail with an `[... N more lines ...]` notice between them.
- **`self-heal/`** — on `session_start` runs `scripts/sync-agent-bin.mjs` so the shell PATH pin, native binaries, and the PCRE2 `rg` stay correct after a pull, a pi update, or on a fresh machine. Idempotent, never compiles, never throws, and silent when healthy.
- **`handoff/`** — `/handoff <goal>` drafts a context-transfer prompt from the session, opens it in the editor, then opens the new session with the draft; nothing is written to disk.

Raw events (tool errors, guard blocks) land in pi's native `sessions/**/*.jsonl` — the audit toolkit derives every signal from there.

pi also runs with the built-in MCP extension disabled; the tool defaults in `settings.json` remove `bash`, `read`, and `edit` in favor of the native equivalents.
