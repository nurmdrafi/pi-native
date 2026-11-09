# pi-native

A measured performance harness for the official Pi coding agent: native Rust tools, fail-closed permission gates, and token-efficient context management layered on top of unmodified Pi.

![pi-native logo](docs/assets/pi-native-logo.jpg)

[![stars](https://img.shields.io/github/stars/nurmdrafi/pi-native?label=stars&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/stargazers)
[![CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/ci.yml?label=CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/ci.yml)
[![tests](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fnurmdrafi%2Fpi-native%2Fmain%2F.github%2Fbadges%2Ftests.json&style=flat-square)](tests/)
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
[![contributors](https://img.shields.io/github/contributors/nurmdrafi/pi-native?labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/graphs/contributors)
<br>
[![node](https://img.shields.io/badge/node-%E2%A5%BC%2022.19%20%C2%B7%20.nvmrc%2024-339933?logo=nodedotjs&logoColor=5FA04E&labelColor=24292f&style=flat-square)](#quick-start)

pi-native is **not** a rewrite of Pi. Full-rewrite Pi forks re-implement the agent itself; pi-native is a performance layer on top of the official agent, [earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent). The agent you run stays the official one; pi-native never forks it.

Your setup is not migrated or replaced. Existing sessions, skills, extensions, and auth keep working where they are: pi-native drops in as the `~/.pi/agent` config directory and swaps the tool layer underneath.

The value proposition: **same Pi, much faster tools + much less context bloat.** Both halves are measured; every number below comes from the benchmark harness that ships in this repo.

## <img src="https://api.iconify.design/withicons-anime/target.svg" height="18" alt="" /> Why this exists

Coding-agent configs rot: they accumulate always-on prompt bloat, machine-specific paths, and undocumented setup rituals. This harness treats the config as an engineered product: one `~/.pi/agent/` directory that turns any macOS or Linux machine into a fully configured coding-agent workstation in minutes, with a lean behavioral core, progressive-disclosure skills, always-on extensions that enforce discipline at the tool-call level, and a permanent prefix small enough to measure in fractions of a kilotoken. Every harness change ships with a before/after number.

## <img src="https://api.iconify.design/withicons-anime/sparkles.svg" height="18" alt="" /> What it does

- Native Rust tools (`piread`, `piedit`, `pibash`, `piwrite`, `pidx`) replace the built-in `read`, `edit`, `bash`, and `write` tools plus session-log parsing, with the same parameters, so a tuned pi setup runs unchanged ([docs/native-tools.md](docs/native-tools.md))
- Every tool call crosses a permission gate before it runs ([docs/rust-tools-architecture.md](docs/rust-tools-architecture.md))
- Context stays small by default: windowed reads, bounded diffs, and hard caps on shell output shape what reaches the model ([docs/native-tools.md](docs/native-tools.md))
- Cost is visible by default: the dashboard shows token spend, cache hit rate, and per-session USD budget alerts ([dashboard/](dashboard/))
- Subagents run sandboxed with the gate re-enabled inside; each child declares its write scope, so parallel work never clobbers files ([docs/subagents.md](docs/subagents.md))
- One directory, zero init: clone into `~/.pi/agent`, and every later pull re-checks the setup itself ([docs/zero-init.md](docs/zero-init.md))
- No silent fallback: native tools always execute the Rust binary, and a terminal failure is a thrown error plus one stderr line; choosing a built-in instead is explicit configuration ([docs/native-tools.md](docs/native-tools.md))

## <img src="https://api.iconify.design/withicons-anime/gauge.svg" height="18" alt="" /> Benchmarks

Measured, p50: Pi Coding Agent built-in tools vs Pi Native Rust tools on matched workloads. Bar lengths are exactly proportional within each row (each row scaled to its own max); rows that trade speed for smaller context explain themselves in the chart notes:

![Chart, two panels: dispatch latency p50 in ms, five workloads, Pi Native 1.4x to 3.5x faster than Pi Coding Agent; and throughput in MB/s, wins from 1.88x to 18x with the pibash pipe 0.70x and pidx cold-index 0.68x losses kept visible in grey](docs/assets/benchmarks/bench-speed.svg)

![Chart, three panels: peak RSS in KiB, 48x to 171x lower on three identical workloads; model-visible context bytes, 273,312 before vs 15,569 after, minus 94.3 percent; and pidx session-log re-scan, cold 2.1 s vs warm 28 ms with ~17x payback](docs/assets/benchmarks/bench-footprint.svg)

## <img src="https://api.iconify.design/withicons-anime/rocket.svg" height="18" alt="" /> Quick start

Node, pi, the repo, then bootstrap. Prereqs: git; Rust (cargo) for the native tools; macOS or Linux; tmux only for subagents.

```sh
# 1. Node ≥ 22.19 (`.nvmrc` pins 24)
nvm install 24

# 2. Install pi (official installer; pins deps, adds `pi update`)
curl -fsSL https://pi.dev/install.sh | sh

# 3. Clone the harness into pi's config dir
git clone https://github.com/nurmdrafi/pi-native.git ~/.pi/agent

# Additionally, per machine, copy extras from an existing machine
scp <your-other-machine>:~/.agents/skills/* ~/.pi/agent/skills/  # private skills, not in the repo
scp <your-other-machine>:~/.pi/agent/auth.json ~/.pi/agent/      # secrets, or /login per provider inside pi
```

After bootstrap, later `git pull`s re-check the setup automatically: husky `post-merge`/`post-rewrite` run `scripts/after-pull.sh`, which refreshes npm deps when the lockfile moved, recreates the `pidoc` shim, rebuilds Rust tools when stale, then runs `pidoc --fix`. Safe non-privileged fixes apply automatically; missing toolchains are reported, never installed.

Verify and start pi:

```console
$ ~/.pi/agent/bin/pidoc
# expect 0 FAIL (warnings OK; e.g. no cargo yet means session-audit uses its Node fallback)

$ pi
# First run regenerates npm/, git/, models-store.json automatically; bin/ came from bootstrap.
```

Optional, for subagents: `brew install tmux` (macOS) or `sudo apt install tmux` (Linux).

Add `bin/` to your `PATH` so your own terminals resolve the same tools (zsh: `~/.zshenv`, bash: `~/.bashrc`):

```sh
export PATH="$HOME/.pi/agent/bin:$PATH"
```

`bin/` is gitignored and regenerated. It holds `rg` (built with PCRE2), `piread`, `piedit`, `pibash`, `piwrite`, `pidx`, `fd`, and `pidoc`. `pidoc` verifies all of them; look for the `rg-pcre2`, `piread`, and `shell-path` rows.

## <img src="https://api.iconify.design/withicons-anime/layers.svg" height="18" alt="" /> Architecture

<p align="center">
  <img src="docs/assets/diagrams/pi-native-architecture-dark.png" alt="pi-native architecture" width="960" />
</p>

▶ Explore the interactive view: [pi-native architecture](https://htmlpreview.github.io/?https://github.com/nurmdrafi/pi-native/blob/main/docs/assets/diagrams/pi-native-architecture.html)

Every tool call follows the same ladder: the extension intercepts the built-in call, the permission gate authorizes it fail-closed, then the Rust binary executes it — a persistent daemon (`--serve`, NDJSON over stdio) on the hot path, a one-shot spawn as fallback. A terminal failure is a thrown tool error plus one stderr line, never a silent built-in run. Daemon and one-shot paths are pinned byte-identical by tests; `details.via` records which path served the call. Deep dive: [docs/rust-tools-architecture.md](docs/rust-tools-architecture.md).

## <img src="https://api.iconify.design/withicons-anime/users.svg" height="18" alt="" /> Skills & subagents

All skills are manual (`/skill:<name>`) and validator-enforced; bodies enter context only when invoked, see [docs/skills.md](docs/skills.md).

A built-in runtime for parallel children: each spawn declares its write scope, an overlapping spawn queues FIFO behind the owner, and disjoint work stays fully parallel, so no more hand-planning around file collisions. Subagents run on tmux, gated off by default, and sandboxed with the permission-gate re-enabled inside. Per-child budgets (wall-clock, turns, USD) are enforced with stops, only summaries return to the parent, and the dashboard tracks each child's health and cost live. Deep dives: [docs/subagents.md](docs/subagents.md) · [docs/subagent-orchestration.md](docs/subagent-orchestration.md) · [extensions/subagents/README.md](extensions/subagents/README.md)

## <img src="https://api.iconify.design/withicons-anime/key.svg" height="18" alt="" /> Environment keys

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

## <img src="https://api.iconify.design/withicons-anime/handshake.svg" height="18" alt="" /> How you can help

- **small**: run any benchmark arm in [benchmark/runs/](benchmark/runs/) on your hardware and file the numbers; host-noise bounds get sharper with every report.
- **small**: docs fixes: broken anchors, stale numbers, clearer quick-start steps.
- **medium**: new skills under [skills/](skills/): one skill, one job, validator-clean (`npm run check`).
- **medium**: portability reports: shells and package managers beyond the tested set (zsh, bash; brew, apt).
- **larger**: pick a losing or parity row in the [benchmarks](#benchmarks) and attack it; the harness, corpus generator, and raw results are all in-tree.

Issues and PRs welcome: [issue tracker](https://github.com/nurmdrafi/pi-native/issues).

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

Requirements: Node ≥ 22.19 (`.nvmrc` pins 24), Rust (cargo) to build the native tools, tmux only for subagents. Bootstrap never installs a toolchain; it prints the command when one is missing.

```sh
sh scripts/bootstrap.sh  # fresh clone → working setup: npm deps, pi links, pidoc shim, Rust builds
npm run check           # typecheck → agents lint → doc check → tests (full pre-commit gate)
npm run gate:eval       # permission-gate fixture metrics (one final JSON line)
npm run daemons:kill    # kill stale native daemons after a rebuild
```

Sync between machines is plain git: push from the source machine, `git pull` on the target (husky re-runs `scripts/after-pull.sh` automatically); `sh scripts/bootstrap.sh` covers a fresh clone. Full script table, providers, and machine-local paths: [docs/development.md](docs/development.md).

## <img src="https://api.iconify.design/withicons-anime/scale.svg" height="18" alt="" /> License

[MIT](LICENSE) © nurmdrafi
