# pi-native

A performance-focused Pi coding-agent harness with native Rust tools, fail-closed permission gates, and token-efficient context management.

![pi-native logo](docs/assets/pi-native-logo.jpg)

[![stars](https://img.shields.io/github/stars/nurmdrafi/pi-native?label=stars&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/stargazers)
[![release CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/release.yml?label=release%20CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/release.yml)
[![CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/ci.yml?label=CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/nurmdrafi/pi-native?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/releases)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?logo=opensourceinitiative&logoColor=white&labelColor=24292f&style=flat-square)](LICENSE)
[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/nurmdrafi/badge.svg)](https://hub.xerj.org/contributors/nurmdrafi)
[![pi coding agent](https://img.shields.io/badge/pi-coding_agent-8A2BE2?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/earendil-works/pi-coding-agent)
[![macOS](https://img.shields.io/badge/macOS-6e7681?logo=apple&logoColor=A2AAAD&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=FCC624&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)
[![rust](https://img.shields.io/badge/rust-default-DEA584?logo=rust&logoColor=white&labelColor=24292f&style=flat-square)](#requirements)
[![tmux](https://img.shields.io/badge/tmux-optional-6e7681?logo=tmux&logoColor=1BB91F&labelColor=24292f&style=flat-square)](docs/subagents.md)
[![skills](https://img.shields.io/badge/skills-manual-2563eb?logo=readthedocs&logoColor=8CA1AF&labelColor=24292f&style=flat-square)](docs/skills.md)
[![extensions](https://img.shields.io/badge/extensions-ts-2563eb?labelColor=24292f&style=flat-square)](extensions/README.md)
[![issues](https://img.shields.io/github/issues/nurmdrafi/pi-native?label=issues&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/issues)
[![contributors](https://img.shields.io/github/contributors/nurmdrafi/pi-native?labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/graphs/contributors)
[![last commit](https://img.shields.io/github/last-commit/nurmdrafi/pi-native?label=last%20commit&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/commits/dev)
<br>
[![node](https://img.shields.io/github/badge/node_%E2%A5%BC_22.19_%C2%B7_.nvmrc_24-339933?logo=nodedotjs&logoColor=5FA04E&labelColor=24292f&style=flat-square)](#requirements)

## Why this exists

Coding-agent configs rot — they accumulate always-on prompt bloat, machine-specific paths, and undocumented setup rituals. This harness treats the config as an engineered product: one `~/.pi/agent/` directory that turns any macOS or Linux machine into a fully configured coding-agent workstation in minutes, with a lean behavioral core, progressive-disclosure skills, always-on extensions that enforce discipline at the tool-call level, and a permanent prefix small enough to measure in fractions of a kilotoken. Every harness change ships with a before/after number.

## Trust

- Fail-closed permission gates — every tool call crosses a gate before it runs ([docs/rust-tools-architecture.md](docs/rust-tools-architecture.md))
- No silent fallback — a terminal native-tool failure is a thrown error plus one stderr line, never a masked built-in; built-in selection is explicit configuration ([Daemon → One-Shot Ladder](#daemon--one-shot-ladder), [docs/native-tools.md](docs/native-tools.md))
- MCP runs disabled by default — the built-in extension is off and native tools replace `bash`, `read`, and `edit` ([docs/development.md](docs/development.md))
- Subagents gated and sandboxed — spawn tools are gated, children run in isolated panes under hard conduct bans ([docs/subagent-orchestration.md](docs/subagent-orchestration.md), [docs/subagents.md](docs/subagents.md))
- Supported platforms: macOS and Linux — portability rules are enforced ([docs/design-rules.md](docs/design-rules.md#portability))

## What it does

- Native Rust tools — `piread`, `piedit`, `pibash`, `piwrite`, `pidx` — replace the built-in `read`, `edit`, `bash`, and `write` tools plus session-log parsing, with the same parameters, so a tuned pi setup runs unchanged ([docs/native-tools.md](docs/native-tools.md))
- Every tool call crosses a permission gate before it runs; a broken native tool is a visible error, never a silent fallback ([docs/rust-tools-architecture.md](docs/rust-tools-architecture.md))
- Context stays small by default: windowed reads, bounded diffs, and hard caps on shell output shape what reaches the model ([docs/native-tools.md](docs/native-tools.md))
- Cost is visible by default: the dashboard shows token spend, cache hit rate, and per-session USD budget alerts ([dashboard/](dashboard/))
- Subagents run sandboxed with the gate re-enabled inside; each child declares its write scope, so parallel work never clobbers files ([docs/subagents.md](docs/subagents.md))
- One directory, zero init: clone into `~/.pi/agent`, and every later pull re-checks the setup itself ([docs/zero-init.md](docs/zero-init.md))

### Daemon → One-Shot Ladder
Each native utility runs the same **two-rung ladder**: a **persistent background daemon process (`--serve`)** over NDJSON stdio, then a **one-shot CLI spawn** when the daemon transport fails. There is no third rung and no functional fallback: a terminal failure — missing binary, unhandled panic, unparseable output — is a thrown tool error plus one stderr line, so a broken binary is visible instead of silently masked. Choosing pi's built-in tool instead is configuration: leave the extension out, or set the permission-gate `nativeReadFirst` / `nativeBashFirst` rules to `off`.

## Quick start

Node, pi, the repo — then bootstrap. Prereqs: git; tmux only for subagents.

```sh
# 1. Node ≥ 22.19 (`.nvmrc` pins 24)
nvm install 24

# 2. Install pi (official installer; pins deps, adds `pi update`)
curl -fsSL https://pi.dev/install.sh | sh

# 3. Clone the harness into pi's config dir
git clone https://github.com/nurmdrafi/pi-native.git ~/.pi/agent

# Additionally, per machine — copy extras from an existing machine
scp <your-other-machine>:~/.agents/skills/* ~/.pi/agent/skills/  # private skills, not in the repo
scp <your-other-machine>:~/.pi/agent/auth.json ~/.pi/agent/      # secrets — or /login per provider inside pi
```

After bootstrap, later `git pull`s re-check the setup automatically — husky `post-merge`/`post-rewrite` run `scripts/after-pull.sh`: refresh npm deps when the lockfile moved, recreate the `pidoc` shim, rebuild Rust tools when stale, then run `pidoc --fix`. Safe non-privileged fixes apply automatically; missing toolchains are reported, never installed.

Verify and start pi:

```console
$ ~/.pi/agent/bin/pidoc
# expect 0 FAIL (warnings OK — e.g. no cargo yet means session-audit uses its Node fallback)

$ pi
# First run regenerates npm/, git/, models-store.json automatically; bin/ came from bootstrap.
```

Optional, for subagents: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

Add `bin/` to your `PATH` so your own terminals resolve the same tools — zsh: `~/.zshenv`, bash: `~/.bashrc`:

```sh
export PATH="$HOME/.pi/agent/bin:$PATH"
```

`bin/` is gitignored and regenerated. It holds `rg` (built with PCRE2), `piread`, `piedit`, `pibash`, `piwrite`, `pidx`, `fd`, and `pidoc`. `pidoc` verifies all of them — look for the `rg-pcre2`, `piread`, and `shell-path` rows.

## Requirements

| Requirement  | Detail                                                |
| ------------ | ----------------------------------------------------- |
| Node.js      | ≥ 22.19 (`.nvmrc` pins 24, the current LTS)           |
| OS           | macOS or Linux                                        |
| Rust (cargo) | Builds the native tools                               |
| tmux         | Only for subagents — [docs/subagent-orchestration.md](docs/subagent-orchestration.md) |
| Git          | For sync; `~/.pi/agent` is itself a repo              |

Native tools register unconditionally and always execute the Rust binary; no env switch turns one off or hands the work to a built-in. Choosing pi's built-in `read`/`bash`/`edit` is configuration: do not load that extension, or flip the permission-gate rule that steers calls to it (`nativeReadFirst` / `nativeBashFirst` in `extensions/permission-gate/config.json`, or `PGATE_CONFIG`).

## Benchmarks

![Chart: native-tool latency versus built-in baselines (panel A) and per-tool throughput, 32 MiB per op, native versus baseline (panel B)](docs/assets/benchmarks/all-tools.svg)

Numbers in text, beside the chart — representative p50, native vs built-in on matched workloads: `piwrite` 4 KB write **2.1x** faster, `piedit` 1 MiB edit **2.7x**, `piread` small reads **~3.4x**; a warm log re-scan drops 2.1 s to 28 ms. Peak RSS on identical workloads: the built-in path holds **24x-142x** more memory than the native tools — 110,128 KiB vs 2,300 KiB on a windowed read, 410,304 KiB vs 2,888 KiB on a 100 MB write (p50, `/usr/bin/time -v`).

Reproduce every figure: the harness and raw results ship in-tree — [benchmark/runs/](benchmark/runs/), [benchmark/rss-arm/](benchmark/rss-arm/), [piwrite raw frame](benchmark/piwrite/results/results-2026-11-05-rawframe3.ndjson). Regenerate with `npm run bench:piread` / `bench:piedit` / `bench:pibash`; the memory arm runs `node benchmark/rss-arm/bench.mjs --full --tag v1`; the throughput tables behind panel B print from `node tests/tools/bench/{piread,pibash,piedit,pidx}.mjs --throughput` and `node benchmark/piwrite/bench.mjs --throughput`.

Methodology: tool-call-boundary microbenchmarks (dispatch / serve protocol), not agent-level task runs; p50 per op, one representative case per tool — full raw data under [benchmark/](benchmark/).

## Architecture

<p align="center">
  <img src="docs/assets/diagrams/pi-native-architecture-dark.png" alt="pi-native architecture" width="960" />
</p>

▶ Explore the interactive view: [pi-native architecture](https://htmlpreview.github.io/?https://github.com/nurmdrafi/pi-native/blob/main/docs/assets/diagrams/pi-native-architecture.html)

Every rung byte-matches the one below it (parity-pinned by tests); `details.via` records which rung served the call. Deep dive: [docs/rust-tools-architecture.md](docs/rust-tools-architecture.md).

## Native tools

| Tool     | Replaces                | One line                                                    |
| -------- | ----------------------- | ----------------------------------------------------------- |
| `piread` | built-in `read`         | windowed reads with head-tail compaction                    |
| `piedit` | built-in `edit`         | bounded diffs, Anchor Guard parity                          |
| `pibash` | built-in `bash`         | command-aware output shaping, spill file                    |
| `piwrite` | built-in `write`       | content piped as raw stdin bytes, parent dirs created       |
| `pidx`   | Node session-log parser | incremental extracts, pointer-only output                  |

Tools, env keys, benchmarks, and context-shaping tables: [docs/native-tools.md](docs/native-tools.md).

## Subagent orchestration

A built-in runtime for parallel children: each spawn declares its write scope, an overlapping spawn queues FIFO behind the owner, and disjoint work stays fully parallel — no more hand-planning around file collisions. Per-child budgets (wall-clock, turns, USD) are enforced with stops, only summaries return to the parent, and the dashboard tracks each child's health and cost live. Deep dives: [docs/subagents.md](docs/subagents.md) · [docs/subagent-orchestration.md](docs/subagent-orchestration.md) · [extensions/subagents/README.md](extensions/subagents/README.md)

## Skills & subagents

All skills are manual (`/skill:<name>`) and validator-enforced; bodies enter context only when invoked — [docs/skills.md](docs/skills.md). Subagents run on tmux, are gated off by default, and spawn sandboxed with the permission-gate re-enabled inside — [docs/subagents.md](docs/subagents.md).

## Environment keys

Every native-tool spawn re-sets the session keys from the live tool context (`extensions/pibash/index.ts`); subagent workers get their identity keys on spawn (`extensions/subagents/index.ts`). User-set knobs pass through the same environments:

| Key                   | Set by     | Carries                                                        |
| --------------------- | ---------- | -------------------------------------------------------------- |
| `PI_SESSION_ID`       | pibash     | current session id                                             |
| `PI_SESSION_FILE`     | pibash     | session file path                                              |
| `PI_PROVIDER`         | pibash     | active model provider                                          |
| `PI_MODEL`            | pibash     | active model id                                                |
| `PI_REASONING_LEVEL`  | pibash     | thinking level, when one is active                             |
| `PI_CODING_AGENT_DIR` | override   | agent config dir (default `~/.pi/agent`); forwarded to workers |
| `PI_SUBAGENT_NAME`    | subagents  | worker display name                                            |
| `PI_SUBAGENT_MAX_CONCURRENT` | user | cap on simultaneous subagent spawns (default 5; <1 unlimited) |
| `PI_PIDX_MAX_INLINE`  | user       | pidx inline-output cap before spill (default 2000)             |
| `PI_DASH_PORT`        | user       | dashboard server port (`npm run dashboard`; default 8787)      |
| `PI_DASH_SESSIONS_DIR`| user       | dashboard sessions tree to index (default `~/.pi/agent/sessions`) |
| `PI_DASH_SESSION_BUDGET` | user  | dashboard per-session cost budget in USD for alerts (0 disables) |

Workers also inherit the internal parent-to-child plumbing (`PI_SUBAGENT_AGENT`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ALLOWED`, `PI_SUBAGENT_ACTIVITY_FILE`, `PI_SUBAGENT_SURFACE`, `PI_SUBAGENT_AUTO_EXIT`), classified in the env-var allowlist in [rust-tools/docheck/src/main.rs](rust-tools/docheck/src/main.rs).

## Docs

- [Native tools](docs/native-tools.md) — tools, env keys, performance, context shaping
- [Skills](docs/skills.md) — roster and validator-enforced layout
- [Subagents](docs/subagent-orchestration.md) — gating, sandboxing, agent table
- [Design rules](docs/design-rules.md) — context layers, token budget, portability
- [Development](docs/development.md) — repo layout, scripts, sync, providers
- [extensions/README.md](extensions/README.md) — extension and permission-gate rule catalog
- [CHANGELOG.md](CHANGELOG.md) — every change with what / why / risk / measured delta

## Development

```sh
npm run check         # typecheck → agents lint → doc check → tests
npm run gate:eval     # permission-gate fixture metrics
npm run daemons:kill  # kill stale native daemons after a rebuild
```

Full script table, sync workflow, and machine-local paths: [docs/development.md](docs/development.md).

## License

[MIT](LICENSE) © nurmdrafi
