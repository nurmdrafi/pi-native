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
├── rust-tools/             # Rust workspace: piread, piedit, pibash, piwrite, pidx
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
| Rustup       | Builds the native tools; see [Rust tool development](#rust-tool-development) |
| Git          | For sync; `~/.pi/agent` is itself a repo              |

Native tools register unconditionally and always run the Rust binary; nothing opts out via env. Choosing pi's built-in `read`/`bash`/`edit` is configuration: leave that extension out, or set the permission-gate `nativeReadFirst` / `nativeBashFirst` rules to `off`. Bootstrap reports missing Cargo.

## Rust tool development

1. Install [Rustup](https://rustup.rs/) using its official instructions and open a new shell. It supplies Cargo, the Rust build tool and package manager.
2. Open the [`rust-tools/`](../rust-tools/) workspace in your editor. Enable the [Rust Analyzer extension](https://rust-analyzer.github.io/book/) for completion and inline diagnostics. The workspace's [toolchain file](../rust-tools/rust-toolchain.toml) pins Rust and requests the Rust Analyzer and Clippy components. Rustup supplies them when the workspace toolchain is used.
3. Check early and lint before review. Run from the repo root:

   ```sh
   cd rust-tools
   cargo check --workspace --locked
   cargo clippy --workspace --locked
   rust-analyzer --version
   ```

   `cargo check` skips final code generation; use it during edits. Use `cargo test --locked -p <crate>` for behavior changes and a release build only when you need an executable. Set the editor's Rust Analyzer **Check Command** to `clippy` if you want lint diagnostics on save.

## Web research setup

Bootstrap and the pull hook install the pinned Rust-based [Brave Search CLI](https://github.com/brave/brave-search-cli) into local `bin/` when missing and check the static reader's npm dependencies. Search requires your own [Brave Search API key](https://api-dashboard.search.brave.com/): set `BRAVE_SEARCH_API_KEY` outside Pi, or run `bx config set-key` interactively in your terminal. The pull hook never asks for or transfers credentials. The [web-search skill](../skills/web-search/SKILL.md) covers search and known-URL reading.

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
| `sessions/`               | **Session transcript** — live session history, one JSONL per session (see [Session directories](#session-directories)) |
| `audit-reports/`, `handoff/` | Dated audit artifacts and handoff drafts; reports name private projects        |
| `*.log`, `logs/`          | Debug logs only — no gate telemetry writer (that store was removed)               |
| `trust.json`             | pi-core project-trust store — removed and never recreated: `settings.json` ships `defaultProjectTrust: always`, so the trust ask never runs. Vendor-owned (`ProjectTrustStore` in pi-core); `-na`/`--no-approve` distrusts a run |

Everything else — `AGENTS.md`, `docs/`, `settings.json`, `models.json`, `skills/`, `extensions/`, `agents/`, `prompts/`, `tests/`, `rust-tools/` (workspace + lockfile), `.github/workflows/`, `package.json`, `CHANGELOG.md`, `LICENSE`, `.nvmrc` — is tracked in git and portable across OSes.

### Session directories

A **session transcript** is the JSONL log pi writes per session, at
`sessions/<cwd-slug>/<ISO-timestamp>_<session-uuid>.jsonl`. The directory slug is the
session's absolute cwd with `/` replaced by `-` and wrapped in `--` (e.g.
`--<user>-<proj>--`). Each line is one event: messages, tool calls with full params,
tool results.

Three different directories are named `sessions`. They are not interchangeable — only
the first is live:

| Path | Purpose | What is there |
| ---- | ------- | ------------- |
| `~/.pi/agent/sessions/` | **Live transcripts** — every run appends here; canonical source for audits | One JSONL per session in `<cwd-slug>/` dirs; newest is the current session. Gitignored (`/sessions/`) as per-machine data. |
| `~/.pi/backup/sessions/` | **Frozen snapshot** — a manual/one-off copy taken before a reset or migration; nothing writes to it now | Strictly older than the live set; holds transcripts the live dir lacks, so it can be the only copy of those. |
| `~/.pi/bench/sessions/` | **Benchmark fixtures** — inputs to the bench harness, not real work | One JSONL per run dir (`direct-r*`, `gate-on-r*`, `gate-block-r*`). Regenerable by re-running the bench, safe to delete. |

**There is no `~/.pi/sessions/`.** The config root holds only `agent/`, `backup/`,
`bench/`, `efforts/`, and `node_modules/` — every transcript lives under one of the
three paths above. A note or memory that cites `~/.pi/sessions/` is wrong; do not look
there.

- The transcript is the superset of what the TUI renders; collapsed output is present
  in the file.
- It is the **agent** transcript, not the user's shell history — typed shell commands
  live in the shell's own history file, a different store.
- Query it through the [session-audit skill](../skills/session-audit/SKILL.md) (`pidx`
  for compact extracts); that skill forbids reading raw JSONL directly.

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
| `bootstrap`         | `sh scripts/bootstrap.sh` | Fresh clone → project dependencies, Pi links, native builds, and health check. Reports missing system prerequisites. |
| `after-pull`        | `sh scripts/after-pull.sh` | Merge/rebase hook: repairs missing project dependencies and refreshes affected builds, then runs `pidoc --fix`. On an already up-to-date pull, run it directly if you need repair. |
| `link-pi`           | `node scripts/link-pi.mjs` | Links the host pi packages into the gitignored `node_modules` so extensions and tests resolve their imports |
| `typecheck`         | `tsc -p tsconfig.json`    | Links pi, then type-checks the TypeScript extensions                       |
| `test`             | `node --test`             | Full suite: permission-gate, parity, and doc-check suites                  |
| `test:subagents`    | `node --test`             | Subagent unit suite (mock-based, no tmux or model needed)                  |
| `lint:agents`       | `node scripts/agents-lint.mjs` | Lints AGENTS.md and syncs generated agent/skill roster tables; may update `docs/subagent-orchestration.md` and `docs/skills.md` |
| `doc:check`         | `~/.pi/agent/bin/docheck` | Verifies harness commands, paths, tool and env-var inventories declared in markdown actually resolve (native Rust port; the former `scripts/doc-check.mjs` is deleted) |
| `gate:eval`         | `node tests/gate/eval/run.mjs` | Aggregates the fixture suite with the block-recovery and bash-replay audits; prints one final JSON metrics line |
| `audit:blocks`      | `node tests/tools/audit/block-recovery.mjs` | Measures gate-block families and next-action recovery across all session logs |
| `check`             | all of the above          | typecheck → agents lint → doc check → tests → dashboard build; the full pre-commit gate |

Conventional commits are enforced by husky + commitlint. Release CI extracts the version from `CHANGELOG.md` on push to `main`.

Version-gated git flags: `git stash push --staged` needs git ≥2.35 — older exits 129, and a chained `stash pop` then pops a pre-existing stash into conflicts. Never chain `stash pop` after a possibly-failed `stash push`; recover with `git checkout HEAD -- <conflicted>` + `git rm -f <modify/delete>`.

Prompt templates (`prompts/*.md`) expand from a mid-session cache: after editing one, pass arguments as plain text or restart the session before relying on the edited body.

### Update when

| File                           | Update when                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| [`CHANGELOG.md`](../CHANGELOG.md) | every harness change (what / why / risk / measured delta)         |
| `README.md`                    | structure, skill roster, budget, or sync/portability contract change |
| `.github/badges/tests.json`    | test cases added or removed — regenerate with `npm run tests:badge` |

**Goal:** smaller, more stable, cache-friendly, rg-first, fully portable harness.

## Always-on extensions (summary)

- **`permission-gate/`**, **`subagents/`** — see their own docs; full rule catalog and hook tables: [`extensions/README.md`](../extensions/README.md).
- **`piread/`, `piedit/`, `pibash/`, `piwrite/`, `pidx/`** — register the native tools: [native-tools.md](native-tools.md).
- **`compact-editor/`** — caps the prompt editor height (default 10 lines, `PI_COMPACT_EDITOR_LINES`) so a long prompt or paste cannot push the transcript off screen; keeps the buffer head and tail with an `[... N more lines ...]` notice between them.
- **`self-heal/`** — on `session_start` runs `scripts/sync-agent-bin.mjs` so the shell PATH pin, native binaries, and the PCRE2 `rg` stay correct after a pull, a pi update, or on a fresh machine. Idempotent, never compiles, never throws, and silent when healthy.
- **`handoff/`** — `/handoff <goal>` drafts a context-transfer prompt from the session, opens it in the editor, then opens the new session with the draft; nothing is written to disk.

Raw events (tool errors, guard blocks) land in pi's native `sessions/**/*.jsonl` — the audit toolkit derives every signal from there.

pi also runs with the built-in MCP extension disabled; the tool defaults in `settings.json` remove `bash`, `read`, and `edit` in favor of the native equivalents.
