# Skill spec and directory layout

Validator-enforced rules (`scripts/validate-skill.mjs`, run from skill-manager dir). Read while writing frontmatter/placing files. Agent Skills spec: <https://agentskills.io/specification>; Pi loader: `docs/skills.md` in pi package.

## Hard rules (spec-enforced)

- Frontmatter required: `name` (lowercase, hyphens, matches dir), `description` (≤1024 chars, non-empty).
- Optional: `license`, `compatibility` (≤500 chars), `metadata`, `allowed-tools`, `disable-model-invocation`. Omit optionals unless needed. `allowed-tools` format: `Bash(bx *)` — pre-approves only that tool pattern; use when skill wraps one CLI.
- Missing description → Pi refuses load. Everything else warns but loads.
- Personal skills: `~/.pi/agent/skills/<name>/`. Project skills: `.pi/skills/<name>/`.

## Directory layout

```text
<name>/
├── SKILL.md        # required; only loose file allowed at top level
├── scripts/        # executable code (.sh/.mjs/.py/...), incl. helper modules
├── references/     # additional docs read on demand (progressive disclosure)
└── assets/         # static resources: templates, images, data files, schemas
```

- Nothing loose in root besides `SKILL.md` — root executables/docs = standard skill rot. Bin+src splits (`bin/`, `src/`) also under `scripts/`.
- `package.json` + `node_modules/` tolerated for skills with declared deps (e.g. `browser-tools`); document `npm install` step in skill body.
- `scripts/` flat unless module needs own subdir; scripts referenced relative to skill dir (`scripts/foo.sh`), not `./foo.sh`.
- Content → dir matching type: docs → `references/`, executables → `scripts/`, static data/templates → `assets/`.
