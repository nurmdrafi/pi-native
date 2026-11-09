# pi-native

A measured performance harness for the official Pi coding agent: native Rust tools, fail-closed permission gates, and token-efficient context management layered on top of unmodified Pi.

![pi-native logo](docs/assets/pi-native-logo.jpg)

[![stars](https://img.shields.io/github/stars/nurmdrafi/pi-native?label=stars&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/stargazers)
[![CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/ci.yml?label=CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/ci.yml)
[![tests](https://img.shields.io/github/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnurmdrafi%2Fpi-native%2Fmain%2F.github%2Fbadges%2Ftests.json&style=flat-square)](tests/)
[![release](https://img.shields.io/github/v/release/nurmdrafi/pi-native?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/releases)
[![last commit](https://img.shields.io/github/last-commit/nurmdrafi/pi-native?label=last%20commit&logo=github&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/commits)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?logo=opensourceinitiative&logoColor=white&labelColor=24292f&style=flat-square)](LICENSE)
[![XERJ Corpus Hub contributor](https://hub.xerj.org/contributors/nurmdrafi/badge.svg)](https://hub.xerj.org/contributors/nurmdrafi)
[![pi coding agent](https://img.shields.io/badge/pi-coding_agent-8A2BE2?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/earendil-works/pi-coding-agent)
[![macOS](https://img.shields.io/badge/macOS-6e7681?logo=apple&logoColor=A2AAAD&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=FCC624&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)
[![rust](https://img.shields.io/badge/rust-default-DEA584?logo=rust&logoColor=white&labelColor=24292f&style=flat-square)](#quick-start)
[![tmux](https://img.shields.io/badge/tmux-optional-6e7681?logo=tmux&logoColor=1BB91F&labelColor=24292f&style=flat-square)](docs/subagents.md)
[![skills](https://img.shields.io/badge/skills-manual-2563eb?logo=readthedocs&logoColor=8CA1AF&labelColor=24292f&style=flat-square)](docs/skills.md)
[![extensions](https://img.shields.io/badge/extensions-ts-2563eb?labelColor=24292f&style=flat-square)](extensions/README.md)
[![issues](https://img.shields.io/github/issues/nurmdrafi/pi-native?label=issues&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/issues)
[![contributors](https://img.shields.io/github/contributors/nurmdrafi/pi-native?style=flat-square)](https://github.com/nurmdrafi/pi-native/graphs/contributors)
<br>
[![node](https://img.shields.io/badge/node-%E2%A5%BC%2022.19%20%C2%B7%20.nvmrc%2024-339933?logo=nodedotjs&logoColor=5FA04E&labelColor=24292f&style=flat-square)](#quick-start)

pi-native is **not** a rewrite of Pi Coding Agent. It is a performance layer on top of the official agent, [earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent). The agent you run stays official; pi-native never forks it.

Nothing is migrated or replaced. Existing sessions, skills, extensions, and auth keep working where they are: pi-native drops in as the `~/.pi/agent` config directory and swaps the tool layer underneath.

**Same Pi, much faster tools + much less context bloat.** Both halves are measured; every number below comes from the benchmark harness in this repo.

## <img src="https://api.iconify.design/withicons-anime/target.svg" height="18" alt="" /> Why this exists

Coding-agent configs decay: always-on prompt bloat, machine-specific paths, undocumented setup rituals. This harness treats the config as an engineered product: one `~/.pi/agent/` directory configures a coding-agent workstation on any macOS or Linux machine — lean behavioral core, skills loaded only on invocation, always-on extensions enforcing tool-call rules, permanent prompt prefix under a kilotoken. Every harness change ships with a before/after number.

## <img src="https://api.iconify.design/withicons-anime/sparkles.svg" height="18" alt="" /> What it does

- Native Rust tools (`piread`, `piedit`, `pibash`, `piwrite`, `pidx`) replace `read`, `edit`, `bash`, `write`, and session-log parsing — same parameters, so a tuned pi setup runs unchanged ([docs/native-tools.md](docs/native-tools.md))
- Every tool call crosses a permission gate before it runs ([docs/rust-tools-architecture.md](docs/rust-tools-architecture.md))
- Context stays small by default: windowed reads, bounded diffs, hard output caps ([docs/native-tools.md](docs/native-tools.md))
- Dashboard shows token spend, cache hit rate, and per-session USD budget alerts ([dashboard/](dashboard/))
- Subagents run sandboxed with the gate re-enabled inside; each child declares its write scope, so parallel work never clobbers files ([docs/subagents.md](docs/subagents.md))
- Zero init: clone into `~/.pi/agent`; every later pull re-checks the setup itself ([docs/zero-init.md](docs/zero-init.md))
- No silent fallback: native tools always execute the Rust binary; terminal failure throws an error plus one stderr line; built-ins only by explicit configuration ([docs/native-tools.md](docs/native-tools.md))

## <img src="https://api.iconify.design/withicons-anime/gauge.svg" height="18" alt="" /> Benchmarks

Measured p50, built-in Pi tools vs Pi Native Rust tools, matched workloads. Bars are exactly proportional within each row (each row scaled to its own max); rows trading speed for smaller context say so in the chart notes:

![Chart, two panels: dispatch latency p50 in ms, five workloads, Pi Native 1.4x to 3.5x faster than Pi Coding Agent; and throughput in MB/s, wins from 1.88x to 18x with the pibash pipe 0.70x and pidx cold-index 0.68x losses kept visible in grey](docs/assets/benchmarks/bench-speed.svg)

![Chart, three panels: peak RSS in KiB, 48x to 171x lower on three identical workloads; model-visible context bytes, 273,312 before vs 15,569 after, minus 94.3 percent; and pidx session-log re-scan, cold 2.1 s vs warm 28 ms with ~17x payback](docs/assets/benchmarks/bench-footprint.svg)

## <img src="https://api.iconify.design/withicons-anime/rocket.svg" height="18" alt="" /> Quick start

Prereqs: git; Rust (cargo); macOS or Linux; tmux only for subagents.

```sh
# 1. Node ≥ 22.19 (`.nvmrc` pins 24)
nvm install 24

# 2. Install pi (official installer; pins deps, adds `pi update`)
curl -fsSL https://pi.dev/install.sh | sh

# 3. Clone the harness into pi's config dir
git clone https://github.com/nurmdrafi/pi-native.git ~/.pi/agent

# Per machine: copy extras from an existing machine
scp <your-other-machine>:~/.agents/skills/* ~/.pi/agent/skills/  # private skills, not in the repo
scp <your-other-machine>:~/.pi/agent/auth.json ~/.pi/agent/      # secrets, or /login per provider inside pi
```

Every later `git pull` re-checks the setup: husky `post-merge`/`post-rewrite` run `scripts/after-pull.sh`, which refreshes npm deps when the lockfile moved, recreates the `pidoc` shim, rebuilds stale Rust tools, then runs `pidoc --fix`. It applies safe non-privileged fixes automatically and reports missing toolchains, never installing them.

Verify and start pi:

```
$ ~/.pi/agent/bin/pidoc
# expect 0 FAIL (warnings OK; e.g. no cargo yet means session-audit uses its Node fallback)

$ pi
# First run regenerates npm/, git/, models-store.json automatically; bin/ came from bootstrap.
```

Subagents need tmux: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

Add `bin/` to `PATH` so terminals resolve the same tools (zsh: `~/.zshenv`; bash: `~/.bashrc`):

```sh
export PATH="$HOME/.pi/agent/bin:$PATH"
```

`bin/` is gitignored and regenerated: `rg` (PCRE2 build), `piread`, `piedit`, `pibash`, `piwrite`, `pidx`, `fd`, `pidoc`. `pidoc` verifies all of them; check the `rg-pcre2`, `piread`, and `shell-path` rows.

## <img src="https://api.iconify.design/withicons-anime/layers.svg" height="18" alt="" /> Architecture

<p align="center">
  <img src="docs/assets/diagrams/pi-native-architecture-dark.png" alt="pi-native architecture" width="960" />
</p>

▶ Interactive view: [pi-native architecture](https://htmlpreview.github.io/?https://github.com/nurmdrafi/pi-native/blob/main/docs/assets/diagrams/pi-native-architecture.html)

Every tool call: the extension intercepts the built-in call, the permission gate authorizes it fail-closed, the Rust binary executes it — persistent daemon (`--serve`, NDJSON over stdio) on the hot path, one-shot spawn as fallback. Terminal failure throws a tool error plus one stderr line, never a silent built-in run. Tests pin daemon and one-shot paths byte-identical; `details.via` records the serving path. Deep dive: [docs/rust-tools-architecture.md](docs/rust-tools-architecture.md).

## <img src="https://api.iconify.design/withicons-anime/users.svg" height="18" alt="" /> Skills & subagents

Skills are manual (`/skill:<name>`) and validator-enforced; bodies enter context only when invoked ([docs/skills.md](docs/skills.md)).

Each spawn declares its write scope: overlapping spawns queue FIFO behind the owner; disjoint work runs fully parallel — no hand-planning around file collisions. Subagents run on tmux, gated off by default, sandboxed with the permission gate re-enabled inside. Per-child budgets (wall-clock, turns, USD) stop at the limit; only summaries return to the parent; the dashboard tracks each child's health and cost live. Deep dives: [docs/subagents.md](docs/subagents.md) · [docs/subagent-orchestration.md](docs/subagent-orchestration.md) · [extensions/subagents/README.md](extensions/subagents/README.md)

## <img src="https://api.iconify.design/withicons-anime/key.svg" height="18" alt="" /> Environment keys

Native-tool spawns re-set the session keys from the live tool context (`extensions/pibash/index.ts`); subagent workers get identity keys on spawn (`extensions/subagents/index.ts`). User-set knobs pass through the same environments:

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

## <img src="https://api.iconify.design/withicons-anime/handshake.svg" height="18" alt="" /> How you can help

- **small**: run a benchmark arm from [benchmark/runs/](benchmark/runs/) on your hardware and file the numbers — host-noise bounds sharpen with every report.
- **small**: docs fixes — broken anchors, stale numbers, clearer quick-start steps.
- **medium**: new skills under [skills/](skills/): one skill, one job, validator-clean (`npm run check`).
- **medium**: portability reports — shells and package managers beyond the tested set (zsh, bash; brew, apt).
- **larger**: attack a losing or parity row in the [benchmarks](#benchmarks); the harness, corpus generator, and raw results are in-tree.

Issues and PRs: [issue tracker](https://github.com/nurmdrafi/pi-native/issues).

## <img src="https://api.iconify.design/withicons-anime/book-open.svg" height="18" alt="" /> Docs

- [Native tools](docs/native-tools.md): tools, env keys, performance, context shaping
- [Architecture](docs/rust-tools-architecture.md): dispatch ladder, daemon protocol, per-tool pipelines
- [Skills](docs/skills.md): roster and validator-enforced layout
- [Subagents](docs/subagent-orchestration.md): gating, sandboxing, agent table
- [Zero-init](docs/zero-init.md): the two-rung bootstrap ladder and what the hot path costs
- [Design rules](docs/design-rules.md): context layers, token budget, portability
- [Development](docs/development.md): repo layout, scripts, sync, providers
- [Benchmarks](benchmark/README.md): harness arms, raw runs, filing numbers on your hardware
- [extensions/README.md](extensions/README.md): extension and permission-gate rule catalog
- [CHANGELOG.md](CHANGELOG.md): every change with what / why / risk / measured delta

## <img src="https://api.iconify.design/withicons-anime/terminal.svg" height="18" alt="" /> Development

Requirements: Node ≥ 22.19 (`.nvmrc` pins 24), Rust (cargo) for the native tools, tmux only for subagents. Bootstrap never installs a toolchain; it prints the missing command.

```sh
sh scripts/bootstrap.sh  # fresh clone → working setup: npm deps, pi links, pidoc shim, Rust builds
npm run check           # typecheck → agents lint → doc check → tests (full pre-commit gate)
npm run gate:eval       # permission-gate fixture metrics (one final JSON line)
npm run daemons:kill    # kill stale native daemons after a rebuild
```

Sync is plain git: push from the source machine, `git pull` on the target (husky re-runs `scripts/after-pull.sh`); `sh scripts/bootstrap.sh` covers a fresh clone. Script table, providers, and machine-local paths: [docs/development.md](docs/development.md).

## <img src="https://api.iconify.design/withicons-anime/scale.svg" height="18" alt="" /> License

[MIT](LICENSE) © nurmdrafi
