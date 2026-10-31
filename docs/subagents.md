# Subagents

Owned first-party code at `extensions/subagents/` (`subagent` / `subagent_message` / `subagents_list` + `/subagents` command), vendored upstream with local patches folded in — agents-only tmux and permission-gate re-enabled inside sandboxed spawns. No `settings.json` → `packages` entry, so `pi update --extensions` cannot wipe it.

**Gated by default** — the spawning tools are registered inactive in top-level sessions (zero prompt tokens) until a trigger activates them:

- `/subagents on` / `/subagents off` — toggle for the session
- `/subagents [agent] [task]` — any spawn auto-enables; with no agent named, the session model routes by task
- `PI_SUBAGENTS=1` — start active (scripted opt-in)

**Invoked from the current session only** — spawn subagents via the `/subagents` slash command in the existing session; never run a subagent as a detached/background session.

Sandboxed spawns re-enable the permission-gate extension inside the child via `PI_SUBAGENT_EXTRA_EXTENSIONS` (colon-separated override).

**Budgets** — ceilings per dimension: wall-clock seconds, assistant turns, and cumulative provider-reported USD cost. Resolution per dimension: role frontmatter `budget:` block → `budgetDefaults` in `extensions/subagents/config.json` (absent file → the shipped `config.json.example`: 1800 s / 60 turns / $3) → unenforced. Role `budget: none` exempts the agent entirely — every shipped role agent declares it, so ceilings bind fork clones and any definition without the exemption. A spawn `budget` override may only lower a ceiling, never raise it. On breach the child is interrupted (Ctrl-C), killed after a 30 s grace, and the result reports `budget_exceeded`; the session file is preserved for resume, and resumed or auto-restarted runs are not re-budgeted. Detached subagents are not budgeted once the parent session ends.

Setup, pane recovery, headless/print-mode behavior, and triage: [`extensions/subagents/README.md`](../extensions/subagents/README.md).

Agent definitions live in `agents/` — plain files, inert while the spawn tools are gated; discovery is project > global. No `model` pin: subagents inherit the harness default. Every definition must declare `tools:` — a spawn naming an agent without the declaration is denied (deny-by-default; the unrestricted toolset is reserved for top-level fork clones).

A spawn runs with `--no-extensions` plus one `-e` per tool-backing extension, so agent `tools:` lists name the native tools alongside their built-in fallbacks (`piread`, `piedit`, `pibash`). Each native extension announces itself to the subagents extension via `registerToolExtension`, which is what makes those names resolve to an `-e` path — without it a sandboxed subagent would silently get the built-in implementations.

| Agent         | Tools | Role |
| ------------- | ----- | ---- |
| bench-runner  | write, piread, pibash | runs frozen benchmark/eval arms under hard wall budgets; writes only its result file |
| docs-optimizer | write, piread, piedit, pibash (auto-loads `documentation-writer`) | optimizes rule/instruction Markdown; drafts README/CHANGELOG proposals |
| fixer         | write, piread, piedit, pibash (auto-loads `systematic-debugging`) | fixes exactly one assigned issue in a worktree; no commit/push unless ordered |
| researcher    | write, piread, pibash (auto-loads `web-search`) | web research via the `tvly` CLI |
| reviewer      | ls, piread, pibash (auto-loads `code-reviewer`) | pre-commit diff review; never commits/pushes |
| scout         | ls, piread, pibash | read-only recon |
| ui-verifier   | ls, piread, pibash (auto-loads `browser-tools`) | drives the running app via headless Chromium + CDP; verifies rendered behavior |
| verifier      | ls, piread, pibash | runs the change; reports per-criterion PASS/FAIL, never fixes |
| worker        | write, piread, piedit, pibash (auto-loads `systematic-debugging`, `ponytail`; may spawn scout, researcher) | general implementer |
