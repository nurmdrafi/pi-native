# Extensions

Always-on TypeScript extensions for this pi agent harness, auto-discovered from
`~/.pi/agent/extensions/`. Runtime only — never part of the model-visible
prefix, so edits here never invalidate the session cache.

## Usage

```bash
# auto-discovery: files here load on every pi session — no config needed
# manual / one-off load:
pi --extension ~/.pi/agent/extensions/permission-gate/index.ts
```

Edits take effect on the next session start (or via `/reload-runtime` if adopted — see candidates).

## Extensions

> **Extensions vs packages:** pi packages (`pi install git:…`) are declared in `settings.json` → `packages` and cloned machine-local under `~/.pi/agent/git/`. Unlike extensions, their tool definitions DO add to the model-visible prefix. Currently none — the former `pi-interactive-subagents` package is owned in-tree as `subagents/` below (vendored at `c3e8b53` with local patches folded in; spawning tools default-inactive — see the main `README.md` "Subagents" section).

| Extension          | Role                                                                                                                                                                                                 | Hooks                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `permission-gate/` | Blocks rule-violating tool calls before execution, with corrective rule text (modules: `index` wiring, `anchor-guard`, `read-coverage`, `bash-cap`, `destructive`, `commitlint`, `toolchain`, `search-guard`, `output-scrub`, `violation-memory`, `config`) | `tool_call`, `tool_result`, `before_agent_start`, `session_start`, `session_compact` |
| `subagents/`       | Interactive tmux subagents (vendored upstream at `c3e8b53`, patches folded in; spawning tools gated by default)                                                                                      | tools, commands, renderers                                                           |
| `pibash/`         | Native shell tool (built-in `bash` is the fallback; byte-exact envelope parity pinned by `tests/pibash-parity.test.mjs`); bash-kind in permission-gate, so the H1 cap, R10, destructive analysis, and mutation tracking all apply | tools                                                                                |
| `piread/`         | Native read pipeline registered as its own tool (S6); built-in `read` is blocked while registered (P1), images stay on `read`                                                                                                       | tools                                                                                |
| `piedit/`         | Native edit pipeline registered as its own tool (S8); shares the guard's fuzzy-normalize match rules                                                                                                                               | tools                                                                                |
| `pidx/`           | Native session-log indexer registered as its own tool; compact per-session extracts, incremental over unchanged files                                                                                                               | tools                                                                                |
| `compact-editor/` | Caps the prompt editor height so a long prompt or paste cannot push the transcript off screen; keeps the buffer head and tail with a dropped-line notice. `PI_COMPACT_EDITOR_LINES` sets the cap (default 10)                      | editor                                                                               |
| `handoff.ts`       | `/handoff <goal>` — drafts a compaction-aware context-transfer prompt from the session, opens it in the editor, then opens a new session seeded with the draft; writes nothing to disk               | command                                                                              |
| `self-heal/` | On `session_start` runs `scripts/sync-agent-bin.mjs` so the shell PATH pin, native binaries, and the PCRE2 `rg` stay correct after a pull, a pi update, or a fresh machine. Idempotent, never compiles, never throws, silent when healthy | session_start |

### Tool-backing env vars

| Var | Purpose |
| --- | --- |
| `PI_READ_BIN` / `PI_EDIT_BIN` / `PI_BASH_BIN` / `PI_PIDX_BIN` | Override the native binary path (`bin/<tool>` by default). Used by the parity suites to point an extension at a throwaway binary and exercise the one-shot rung; also non-standard installs. |
| `PI_SUBAGENT_EXTRA_EXTENSIONS` | Colon-separated extension paths re-enabled inside sandboxed subagent spawns (default re-enables `permission-gate.ts`). Set by the orchestrator, not the user. |
| `PI_SESSION_ID` / `PI_SESSION_FILE` / `PI_PROVIDER` / `PI_MODEL` / `PI_REASONING_LEVEL` | Session context keys injected by pi and forwarded to native-tool child processes so commands see the same `PI_*` context (see `extensions/pibash/index.ts`). |
| `PI_CODING_AGENT_DIR` | Overrides the agent config directory (`~/.pi/agent` by default). |
| `PI_PIDX_MAX_INLINE` | Inline extract cap for `pidx` output (default 2000 chars; larger output is written to a file and referenced by pointer). |
| `PI_PIDX_FORCE_CONFIRM` | Test-only opt-out for `pidx`'s `force` confirmation; set to `1` to let `force: true` proceed without `"confirm"`. |

## `permission-gate/` — rule catalog

Single `tool_call` interceptor; one handler, deterministic order (edit → read → write → bash). Every block carries a rule-family prefix (`Anchor Guard:`, `Token Economy (…)`) so transcripts and logs stay greppable and the model gets precise corrective text. Block reasons are capped ≈200 chars — pointer + fix, no prose (2026-10-06 diet: session audit showed 90% one-shot recovery needs the pointer, not the words, and every block text rides the prefix ~2.6× for the rest of the session). Anchor Guard keeps a trimmed ≤8-line file snippet on anchor-miss — Aider-style "did you mean" context.

### Configuring rules

Every rule is switchable from [`config.json`](permission-gate/config.json) — no source edit needed. Keys are
descriptive (`rerunGuard`), not the terse source ID (`R10`); `config.ts` → `RULE_IDS` maps the two and is the
single place they meet. Scalar knobs (`outputCap`, `confirm`, `violationMemory`) live beside the switches.

```json
{ "rules": { "rerunGuard": false, "destructiveConfirm": false } }
```

One-off override without editing a tracked file — the key in SCREAMING_SNAKE_CASE with a `PGATE_` prefix:

```sh
PGATE_RERUN_GUARD=0 pi        # disable just the re-run guard for this run
```

Precedence is env > `config.json` > default, and the default is **every rule on**. A missing, unreadable, or
malformed config, or a key with no matching rule (a typo like `toolchainPnmp`), is reported on stderr and the
rule stays on — enforcement never silently weakens. `tests/gate-config.test.mjs` pins all of this, including
that every config key has a row in the table below.

### Rule catalog

| Rule            | Scope             | Blocks / does                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AG (`Anchor Guard:`) | edit         | `oldText` not found (exact + fuzzy normalization), non-unique anchor (reports line numbers), intra-call overlap of exact-matched anchors                                                                                                                                                                                                                                                                            |
| R1              | read              | any re-read whose requested window is fully covered by the session's in-context span union — read results (actual returned lines), edit-result spans (exact-match anchors, pre-edit-stat verified), whole file after `write`/images, prompt `@file` injections; partial overlap passes; freshness = mtime+size snapshot per certified path; resets on `session_compact` and failed edits                            |
| R1b             | read              | whole-file (no-limit) or ≥500-line-window read of a >10KB file — blocked with a targeted-window fix                                                                                                                                                                                                                                                                                                                   |
| R1c             | read              | a ≥100-line window on a path no search command (`rg`/`grep`/`fd`/`find`/`ag`/`ack`) named this session, with no prior coverage — blocked with the search to run; narrower windows, whole-file reads (R1b) and already-searched paths pass                                                                                             |
| H1 (cap)        | bash              | non-blocking: output capped at 40 lines / 2KB UTF-8 (failing commands too); oversized first line truncated head+tail; full output spilled to `$TMPDIR/pgate-spill` with a pointer                                                                                                                                                                                                                                  |
| H1b (cap)       | read              | non-blocking: a `read`/`piread` result over 300 lines / 8KB is truncated to its head and the full text spilled to `$TMPDIR/pgate-spill` with a pointer — reads had no post-cap before, so a wide window rode into context whole (audit: piread p90 8.5KB, max 40KB)                                                                                                                                                |
| H2              | bash              | destructive commands (sudo, rm incl. `/bin/rm`, git reset --hard/clean/checkout --/restore, package installs, `> /etc*`, DROP TABLE / DELETE FROM, `find -delete`, xargs/find -exec/bash -c/`$(…)` wrapped rm) need approval: a yes in chat or the invoking message, the UI confirm dialog; headless without any fails closed; a verbatim re-send re-prompts, never Re-blocks. TRIPWIRE, not a boundary |
| R9              | bash              | `git commit -m <msg>` (env prefixes and git global flags normalized first; heredoc bodies extracted) against the commitlint conventional pattern — header form/length, subject case, body line length                                                                                                                                                                                                               |
| R10             | bash              | identical re-run (same full command, fd-merges/whitespace normalized) ≤10 min after its last successful run with no intervening edit/write/mutating-bash (git add/commit/push/pull/…, rm/mv/cp/mkdir/touch, npm/pnpm ci, build scripts, file redirects) — watchers and failed-run retries exempt; cleared on `session_compact`                                                                                      |
| RB              | bash              | verbatim re-send of a just-blocked command escalates with a dedicated reason (never armed for the H2 family)
| TC1             | bash              | `npm`/`npx`/`yarn` in a repo that pins pnpm (`packageManager`, `pnpm-lock.yaml`) — use `pnpm run`/`exec`/`dlx`; lockfile and engine drift caused 7 failed runs                                                                                           |
| TC2             | bash              | a node-family binary (`node`/`npm`/`npx`/`pnpm`/`yarn`/`bun`/`tsx`/`ts-node`) whose interpreter misses an exact `x.y.z` Node pin (`.nvmrc`/`engines`) — prefix `nvm use <pin> &&`; ranges and major-only pins stay advisory, so the harness root pin (`24`) never self-blocks |                                                                                                                                                                                                                                                                                                        |
| P1              | read              | built-in `read` of a text file is blocked while piread is registered — use `piread` (images stay on `read`); skipped when `PI_NATIVE_READ=0`                                                                                                                                                                                                                                                                        |
| P2              | bash              | built-in `bash` is blocked while pibash is registered — use `pibash` (same schema and bash-kind rules; it falls back itself); skipped when `PI_NATIVE_BASH=0`                                                                                                                                                                                                                                                        |
| SS1             | search            | recursive `grep`/`rg` with no path or glob scope — scope it to a path (`rg PATTERN path/`) instead of crawling the tree                                                                                                                                                                                                                                                                                             |
| SS2             | search            | a grep segment reached mid-pipe (`… | grep …`, or a `grep … | head` tail) — use `rg PATTERN path/`, which is a single Rust process                                                                                                                                                                                                                        |
| SS3             | search            | a `find`-headed segment — use `fd PATTERN path/` instead (`fd` is the harness default; `find` is an error-only fallback)                                                                                                                                                                                                                                  |
| PB1             | search            | `grep -P` on darwin (BSD grep lacks PCRE) — use `rg -P` (built with PCRE2) or `grep -E`                                                                                                                                                                                                                                                                                                                             |
| (removed)        | read/search       | node_modules fully allowed (2026-10-18) — read/grep/inspect freely; SS1 scope rule still applies                                                                                                                                                                                                                                                                    |
| AT1             | tool_result       | adoption telemetry (non-blocking): a completed native-tool call (pibash/piread/piedit/pidx) appends `{kind:"adoption",tool,sid,ts}` to the NDJSON store — non-adoption was invisible when only blocks were logged                                                                                                                                                                                                     |
| VM              | prompt            | violation memory: per-family distinct-session block counts (NDJSON) inject lessons into the next session's system prompt                                                                                                                                                                                                                                                                                            |
| CN              | all tools         | cadence nudge, non-blocking: appended to a tool_result at ~200 user turns / ~150K context tokens; resets on compaction                                                                                                                                                                                                                                                                                              |

State (per extension instance): `coverage` (path → merged span union + last kind + stat snapshot), `pendingEdits`, `pendingReads` drive R1; `pendingBash`/`lastBashRun` plus a `mutationSeq` counter (edit/write/mutating bash) drive R10. A failed edit drops coverage; `session_compact` clears everything; `session_start` hydrates coverage by replaying the prior branch's read/write entries (entry-timestamp freshness: a file changed after the replayed read certifies nothing). Fuzzy matching mirrors edit-diff.js `normalizeForFuzzyMatch` so the guard and the tool agree on what "matches"; a call with any fuzzy anchor drops the path's coverage instead of certifying line math that skipped it. Anchor validation runs before coverage registration, so a blocked edit never enters the map.

- **One file per extension**, `export default function (pi: ExtensionAPI)` — per [pi conventions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md); use a directory + nearby `package.json` only for multi-file implementations with deps.
- **Naming**: kebab-case, function-descriptive. Note this harness's `permission-gate/` _blocks unconditionally_ — upstream's same-named example _confirms_ instead, so the planned commit/push confirmation gate is named `commit-gate.ts`.
- **No npm dependencies in extensions** — Node stdlib + `@earendil-works/pi-coding-agent` only. If a runtime dep is ever needed, the pi-native way is `pi install npm:<pkg>` (declares it in `settings.json` → `packages`, installs under `~/.pi/agent/npm`) — _not_ the root `package.json`. The root `package.json` holds repo tooling (husky/commitlint) plus typecheck/test-resolution devDeps (`typescript`, `@types/node`, `@sinclair/typebox`) — nothing pi loads at runtime. The `@earendil-works/pi-coding-agent` + `pi-tui` types resolve via `scripts/link-pi.mjs` symlinks to the global install (`npm run typecheck`).
- **Portability (macOS + Linux)**: paths via `os.homedir()` / `~`; no absolute user paths; no OS-only commands.
- Machine-local, gitignored, auto-regenerated: `bin/` (pi downloads arch-correct binaries), `npm/` (pi-managed installs).

## Verifying changes

- Strict typecheck against the installed package's types (`npx tsc --noEmit --strict` with a `paths` mapping to the global `@earendil-works/pi-coding-agent/dist/index.d.ts` — the global path is machine-specific).
- `permission-gate` fixture test: `node tests/permission-gate.test.mjs` — 166 black-box cases through a stubbed ExtensionAPI (exit 0 = pass; preflight symlinks the global package into the gitignored root `node_modules`).
- `node tests/block-recovery-audit.mjs` — re-measures what the model does after blocks (families, message sizes, one-shot recovery) over logged sessions; exits 1 below 85% recovery on a ≥10-block sample. Run after every permission-gate change.
- `npm run doc:check` must exit 0 (validates every command/path this README declares).
- Restart pi to load changes; watch the first few tool calls — a misfiring rule shows up immediately as a block.

## Adding a new extension

1. kebab-case function-descriptive name (see Conventions); decide blocking vs confirming semantics first.
2. `export default function (pi: ExtensionAPI)`; stateless unless the design demands state.
3. No deps; portable paths; failures must never break the agent loop.
4. If it blocks tool calls, use a stable reason prefix (`<Family>:`) — it lands in transcripts, telemetry, and audits.
5. Update this README (table + a section if non-trivial) and `CHANGELOG.md`; restart the session to load.

## Adoption candidates (from upstream, ranked)

| Candidate                                              | Source                                                                                               | Why                                                                                                            |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `commit-gate.ts` (adapt upstream `permission-gate.ts`) | [upstream](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions) | Encode AGENTS.md Safety: ask before install/destructive (commit/push removed 2026-10-11) — `ctx.ui.confirm` with UI, block headless |
| new `portability-guard.ts`                             | no upstream twin — model on `permission-gate.ts`                                                     | Block `sed -i` (no `''`), `stat -c/-f`, `grep -P` (AGENTS.md cross-platform rule)                              |
| `session-name.ts`                                      | upstream                                                                                             | Named sessions improve `sessions/**/*.jsonl` audits                                                            |
| `notify.ts`                                            | upstream                                                                                             | OSC 777 turn-complete desktop notifications                                                                    |
| `reload-runtime.ts`                                    | upstream                                                                                             | Hot-reload extensions after editing guards, without restarting                                                 |

## Upstream references

- Examples: <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions>
- Extension docs: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi packages (`pi install`): <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
