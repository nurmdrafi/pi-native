# DESIGN.md reference (frontend-design)

Source: github.com/google-labs-code/design.md (local clone `git/design.md` for spec details — token schema, section order, CLI internals). Read when the project needs a durable design-system document or validates one.

## What it is

A DESIGN.md file = single source of design truth an agent reads to reproduce a visual system: palette tokens, typography, spacing, imagery direction, tone. Machine-checkable spec (token schema + section order), built for agent consumption.

## CLI (validation, linting, WCAG)

```bash
npx @google/design.md lint DESIGN.md    # structured JSON findings
```

Catches broken token references, WCAG contrast failures, structural findings — output designed for agents to act on.

## When to use

- Project has (or needs) a persistent visual system across surfaces → generate/maintain a DESIGN.md; greenfield: define it before building; existing UI: extract tokens into it.
- Validate after any token change; lint output = actionable JSON, fix and re-lint.
- Complex spec questions (token types, section order, examples) → search the local clone, not memory.
