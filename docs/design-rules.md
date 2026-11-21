# Design rules and context policy

This document defines how pi-native distributes instructions and enforces behavior.

## Instruction layers

| Layer | Responsibility | Loading |
|---|---|---|
| Pi system prompt and tool schemas | Core agent identity and available tool contracts | Every turn; Pi-managed |
| `AGENTS.md` | Small set of cross-project behavioral defaults plus conditional pi-native pointers | Every turn |
| `docs/*.md` | Repository-specific procedures, architecture, and operational constraints | Read when the task enters that area |
| Skill descriptions | Discoverable capability summaries | Depends on Pi skill configuration |
| Skill bodies | Detailed, specialized workflows | On invocation or matching behavior supported by the installed Pi version |
| Prompt templates | Repeatable user-invoked workflows | On command invocation |
| Extensions and native tools | Deterministic controls, tool behavior, and runtime enforcement | Runtime |

`SYSTEM.md` is intentionally absent. In Pi, it replaces the default system prompt; this repository does not need to own that prompt. Do not add a global or project `SYSTEM.md` unless a measured requirement justifies replacing Pi's built-in prompt.

`APPEND_SYSTEM.md` is also not part of the default architecture. Add it only for a concise instruction that must be present in every turn and cannot live in `AGENTS.md` without harming clarity. Avoid duplicating tool schemas or extension-enforced rules.

## Context budget
- Keep `AGENTS.md` small, stable, and behavioral.
- Keep detailed inventories, rationale, command recipes, machine setup, and incident history out of the always-loaded layer.
- Prefer conditional pointers to scoped docs over copying their contents into global instructions.
- Do not claim that skill descriptions cost zero tokens unless the active Pi configuration actually disables or hides the skill catalogue. Measure the real prompt.
- Re-measure model-visible prompt size after changing global instructions, skill discovery, packages, or extensions.

## Ownership
- Behavioral defaults belong in `AGENTS.md`.
- Tool-use conventions for maintaining this repository belong in `docs/tool-use.md`.
- Architecture belongs in the relevant architecture document.
- Subagent orchestration belongs in `docs/subagent-orchestration.md`; child conduct belongs in `docs/subagents.md`.
- Commit and release procedures belong in `prompts/ship.md` and `docs/change-rules.md`.
- Deterministic policy belongs in extensions/tests, not merely in prose.
- Each rule has one authoritative home. Other files link to it rather than paraphrasing it.

## Portability
The supported target is macOS and Linux. Apply `docs/portability.md` to scripts, paths, fixtures, generated artifacts, and recorded benchmark output.
