---
name: skill-manager
description: "Create or modify SKILL.md files (agentskills.io spec + pi docs/skills.md); always runs the validator before finishing. Use for 'create a skill', 'new/fix/merge/rename/split skill', any SKILL.md or skill-directory change. NOT for ordinary project documentation."
disable-model-invocation: true
---

# Skill Manager

Creates skills passing [Agent Skills spec](https://agentskills.io/specification) + Pi loader.
Read only the reference the current phase needs — not all three.

## References

- `references/skill-spec.md` — frontmatter constraints + directory layout (validator-enforced). Read while writing frontmatter/placing files.
- `references/writing-guide.md` — description formula, body structure, writing style, craft mistakes. Read while drafting SKILL.md content.
- `references/anti-patterns.md` — six prompt anti-patterns + security checklist, distilled from harness audit (harness-engineer). Read before validating; sweep every draft.

## Workflow

1. Ask (once) for skill's purpose + trigger phrases if not obvious from request.
2. `ls ~/.pi/agent/skills/` — reuse/extend existing skill instead of near-duplicate. Overlapping skills fragment triggering; prefer editing older skill.
3. Creating: write `<skill-dir>/SKILL.md` per references; place bundled files per `references/skill-spec.md` layout — docs `references/`, executables `scripts/`, static data `assets/`.
   Modifying: preserve original `name` + directory name — never version-suffix (`-v2`); keep description's trigger scope unless user asks; after moving/renaming any file, `rg` whole skill dir for references to it, not just SKILL.md.
   Formatting: hold every SKILL.md draft to the AGENTS.md docs style — concise, self-contained, no duplicated rules, tool names only where the rule is repo-scoped. Frontmatter always untouched.
4. Anti-pattern gate: sweep draft per `references/anti-patterns.md` — run rg signatures over skill dir, judge hits per its Calibration (presence alone ≠ finding).
5. Real-task check: does the skill actually help on its target task type? Best test: fresh agent instance with skill loaded, real task. Ask user to confirm prompts, adjust.
6. **Validation gate — mandatory after every create/modify, no exceptions:**
   ```bash
   node ~/.pi/agent/skills/skill-manager/scripts/validate-skill.mjs <skill-dir>  # loop until exit 0
   cd ~/.pi/agent && npm run doc:check                                          # if commands/paths changed
   ```
   Fix + re-run until exit 0 — "should be fine" ≠ validation. Validator encodes Agent Skills spec checks + layout, XML-tag, reserved-word, vagueness rules; doc-check verifies every command declared in skill markdown resolves (binaries, flags, script paths).
7. Pi picks up new/changed skills at startup or `/reload` — confirm skill loads: invoke `/skill:name`, or after a session that used it run `bash ~/.pi/agent/skills/session-audit/scripts/skillcheck.sh <name>`. Skill missing from system prompt after reload = frontmatter failed to parse.

## Checklist before finishing

- [ ] `name` matches directory; `description` ≤1024 chars, third person: what + triggers + when + NOT-for
- [ ] Body tight; long material split to `references/` (or `scripts/`/`assets/` by content type), linked one level deep
- [ ] Anti-pattern gate clean (`references/anti-patterns.md`): no rituals, boosters, stale examples, contradictions, dated configs
- [ ] Validator exit 0 (re-run after every fix); doc-check clean if commands/paths changed
- [ ] After `/reload`, skill loads (`/skill:name` responds or skillcheck.sh confirms a read)
