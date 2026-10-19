# pi-native

A personal pi coding-agent harness: first-class Rust tools with a fail-open fallback ladder, a 24-rule fail-closed permission gate, and skills that pass a validator before they load.

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

- **Native Rust tools replace the built-ins** — `piread`, `piedit`, `pibash`, `pidx` dispatch through a persistent `--serve` daemon: 0.03–0.18 ms faster per call, 7.0× on 1 MiB edits, and every failure falls back one-shot → built-in, so the session never breaks.
- **94% less model-visible output** — deterministic, idempotent compaction keeps reads and shell output under a ~2 KB ceiling without losing the tail, the errors, or the continuation notice.
- **Discipline at the tool-call level** — a 24-rule fail-closed permission gate, subagents gated off by default (zero prompt tokens until triggered), and skills that must pass a validator before they load.

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
    M(["🧠 agent turn"]) --> PG{"🛡️ permission-gate<br/>24 rules · fail-closed"}
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

Every rung byte-matches the one below it (parity-pinned by tests); `details.via` records which rung served the call. Deep dive: [docs/custom-tools-architecture.md](docs/custom-tools-architecture.md).

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
