# pi-native

A performance-focused Pi coding-agent harness with native Rust tools, fail-closed permission gates, and token-efficient context management.

![pi-native logo](docs/assets/pi-native-logo.jpg)

[![stars](https://img.shields.io/github/stars/nurmdrafi/pi-native?label=stars&logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/stargazers)
[![release CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/release.yml?label=release%20CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/release.yml)
[![release](https://img.shields.io/github/v/release/nurmdrafi/pi-native?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/releases)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?logo=opensourceinitiative&logoColor=white&labelColor=24292f&style=flat-square)](LICENSE)
[![pi coding agent](https://img.shields.io/badge/pi-coding_agent-8A2BE2?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/earendil-works/pi-coding-agent)
[![macOS](https://img.shields.io/badge/macOS-6e7681?logo=apple&logoColor=A2AAAD&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=FCC624&labelColor=24292f&style=flat-square)](docs/design-rules.md#portability)
[![rust](https://img.shields.io/badge/rust-default-DEA584?logo=rust&logoColor=white&labelColor=24292f&style=flat-square)](#requirements)
[![tmux](https://img.shields.io/badge/tmux-optional-6e7681?logo=tmux&logoColor=1BB91F&labelColor=24292f&style=flat-square)](docs/subagents.md)
[![skills](https://img.shields.io/badge/skills-manual-2563eb?logo=readthedocs&logoColor=8CA1AF&labelColor=24292f&style=flat-square)](docs/skills.md)
[![extensions](https://img.shields.io/badge/extensions-ts-2563eb?labelColor=24292f&style=flat-square)](extensions/README.md)
<br>
[![node](https://img.shields.io/badge/node_%E2%A5%BC_22.19_%C2%B7_.nvmrc_24-339933?logo=nodedotjs&logoColor=5FA04E&labelColor=24292f&style=flat-square)](#requirements)

## Why this exists

Coding-agent configs rot — they accumulate always-on prompt bloat, machine-specific paths, and undocumented setup rituals. This harness treats the config as an engineered product: one `~/.pi/agent/` directory that turns any macOS or Linux machine into a fully configured coding-agent workstation in minutes, with a lean behavioral core, progressive-disclosure skills, always-on extensions that enforce discipline at the tool-call level, and a permanent prefix small enough to measure in fractions of a kilotoken. Every harness change ships with a before/after number.

## What it does

The pi-native harness optimizes agent execution loops by replacing built-in tool functionalities with **five** native Rust crates. It functions as a **transparent, high-throughput co-processor**, offloading heavy string validation, windowed file reading, and shell output filtering from the single-threaded Node.js event loop while maintaining strict parity with the upstream platform API.

### Three-Rung Fallback Ladder Pipeline
Each native utility is integrated into a **three-rung fail-open ladder** consisting of a **persistent background daemon process (`--serve`)** communicating over an NDJSON socket, a **one-shot CLI spawn** fallback process, and a **TypeScript built-in oracle**. This **architectural ladder design** ensures that any structural signature variance or unhandled native panic degrades smoothly to default platform behavior, ensuring that the active agent session never breaks.

*   **`piread` (Windowed Context Truncation Driver):** Replaces default text file reading routines by deploying **windowed reads with head-tail compaction**. The **persistent daemon path** operates at a p50 latency threshold of **0.03 to 0.39 ms** below the built-in tool across all **seven** corpora, keeping the transcript completely byte-identical on cases within the budget.
*   **`piedit` (Fuzzy Normalized Diff Processor):** Optimizes file modification operations via **exact-then-fuzzy matching (NFKC, smart quotes, CRLF)** backed by a **native diff/patch engine**. It delivers a **2.7x** performance acceleration over standard tools on **1 MiB** source files while maintaining **Anchor Guard parity** and strict line-coverage tracking.
*   **`pibash` (Command-Kind Output Stream Filter):** Implements **command-kind-aware compression**, **run deduplication**, and low-overhead **ANSI strip processing**. High-volume console output that breaches token thresholds is automatically captured via a **spill-to-file fallback** that outputs a recovering path.
*   **`pidx` (Byte-Offset Spending Cache Indexer):** Scans multi-megabyte log assets incrementally by preserving raw file byte pointer offsets via a **stateful size and modified-time (`mtime`) cache**. It parses a **110 MB** execution log trace down to a **15 MB** caching envelope in approximately **0.2 seconds** to calculate real-time model spend profiles from the cache.
*   **`docheck` (Markdown Syntax and Inventory Linter):** Audits markdown command blocks, terminal parameter flags, directory paths, tool inventories, and environment variable allowlists, completing **structural validation sweeps** across **697** distinct files in **1.9 seconds**.

### Stream Compression and Permission Interception Loops
*   **Deterministic Head-Tail Output Compaction:** Clamps streaming console blocks and reading inputs at a hard **40-line / 2 KB** ceiling using a **deterministic head-tail compaction algorithm**. It compresses **273 KB** of raw log data down to **15.6 KB** of high-density, model-visible context, yielding a **94.3%** reduction in overall token footprints while keeping errors, exit codes, and a certified **omission map** intact.
*   **Fail-Closed Tool-Call Interception Gate:** Evaluates tool execution parameters synchronously against **23** granular safety rules, guarding against path traversal, runaway prompt loops, and destructive shell payloads. Rather than failing the process hard, the gate intercepts violations and employs a **Block + Targeted Fix design** that injects synthetic remediation context straight to the model turn, keeping **92** fixtures green at **93%** one-shot block recovery.
*   **Sandboxed tmux Subagent Sandboxing:** Allocates background worker context within dedicated, **sandboxed tmux workspaces**. Internal **parent-to-child plumbing environment keys** pass tracking values and identity metrics dynamically, keeping subagent context requirements at **zero** tokens until a task is explicitly delegated.

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

# 4. Bootstrap — npm deps, pidoc shim, Rust tool builds (cargo missing is reported, never auto-installed)
sh ~/.pi/agent/scripts/bootstrap.sh
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

`bin/` is gitignored and regenerated. It holds `rg` (built with PCRE2), `piread`, `piedit`, `pibash`, `pidx`, `fd`, and `pidoc`. `pidoc` verifies all of them — look for the `rg-pcre2`, `piread`, and `shell-path` rows.

## Requirements

| Requirement  | Detail                                                |
| ------------ | ----------------------------------------------------- |
| Node.js      | ≥ 22.19 (`.nvmrc` pins 24, the current LTS)           |
| OS           | macOS or Linux                                        |
| Rust (cargo) | Builds the native tools                               |
| tmux         | Only for subagents — [docs/subagents.md](docs/subagents.md) |
| Git          | For sync; `~/.pi/agent` is itself a repo              |

Native tools are default-on and opt out per tool: `PI_NATIVE_READ=0`, `PI_NATIVE_EDIT=0`, `PI_NATIVE_BASH=0`, `PI_NATIVE_PIDX=0` — each fails open to the built-in tool or Node parser.

## Architecture

```mermaid
flowchart TD
    M(["🧠 agent turn"]) --> PG{"🛡️ permission-gate<br/>23 rules · fail-closed"}
    PG ==>|"⛔ blocked"| BX["✏️ Block + targeted fix —<br/>the model gets the fix, not the failure"]
    PG ==>|"✅ approved"| TC["⚙️ Native tool call<br/>piread · piedit · pibash · pidx"]

    subgraph LADDER["🪜 Fail-open ladder — every rung byte-pinned by parity tests"]
        direction TB
        D1[("🚀 Rung 1 · daemon<br/>bin/tool --serve · persistent NDJSON")]
        D2["📦 Rung 2 · one-shot spawn<br/>bin/tool · same schema"]
        D3["🧭 Rung 3 · built-in oracle<br/>TypeScript tool"]
    end

    TC --> D1
    D1 ==>|"served ⚡ 0.03–0.18 ms faster"| V1(["via = daemon"])
    D1 -.->|"any failure"| D2
    D2 -->|"served"| V2(["via = cli"])
    D2 -.->|"any failure"| D3
    D3 -->|"always answers"| V3(["via = oracle<br/>session never breaks"])

    V1 --> CS["📐 Context shaping<br/>head-tail compaction · ≤ ~2 KB · −94%<br/>keeps the tail, the errors, the notice"]
    V2 --> CS
    V3 --> CS
    CS ==>|"shaped answer"| M

    M -.- SK["📚 Skills — validator-enforced<br/>manual /skill:name · zero tokens until invoked"]
    M -.- SA["🤖 Subagents — tmux sandbox<br/>gated off by default · gate re-enabled inside"]

    classDef turn fill:#8957e5,stroke:#bc8cff,color:#ffffff
    classDef gate fill:#1f6feb,stroke:#58a6ff,color:#ffffff
    classDef blocked fill:#b62324,stroke:#f85149,color:#ffffff
    classDef tools fill:#161b22,stroke:#8b949e,color:#f0f6fc
    classDef rung fill:#238636,stroke:#3fb950,color:#ffffff
    classDef oracle fill:#9e6a03,stroke:#d29922,color:#ffffff
    classDef served fill:#0d1117,stroke:#30363d,color:#58a6ff
    classDef shape fill:#8957e5,stroke:#bc8cff,color:#ffffff
    classDef side fill:#0d1117,stroke:#30363d,color:#8b949e
    class M turn
    class PG gate
    class BX blocked
    class TC tools
    class D1,D2 rung
    class D3 oracle
    class V1,V2,V3 served
    class CS shape
    class SK,SA side
    style LADDER fill:#0d1117,stroke:#238636,color:#f0f6fc
```

Every rung byte-matches the one below it (parity-pinned by tests); `details.via` records which rung served the call. Deep dive: [docs/rust-tools-architecture.md](docs/rust-tools-architecture.md).

## Native tools

| Tool     | Replaces                | One line                                                    |
| -------- | ----------------------- | ----------------------------------------------------------- |
| `piread` | built-in `read`         | windowed reads with head-tail compaction                    |
| `piedit` | built-in `edit`         | bounded diffs, Anchor Guard parity                          |
| `pibash` | built-in `bash`         | command-aware output shaping, spill file                    |
| `pidx`   | Node session-log parser | incremental extracts, pointer-only output                  |

Tools, env keys, benchmarks, and context-shaping tables: [docs/native-tools.md](docs/native-tools.md).

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
| `PI_SUBAGENT_MAX_CONCURRENT` | user | cap on simultaneous subagent spawns (default 3; <1 unlimited) |
| `PI_PIDX_MAX_INLINE`  | user       | pidx inline-output cap before spill (default 2000)             |

Workers also inherit the internal parent-to-child plumbing (`PI_SUBAGENT_AGENT`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ID`, `PI_SUBAGENT_ALLOWED`, `PI_SUBAGENT_ACTIVITY_FILE`, `PI_SUBAGENT_SURFACE`, `PI_SUBAGENT_AUTO_EXIT`), classified in the env-var allowlist in [rust-tools/docheck/src/main.rs](rust-tools/docheck/src/main.rs).

## Docs

- [Native tools](docs/native-tools.md) — tools, env keys, performance, context shaping
- [Skills](docs/skills.md) — roster and validator-enforced layout
- [Subagents](docs/subagents.md) — gating, sandboxing, agent table
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
