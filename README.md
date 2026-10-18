# pi-native

[![release CI](https://img.shields.io/github/actions/workflow/status/nurmdrafi/pi-native/release.yml?label=release%20CI&logo=githubactions&logoColor=2088FF&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/actions/workflows/release.yml)
[![release](https://img.shields.io/github/v/release/nurmdrafi/pi-native?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/nurmdrafi/pi-native/releases)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?logo=opensourceinitiative&logoColor=white&labelColor=24292f&style=flat-square)](LICENSE)
[![pi coding agent](https://img.shields.io/badge/pi-coding_agent-8A2BE2?logo=github&logoColor=white&labelColor=24292f&style=flat-square)](https://github.com/earendil-works/pi-coding-agent)
<br>
[![node](https://img.shields.io/badge/node_%E2%A5%BC_22.19_%C2%B7_.nvmrc_24-339933?logo=nodedotjs&logoColor=5FA04E&labelColor=24292f&style=flat-square)](#requirements)
[![macOS](https://img.shields.io/badge/macOS-6e7681?logo=apple&logoColor=A2AAAD&labelColor=24292f&style=flat-square)](#portability)[![Linux](https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=FCC624&labelColor=24292f&style=flat-square)](#portability)
[![rust](https://img.shields.io/badge/rust-default-DEA584?logo=rust&logoColor=white&labelColor=24292f&style=flat-square)](#requirements)
[![tmux](https://img.shields.io/badge/tmux-optional-6e7681?logo=tmux&logoColor=1BB91F&labelColor=24292f&style=flat-square)](#subagents)
[![skills](https://img.shields.io/badge/skills-manual-2563eb?logo=readthedocs&logoColor=8CA1AF&labelColor=24292f&style=flat-square)](#skills)
[![extensions](https://img.shields.io/badge/extensions-ts-2563eb?labelColor=24292f&style=flat-square)](#extensions)

Portable pi harness powered by Rust native tools — lean core, progressive disclosure, zero absolute paths.

A git-synced configuration for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): one `~/.pi/agent/` directory that turns any macOS or Linux machine into a fully configured coding-agent workstation in minutes.

**Why this exists:** coding-agent configs rot — they accumulate always-on prompt bloat, machine-specific paths, and undocumented setup rituals. This harness treats the config as an engineered product: a lean behavioral core, progressive-disclosure skills, always-on extensions that enforce discipline at the tool-call level, and a permanent prefix small enough to measure in fractions of a kilotoken.

- **One directory, one repo** — `git clone` is the entire install; git is the only sync mechanism.
- **Zero env vars required for setup, zero absolute paths** — everything works from the default `~/.pi/agent`.
- **Native tools by default** — `piread`, `piedit`, `pibash`, `pidx` are Rust first-class tools with built-in fallbacks.
- **Measured, not guessed** — every harness change ships with a before/after number.

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [What's inside](#whats-inside)
- [Native tools](#native-tools)
  - [Context shaping: what enters the model](#context-shaping-what-enters-the-model)
- [Skills](#skills)
- [Subagents](#subagents)
- [Extensions](#extensions)
- [Context layers](#context-layers)
- [Always-on token budget](#always-on-token-budget)
- [Portability](#portability)
- [Design rules](#design-rules)
- [Maintaining this harness](#maintaining-this-harness)
- [License](#license)

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
| Terminal     | Any modern terminal                                   |
| tmux         | Only if using subagents — see [Subagents](#subagents) |
| Rust (cargo) | Builds the native tools `piread`, `piedit`, `pibash`, and `pidx` |
| Git          | For sync; `~/.pi/agent` is itself a repo              |

Native tools are default-on and opt out per tool: `PI_NATIVE_READ=0`, `PI_NATIVE_EDIT=0`, `PI_NATIVE_BASH=0`, `PI_NATIVE_PIDX=0` — each fails open to the built-in tool or Node parser. Bootstrap prints the rustup command if cargo is missing.

## What's inside

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
├── custom-tools/             # Rust workspace: piread, piedit, pibash, pidx
├── benchmark/                # Model-graded benchmark tasks + validators
├── codemode/                 # Codemode scripts (non-LLM helpers)
├── scripts/                  # Repo tooling (bootstrap, doc-check, agents-lint, gate-eval)
├── prompts/                  # /command prompt templates (/issue, /ship, /update-changelog)
├── tests/                    # Node test runner suite (permission-gate, parity, doc-check)
├── .github/workflows/        # Release CI/CD
├── package.json              # husky + commitlint (conventional commits)
│
├── README.md                 # This file
├── CHANGELOG.md              # Harness change log, latest-first
├── .nvmrc                    # Pins Node 24
└── .gitignore                # Secrets/caches hygiene
```

**Not bundled** (machine-local, auto-regenerated): `bin/`, `npm/`, `git/`, `sessions/`, `audit-reports/`, `handoff/`, `skills/**/node_modules/`, `*.log`.

## Native tools

Four Rust crates in `custom-tools/` register as their own first-class tools, so the TUI shows `piread` / `piedit` / `pibash` / `pidx` instead of shadowing the built-ins. Parameters match the built-in tool verbatim; dispatch goes through a persistent `--serve` daemon (no per-call process spawn), falling back to a one-shot CLI spawn and then the built-in implementation. Every failure path falls back rather than breaking the session.

| Tool     | Replaces                       | Notes                                                             |
| -------- | ------------------------------ | ----------------------------------------------------------------- |
| `piread` | built-in `read` (text files)   | images stay on `read`                                             |
| `piedit` | built-in `edit`                | edit-kind in permission-gate, so Anchor Guard and coverage binding apply unchanged; native diff/patch render |
| `pibash` | built-in `bash`                | bash-kind in permission-gate, so the H1 cap, R10 re-run guard, and destructive analysis apply unchanged |
| `pidx`   | Node session-log parser        | compact per-session extracts, incremental via a (size, mtime) cache |

Native tools forward the context env keys the built-in tools inject — `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` — so commands see the same `PI_*` context. `PI_CODING_AGENT_DIR` overrides the config directory, `PI_PIDX_MAX_INLINE` changes the inline extract cap (default 2000 chars), and `PI_READ_LINE_CAP` caps piread line width (default off; when set to a positive integer, lines over the cap are truncated to that many characters plus a `...[+N chars]` marker, leaving shorter lines and whitespace byte-identical). `PI_READ_COMPRESS` controls piread's head-tail compaction (**on by default**: a read larger than 40 lines / 2 KB is reduced to a head+tail window with an `[... omitted N chars / M lines ...]` marker, keeping the `[Showing lines A-B of C ...]` notice last; `0`/`false`/`off` restores byte-for-byte parity with the built-in `read`, which is what the parity suite and `piedit`'s exact matching depend on). `PI_READ_BIN` / `PI_EDIT_BIN` / `PI_BASH_BIN` / `PI_PIDX_BIN` override the corresponding native binary path (`bin/<tool>` by default); they exist for the parity suites, which point an extension at a throwaway binary to exercise the one-shot rung, plus non-standard installs — not needed in normal use. `PI_COMPACT_EDITOR_LINES` caps the prompt editor height (default 10 lines); a longer buffer keeps its head and tail with an `[... N more lines ...]` notice in between, so a pasted prompt cannot push the transcript off screen.

Parity is pinned by `tests/piread-parity.test.mjs`, `tests/piedit-parity.test.mjs`, and `tests/pibash-parity.test.mjs`, plus `tests/piedit-diff-fuzz.mjs`. Measured speedups and full methodology live in [`benchmark/runs/`](benchmark/runs) and [`CHANGELOG.md`](CHANGELOG.md).

### Performance

Dispatch latency, p50 ms — `built-in` is the stock pi tool (bash/read/edit), `native` is the replacement. The native tools replace a per-call process spawn with a persistent `--serve` daemon, so the win is the amortized spawn floor (~1.6–1.9 ms here), not output shaping. Absolute numbers are wall-clock on one machine and move with hardware and load; the Δ column is the comparison that matters. For model-context cost (bytes actually entering the transcript) see [Context shaping](#context-shaping-what-enters-the-model) below — that is the other half of the story, and the one that compounds across turns. Sources: [`benchmark/runs/piread-microbench-2026-10-17.md`](benchmark/runs/piread-microbench-2026-10-17.md), [`piedit-microbench-2026-10-17.md`](benchmark/runs/piedit-microbench-2026-10-17.md), [`pibash-microbench-2026-10-17.md`](benchmark/runs/pibash-microbench-2026-10-17.md), [`pibash-microbench-2026-10-18.md`](benchmark/runs/pibash-microbench-2026-10-18.md) (post-fix; † rows) — regenerate with `node tests/<tool>-bench.mjs`.

| Tool     | Replaces        | Representative case                 | built-in p50 | native p50   | Δ p50     |
| -------- | --------------- | ----------------------------------- | -----------: | -----------: | --------- |
| `piread` | built-in `read` | one-line file                       | 0.126 ms     | 0.033 ms     | **−0.09** |
| `piread` | built-in `read` | 2500-line window                    | 0.355 ms     | 0.171 ms     | **−0.18** |
| `piedit` | built-in `edit` | mid exact (1800 B)                  | 0.291 ms     | 0.159 ms     | **−0.13** |
| `piedit` | built-in `edit` | 1 MiB file (588,890 B)              | 29.969 ms    | 4.258 ms     | **7.0×**  |
| `pibash` | built-in `bash` | `printf` †                          | 4.516 ms     | 2.487 ms     | **−2.03** |
| `pibash` | built-in `bash` | `seq 50000` †                       | 10.643 ms    | 13.463 ms    | **+2.82** |
| `pidx`   | Node log parser | 512 sessions / 103 MB (cold → warm) | —            | 572 → 390 ms | **n/a**   |

`pibash`'s `seq 50000` row above is the 2026-10-17 measured regression (+3.57 ms at p50, widening with output size; envelope shipped the payload twice — `content[0].text` + `structuredContent.output` — structural and parity-pinned). **Fixed since** (single-materialization envelope, copy-on-write compression stages, one shared line split — see [`docs/custom-tools-architecture.md`](docs/custom-tools-architecture.md) § pibash): the † rows are re-measured 2026-10-19 on the fixed binary — daemon p50 15.78 → 13.46 ms (oracle gap +3.57 → +2.82 ms) and one-shot p50 19.7 → 13.4 ms (−32%) via `custom-tools/pibash/bench-seq50000.mjs`; wire bytes unchanged, parity pinned. Every other arm now leads the oracle by 1.4–2.7 ms; the residual `seq 50000` gap is the Tier-1 compression pre-pass — work the built-in never does (pibash's additive error-rescue feature). `pidx` is a daemonless one-shot CLI, so it has no oracle/daemon split; its figures are a live cold/warm run on this repo's corpus and have no committed bench file yet.

<details>
<summary>Per-tool detail</summary>

**piread** vs the built-in `read` (N=200/arm, 10 warmup; p50 ms):

| corpus | `read` p50 | `piread` daemon p50 | `piread` one-shot p50 | Δ p50 |
| --- | ---: | ---: | ---: | ---: |
| one-line | 0.126 | 0.033 | 1.885 | −0.092 |
| crlf | 0.121 | 0.040 | 1.846 | −0.081 |
| unicode | 0.123 | 0.039 | 1.915 | −0.083 |
| long-lines | 0.128 | 0.054 | 1.888 | −0.074 |
| lines2500 | 0.355 | 0.171 | 2.064 | −0.184 |
| bytes60k | 0.215 | 0.167 | 2.007 | −0.048 |
| head60k | 0.170 | 0.062 | 1.877 | −0.107 |

`piread` is **byte-identical** to the built-in `read` on every text case that fits the model-visible budget (see `npm run bench:model-visible:compare`); larger reads are head-tail compacted by default, so their content is a bounded window rather than the full 2000-line cap — set `PI_READ_COMPRESS=0` to restore exact parity. The daemon path wins on every corpus (~4x on small reads, ~2x on 2,500 lines), and the one-shot path pays the ~1.9 ms spawn floor.

**piedit** (N=100/arm; oracle vs piedit p50 ms):

| corpus | bytes | oracle p50 | piedit p50 | Δ p50 |
| --- | ---: | ---: | ---: | ---: |
| small-exact | 17 | 0.212 | 0.144 | −0.068 |
| mid-exact | 1800 | 0.291 | 0.159 | −0.132 |
| mid-multi | 1800 | 0.287 | 0.152 | −0.135 |
| fuzzy-trailing-ws | 30 | 0.199 | 0.140 | −0.059 |
| multiline-block | 18890 | 1.049 | 0.264 | −0.784 |
| large-1mib | 588890 | 29.969 | 4.258 | −25.710 |

**pibash** (N=60/arm; oracle vs daemon p50 ms; run of 2026-10-19, post-fix —
[`benchmark/runs/pibash-microbench-2026-10-18.md`](benchmark/runs/pibash-microbench-2026-10-18.md)):

| command class | oracle p50 | pibash p50 | Δ p50 |
| --- | ---: | ---: | ---: |
| true | 4.052 | 2.421 | −1.631 |
| printf | 4.516 | 2.487 | −2.029 |
| rg-version | 5.549 | 4.040 | −1.508 |
| seq1000 | 4.734 | 3.316 | −1.417 |
| seq2500 | 6.380 | 3.693 | −2.688 |
| seq50000 | 10.643 | 13.463 | +2.820 |
| large-blob | 6.397 | 4.122 | −2.275 |
| stderr-mix | 4.899 | 2.399 | −2.500 |
| exit-nonzero | 4.745 | 2.300 | −2.445 |

Spawn floor per session: ~1.6–1.9 ms (paid once, not per call). Daemon RSS is not reported here: the resident-set probe used by `piread`/`pibash` benchmarks reads `/proc`, so it is Linux-only and is skipped elsewhere.

</details>

### Context shaping: what enters the model

Latency is only half of it. The number that compounds is the **bytes a tool result puts into the transcript**, because every later turn re-reads them. `pibash` and `piread` both shape to the same model-visible budget the permission-gate H1 cap enforces (40 lines / 2 KB), so the gate passes the result straight through instead of re-cutting it.

Measured with `npm run bench:model-visible` — `content[].text` only; `details`/`structuredContent` are TUI/programmatic and never reach the model (`pi-agent-core` documents structured output as "Not sent to the model").

| Case | native bytes | built-in bytes | Δ |
| --- | ---: | ---: | ---: |
| `read ~100ln` | 1,898 | 4,435 | **−57.2%** |
| `read ~300ln` | 1,675 | 12,343 | **−86.4%** |
| `read ~1000ln` | 1,945 | 41,275 | **−95.3%** |
| `read ~1922ln` | 2,040 | 51,188 | **−96.0%** |
| `bash 1300 lines` | 171 | 5,393 | **−96.8%** |
| `bash 10k lines` | 173 | 10,129 | **−98.3%** |
| `bash failing test-like` | 807 | 42,144 | **−98.1%** |
| `bash interleaved warnings` | 258 | 2,584 | **−90.0%** |
| **all cases (TOTAL)** | **15,569** | **273,312** | **−94.3%** |

Reads and shell output converge on roughly the same ~2 KB ceiling regardless of source size — cost stops scaling with the file instead of growing linearly.

**How each tool shapes:**

| Tool | Strategy | Notes |
| --- | --- | --- |
| `pibash` | head-tail / error-priority | command-aware (`Test`/`Build`/`Git`/`Search`/`Log`/`Generic`); failures keep a 2/3 tail, successes a 2/3 head; full output spilled to a temp file |
| `piread` | head-tail | 2/3 head : 1/3 tail; the `[Showing lines A-B of C …]` continuation notice is always kept last, so the reader still learns the file continues |
| `piedit` | none (bounded by design) | returns a status line + diff; `renderDiff` keeps the content pair out of the boundary entirely |
| `pidx` | pointer only | extracts written to a file; only a compact pointer line enters context, hard-capped at `PI_PIDX_MAX_INLINE` (default 2000 chars) |

Both compacted tools emit a deterministic `[... omitted N chars / M lines ...]` marker and are idempotent (a body already carrying the marker is never re-compacted). `piread` compaction is **on by default**; `PI_READ_COMPRESS=0` restores byte-for-byte parity with the built-in `read`, which the parity suite and `piedit`'s exact-match binding rely on.

Compaction never touches `details.truncation`, so the permission gate still learns the true line count from metadata (`countTextLines` is only the fallback) and read coverage stays correct.

`npm run bench:model-visible:compare` exits non-zero if any case's model-visible bytes *grew* against the committed baseline (`tests/fixtures/bench/model-visible-baseline.json`). Shrinkage is allowed, so it is a ratchet.

Built-in `bash` is blocked while `pibash` is registered (permission-gate "Pibash-first"), so shell work runs through the native pipeline — `pibash` runs the same schema and rules and falls back itself, so the block never strands the agent.

## Skills

All skills are **manual** — invoke with `/skill:<name>`; none auto-load. Bodies never enter context until invoked, so the skill roster costs nothing per session.

| Skill                | Purpose                                                            | Invocation                    |
| -------------------- | ------------------------------------------------------------------ | ----------------------------- |
| ponytail             | Lazy-minimum intensity modes over the AGENTS.md ladder             | `/skill:ponytail`             |
| web-search           | Web search + URL extraction via Tavily CLI                         | `/skill:web-search`           |
| systematic-debugging | Phased root-cause debugging before proposing any fix               | `/skill:systematic-debugging` |
| pre-push-review      | CI-parity correctness review of the diff before commit/push        | `/skill:pre-push-review`      |
| auth                 | NextAuth v4 credentials auth for Next.js App Router                | `/skill:auth`                 |
| brainstorming        | Explore genuinely-unclear feature direction                        | `/skill:brainstorming`        |
| browser-tools        | Live DOM via CDP `:9222` — Playwright/e2e                          | `/skill:browser-tools`        |
| documentation-writer | Diátaxis-based tech writer: SDK docs, READMEs, docs audits         | `/skill:documentation-writer` |
| fallow-audit         | Dead-code / unused-export / unused-dependency cleanup              | `/skill:fallow-audit`         |
| frontend-design      | New web components/pages/apps from scratch                         | `/skill:frontend-design`      |
| github-actions       | Author/harden CI workflows: SHA-pinned actions, actionlint          | `/skill:github-actions`       |
| grill-me             | One-question-at-a-time stress-testing of a plan                    | `/skill:grill-me`             |
| harness-engineer     | Meta: audit/improve this harness                                   | `/skill:harness-engineer`     |
| llm-format-checker   | LLM-rule markdown format check/fix                                 | `/skill:llm-format-checker`   |
| map-integration      | maplibre/mapbox-gl, deck.gl, turf, draw; Barikoi stack             | `/skill:map-integration`      |
| pidoc                | Harness setup health check; `--fix` rebuilds tools                 | `/skill:pidoc`                |
| playwright-tester    | e2e specs, stress runs, untested-critical-path coverage             | `/skill:playwright-tester`    |
| refactoring-ui       | Audit/fix existing UI: hierarchy, spacing, color, depth            | `/skill:refactoring-ui`       |
| rust-skills          | Rust coding guidelines (ownership, errors, async, unsafe, API, serde, testing) | `/skill:rust-skills` |
| sdk-development      | Installable packages (Go/npm/CLI): codegen, test, publish          | `/skill:sdk-development`      |
| session-audit        | Token/cost waste audit of `~/.pi/agent/sessions`                   | `/skill:session-audit`        |
| skill-manager        | Create/modify SKILL.md + mandatory validator gate                  | `/skill:skill-manager`        |

### Skill layout (validator-enforced)

```text
<name>/
├── SKILL.md        # required; the only loose file allowed at top level
├── scripts/        # executable code (.sh/.mjs/.py/...), incl. helper modules
├── references/     # additional docs read on demand (progressive disclosure)
└── assets/         # static resources: templates, images, data files
```

Enforced by `node skills/skill-manager/scripts/validate-skill.mjs <skill-dir>`. `npm run doc:check` additionally verifies that harness commands and paths declared in markdown resolve.

## Subagents

Owned first-party code at `extensions/subagents/` (`subagent` / `subagent_message` / `subagents_list` + `/subagents` command), vendored upstream with local patches folded in — agents-only tmux and permission-gate re-enabled inside sandboxed spawns. No `settings.json` → `packages` entry, so `pi update --extensions` cannot wipe it.

**Gated by default** — the spawning tools are registered inactive in top-level sessions (zero prompt tokens) until a trigger activates them:

- `/subagents on` / `/subagents off` — toggle for the session
- `/subagents [agent] [task]` — any spawn auto-enables; with no agent named, the session model routes by task
- `PI_SUBAGENTS=1` — start active (scripted opt-in)

Sandboxed spawns re-enable the permission-gate extension inside the child via `PI_SUBAGENT_EXTRA_EXTENSIONS` (colon-separated override).

Setup, headless/print-mode behavior, and triage: [`extensions/subagents/README.md`](extensions/subagents/README.md).

Agent definitions live in `agents/` — plain files, inert while the spawn tools are gated; discovery is project > global. No `model` pin: subagents inherit the harness default.

A spawn runs with `--no-extensions` plus one `-e` per tool-backing extension, so agent `tools:` lists name the native tools alongside their built-in fallbacks (`piread`, `piedit`, `pibash`). Each native extension announces itself to the subagents extension via `registerToolExtension`, which is what makes those names resolve to an `-e` path — without it a sandboxed subagent would silently get the built-in implementations.

| Agent             | Tools                                                           | Role                                         |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------- |
| scout             | read, grep, find, ls                                            | read-only recon                              |
| researcher        | read, write, bash                                               | web research via the `tvly` CLI              |
| worker            | read, write, edit, bash (+ may spawn scout, researcher)          | general implementer                          |
| reviewer          | read, bash, grep, find, ls (auto-loads `pre-push-review` skill) | pre-commit diff review; never commits/pushes |
| gh-issue-verifier | read, bash, grep, find, ls                                      | verifies a diff against a GitHub issue's acceptance criteria |

tmux is agents-only: the main terminal runs pi plain. When a subagent spawns outside tmux, panes appear in a detached session `pi-agents` — attach with `tmux attach -t pi-agents`. The tmux binary is required either way.

## Extensions

Always-on TypeScript modules in `extensions/` — loaded by pi, never in the model prefix, so edits here never invalidate the session prompt cache.

- **`permission-gate/`** — a `tool_call` interceptor providing edit-anchor pre-validation, read/output economy rules (re-read guard, capped bash output), destructive-command confirmation, the identical re-run guard (R10), and commitlint validation on `git commit -m`.
- **`subagents/`** — the gated spawning tool set above.
- **`piread/`, `piedit/`, `pibash/`, `pidx/`** — register the native tools.
- **`compact-editor/`** — caps the prompt editor height (default 10 lines, `PI_COMPACT_EDITOR_LINES`) so a long prompt or paste cannot push the transcript off screen; keeps the buffer head and tail with an `[... N more lines ...]` notice between them.
- **`self-heal/`** — on `session_start` runs `scripts/sync-agent-bin.mjs` so the shell PATH pin, native binaries, and the PCRE2 `rg` stay correct after a pull, a pi update, or on a fresh machine. Idempotent, never compiles, never throws, and silent when healthy.
- **`handoff.ts`** — `/handoff <goal>` drafts a context-transfer prompt from the session, opens it in the editor, then opens the new session with the draft; nothing is written to disk.

Raw events (tool errors, guard blocks) land in pi's native `sessions/**/*.jsonl` — the audit toolkit derives every signal from there. Full rule catalog and hook tables: [`extensions/README.md`](extensions/README.md).

pi also runs with codemode enabled (inline budget 3000) and the built-in MCP extension disabled; the tool defaults in `settings.json` remove `bash`, `read`, and `edit` in favor of the native equivalents.

## Context layers

| Layer              | What                    | When in context           | Stability rule            |
| ------------------ | ----------------------- | ------------------------- | ------------------------- |
| System + tools     | pi built-in             | every turn                | pi-managed                |
| **AGENTS.md**      | global behavioral rules | every turn                | **must stay byte-stable** |
| Scoped rule docs   | `docs/*.md` rule sets   | task touches the area     | read on demand            |
| Skill descriptions | frontmatter only        | every turn                | **must stay byte-stable** |
| Skill bodies       | SKILL.md full text      | on match or `/skill:name` | load on demand            |
| Project AGENTS.md  | repo rules              | when present              | overlays global           |

Skill discovery order: project `.pi/skills/` / `.agents/skills/` (if trusted) → `~/.pi/agent/skills/` (**canonical**) → `~/.agents/skills/` (neutralize manually so it does not leak).

## Always-on token budget

The permanent prefix is `AGENTS.md` alone — the only always-on artifact. Scoped rules live in `docs/` and load on demand; all skills are manual, so no skill descriptions sit in the model-visible catalog.

| Component           | Target                                      | Notes                                  |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| AGENTS.md           | as small as possible (behavioral core only) | no stack essays, no skill lists        |
| Skill descriptions  | short; delete dead skills                   | all manual — zero per-session cost     |
| **Total always-on** | AGENTS.md only                               | no auto-skill catalog, no package tool defs |

Thinking defaults to `high` in `settings.json`; drop it per-task with `--thinking off` when tokens matter more than depth.

## Portability

Goal: one self-contained config that works on any macOS or Linux machine by replacing `~/.pi/agent/`. No env vars required for setup, no absolute user paths.

### Sync workflow (git is the only sync)

```sh
# Machine A (source of changes)
cd ~/.pi/agent && git add -A && git commit -m "harness: <what>" && git push

# Machine B
cd ~/.pi/agent && git pull
# fresh clone instead? sh scripts/bootstrap.sh (deps + shims + native tools + health check)
```

`auth.json` (secrets) is copied manually **once per machine** via `scp` (or `/login` per provider). It is never in git. On key rotation, update it on each machine.

### Providers

`zai` is the default provider (`glm-5.3`; `models.json` adds `glm-5.3-flash` with a 1M context window and reasoning). `deepseek` is available via `/model`. Keys live only in `auth.json`; pi also accepts `ZAI_API_KEY` / `DEEPSEEK_API_KEY` but does not auto-load any `.env`.

### Machine-local (gitignored, never synced)

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

Everything else — `AGENTS.md`, `docs/`, `settings.json`, `models.json`, `skills/`, `extensions/`, `agents/`, `prompts/`, `tests/`, `custom-tools/` (workspace + lockfile), `.github/workflows/`, `package.json`, `CHANGELOG.md`, `LICENSE`, `.nvmrc` — is tracked in git and portable across OSes.

### Portability rules (enforced)

- No `/Users/...` or `/home/...` literals in any shipped file (only `~` / `$HOME`).
- Shell helpers are POSIX (`#!/usr/bin/env sh`) or bash-portable.
- No unguarded OS-only commands (`/proc` reads fall back to `ps`; server script picks `xdg-open` on Linux vs `open` on macOS).
- No pi env vars required for setup — config relies on the default `~/.pi/agent`.

## Design rules

1. **Minimal core** — prefer deletion over addition. Never bloat the permanent prefix.
2. **Progressive disclosure** — skill bodies and long refs load only when needed.
3. **Cache is sacred** — AGENTS.md and skill descriptions stay byte-stable within a session; prefer a fresh session after prefix changes.
4. **rg first** — code navigation via `rg`; bash only for real side-effects.
5. **Portability** — no absolute user paths; no unguarded OS-only commands.
6. **Primitives over features** — plan/debug/subagent via packages when needed; never re-implement as always-on skills.
7. **Never move permanent behavioral rules** out of AGENTS.md into skills.

**Known constraints.** Core behavioral rules live in AGENTS.md (intentional) — edit rarely, each edit changes every session's prefix. Skills are real files, not a plugin cache, so upstream updates do not auto-propagate.

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
| `doc:check`         | `node scripts/doc-check.mjs` | Verifies harness commands, paths, tool and env-var inventories declared in markdown actually resolve |
| `gate:eval`         | `node scripts/gate-eval.mjs` | Aggregates the fixture suite with the block-recovery and bash-replay audits; prints one final JSON metrics line |
| `check`             | all of the above          | typecheck → agents lint → doc check → tests; the full pre-commit gate        |

Conventional commits are enforced by husky + commitlint. Release CI extracts the version from `CHANGELOG.md` on push to `main`.

| File                           | Update when                                                          |
| ------------------------------ | -------------------------------------------------------------------- |
| [`CHANGELOG.md`](CHANGELOG.md) | every harness change (what / why / risk / measured delta)            |
| `README.md` (this file)        | structure, skill roster, budget, or sync/portability contract change |

**Goal:** smaller, more stable, cache-friendly, rg-first, fully portable harness.

## License

[MIT](LICENSE) © nurmdrafi
