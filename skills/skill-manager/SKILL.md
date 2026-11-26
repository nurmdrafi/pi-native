---
name: skill-manager
description: "Use when creating, fixing, merging, renaming, or splitting agent skills — writes the target's files, validates before finishing (agentskills.io + pi spec). Not for ordinary project docs."
disable-model-invocation: false
metadata:
  author: "pi agent-home maintainers"
  tags: [skill-authoring, agentskills, validation]
---

# Skill Manager

## Purpose

Ship skills that pass the [Agent Skills spec](https://agentskills.io/specification) and the pi loader on first load. Read only the reference the current phase needs — not all three.

## References

- [references/skill-spec.md](references/skill-spec.md) — frontmatter constraints + directory layout (validator-enforced). Read while writing frontmatter/placing files.
- [references/writing-guide.md](references/writing-guide.md) — description formula, body structure, writing style, craft mistakes. Read while drafting SKILL.md content.
- [references/anti-patterns.md](references/anti-patterns.md) — six prompt anti-patterns + security checklist, distilled from harness audit (harness-engineer). Read before validating; sweep every draft.

## Available Scripts

| Script | Purpose | Arguments |
| --- | --- | --- |
| `scripts/validate-skill.mjs` | Spec + layout gate; loop until exit 0 | `<skill-dir>` |

## Prerequisites

- Node (runs `scripts/validate-skill.mjs`)
- SkillEvaluator CLI for the evaluation gate — install via `~/.pi/agent/skills/skillevaluator/scripts/setup.sh`

## Instructions

1. Ask (once) for skill's purpose + trigger phrases if not obvious from request.
2. `ls ~/.pi/agent/skills/` — reuse/extend existing skill instead of near-duplicate. Overlapping skills fragment triggering; prefer editing older skill.
3. Creating: draft `<skill-dir>/SKILL.md` per references; place bundled files per [references/skill-spec.md](references/skill-spec.md) layout — docs `references/`, executables `scripts/`, static data `assets/`.
   Modifying: preserve original `name` + directory name — never version-suffix (`-v2`); keep description's trigger scope unless user asks; after moving/renaming any file, `rg` whole skill dir for references to it, not just SKILL.md.
   Formatting: hold every SKILL.md draft to the AGENTS.md docs style — concise, self-contained, no duplicated rules, tool names only where the rule is repo-scoped. Frontmatter always untouched.
4. Anti-pattern gate: sweep draft per [references/anti-patterns.md](references/anti-patterns.md) — run rg signatures over skill dir, judge hits per its Calibration (presence alone ≠ finding).
5. Real-task check: does the skill actually help on its target task type? Best test: fresh agent instance with skill loaded, real task. Ask user to confirm prompts, adjust.
6. **Validation gate — mandatory after every create/modify, no exceptions:**
   ```bash
   node ~/.pi/agent/skills/skill-manager/scripts/validate-skill.mjs <skill-dir>  # loop until exit 0
   cd ~/.pi/agent && npm run doc:check                                          # if commands/paths changed
   ```
   Fix + re-run until exit 0 — "should be fine" ≠ validation. Validator encodes Agent Skills spec checks + layout, XML-tag, reserved-word, vagueness rules; doc-check verifies every command declared in skill markdown resolves (binaries, flags, script paths).
7. **Evaluation gate — with LLM (default), after validation passes:**
   ```bash
   skillevaluator tier1 <skill-dir>   # ~4 min: semantic + rubric + verification
   ```
   Keyless (`--no-llm`, ~10 s) is for inner-loop iteration only, never the final gate. Fix every CRITICAL/HIGH finding before finishing; report score + top findings. Reports land under `~/.pi/agent/reports/skillevaluator/<skill>/`. Timings and provider wiring in `docs/skill-evaluation.md` (pi agent home). A false-positive HIGH on a skill whose purpose is editing skill files ("Rogue Agent" self-modification) is suppressed via `--skillspector-baseline ~/.pi/agent/reports/skillevaluator/<skill>/skillspector-baseline.yaml` (rule-based, never fingerprint). Tier 2/3 cost additional model spend — per the `skillevaluator` skill (`~/.pi/agent/skills/skillevaluator/`).
8. Pi picks up new/changed skills at startup or `/reload` — confirm skill loads: invoke `/skill:name`, or after a session that used it run `bash ~/.pi/agent/skills/session-audit/scripts/skillcheck.sh <name>`. Skill missing from system prompt after reload = frontmatter failed to parse.

## Examples

- "Create a skill that formats Rust commit messages" — new skill dir: frontmatter + body + references per spec, both gates run.
- "Fix the sentry skill's description — it fires on unrelated auth questions" — tighten trigger scope in description only, keep name, re-validate.
- "Merge playwright-tester into browser-tools" — move content, update links, delete source dir, re-run both gates on the survivor.

## Limitations

- Static gates judge spec compliance; only a real task in a fresh session proves triggering
- LLM tiers and Tier 3 cost model spend — opt-in per user request, never automatic

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Skill absent from system prompt after `/reload` | Frontmatter failed to parse — check YAML quoting, then `/skill:name` again |
| Validator rejects a new file at skill root | Move it: docs → `references/`, executables → `scripts/`, data → `assets/` |
| SkillEvaluator HIGH "Rogue Agent" on a skill-editing skill | Audited false positive — suppress rule-based (Instructions step 7) |

## Checklist before finishing

- [ ] `name` matches directory; `description` ≤1024 chars, third person: what + triggers + when + NOT-for
- [ ] Body tight; long material split to `references/` (or `scripts/`/`assets/` by content type), linked one level deep
- [ ] Anti-pattern gate clean — [references/anti-patterns.md](references/anti-patterns.md): no rituals, boosters, stale examples, contradictions, dated configs
- [ ] Validator exit 0 (re-run after every fix); doc-check clean if commands/paths changed
- [ ] Evaluation gate run (keyless): score reported, no HIGH/CRITICAL findings; LLM tiers only on request
- [ ] After `/reload`, skill loads (`/skill:name` responds or skillcheck.sh confirms a read)
