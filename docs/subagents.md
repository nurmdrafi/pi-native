# Subagents

Owned first-party code at `extensions/subagents/` (`subagent` / `subagent_message` / `subagents_list` + `/subagents` command), vendored upstream with local patches folded in — agents-only tmux and permission-gate re-enabled inside sandboxed spawns. No `settings.json` → `packages` entry, so `pi update --extensions` cannot wipe it.

**Gated by default** — the spawning tools are registered inactive in top-level sessions (zero prompt tokens) until a trigger activates them:

- `/subagents on` / `/subagents off` — toggle for the session
- `/subagents [agent] [task]` — any spawn auto-enables; with no agent named, the session model routes by task
- `PI_SUBAGENTS=1` — start active (scripted opt-in)

**Invoked from the current session only** — spawn subagents via the `/subagents` slash command in the existing session; never run a subagent as a detached/background session.

Sandboxed spawns re-enable the permission-gate extension inside the child via `PI_SUBAGENT_EXTRA_EXTENSIONS` (colon-separated override).

Setup, headless/print-mode behavior, and triage: [`extensions/subagents/README.md`](../extensions/subagents/README.md).

Agent definitions live in `agents/` — plain files, inert while the spawn tools are gated; discovery is project > global. No `model` pin: subagents inherit the harness default.

A spawn runs with `--no-extensions` plus one `-e` per tool-backing extension, so agent `tools:` lists name the native tools alongside their built-in fallbacks (`piread`, `piedit`, `pibash`). Each native extension announces itself to the subagents extension via `registerToolExtension`, which is what makes those names resolve to an `-e` path — without it a sandboxed subagent would silently get the built-in implementations.

| Agent             | Tools                                                           | Role                                         |
| ----------------- | --------------------------------------------------------------- | -------------------------------------------- |
| scout             | ls, piread, pibash                                               | read-only recon                              |
| researcher        | write, piread, pibash (auto-loads `web-search` skill)              | web research via the `tvly` CLI              |
| worker            | write, piread, piedit, pibash (auto-loads `systematic-debugging`; + may spawn scout, researcher) | general implementer |
| reviewer          | ls, piread, pibash (auto-loads `pre-push-review` skill)           | pre-commit diff review; never commits/pushes |
