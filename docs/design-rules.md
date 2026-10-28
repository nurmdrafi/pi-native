# Design rules and context policy

Reference for how the harness spends context and which design invariants hold.

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

## Scoped rule sets

**Always-on content test.** A line belongs in the always-on pair only if it changes
behaviour on the next action: a rule, an obligation, or a tool-calling instruction.
Inventories, pointers ("lives in X"), purpose statements, rationale and cross-
references do not qualify; they live in a scoped doc and are read on demand. A
conditional load instruction ("before X, apply Y") does qualify: it changes the
next action, and its doc path is the trigger.

Loaded on demand, never always-on (the links used to sit in AGENTS.md, where they
cost every project's prefix for rules only this harness needs):

- `docs/change-discipline.md` — change ladder, root cause, deployment.
- `docs/portability.md` — macOS+Linux shell subset, dynamic paths.
- `docs/rust-tools-optimization.md` — safe path for optimizing a native tool: model
the cost, freeze the old binary, pin the seam, swap, verification ladder, honest
measurement.
