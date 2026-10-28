# Skills

All skills are **manual** — invoke with `/skill:<name>`; none auto-load. Bodies never enter context until invoked, so the skill roster costs nothing per session.

| Skill                | Purpose                                                            | Invocation                    |
| -------------------- | ------------------------------------------------------------------ | ----------------------------- |
| ponytail             | Lazy-minimum intensity modes over the AGENTS.md ladder             | `/skill:ponytail`             |
| web-search           | Web search + URL extraction via Tavily CLI                         | `/skill:web-search`           |
| systematic-debugging | Phased root-cause debugging before proposing any fix               | `/skill:systematic-debugging` |
| code-reviewer         | CI-parity correctness review of the diff before commit/push        | `/skill:code-reviewer`         |
| auth                 | NextAuth v4 credentials auth for Next.js App Router                | `/skill:auth`                 |
| brainstorming        | Explore genuinely-unclear feature direction                        | `/skill:brainstorming`        |
| browser-tools        | Live DOM via CDP `:9222` — Playwright/e2e                          | `/skill:browser-tools`        |
| documentation-writer | Diátaxis-based tech writer: SDK docs, READMEs, docs audits         | `/skill:documentation-writer` |
| fallow-audit         | Dead-code / unused-export / unused-dependency cleanup              | `/skill:fallow-audit`         |
| frontend-design      | New web components/pages/apps from scratch                         | `/skill:frontend-design`      |
| impeccable           | Design quality for existing UI — audit/critique/polish, 24 verb commands (vendored upstream, Apache-2.0; sync: `scripts/sync-impeccable.mjs`) | `/skill:impeccable`           |
| linkedin             | LinkedIn writing suite — posts/comments/DMs/plans/profile in user's voice, mandatory humanizer pass (vendored upstream, MIT) | `/skill:linkedin`             |
| github-actions       | Author/harden CI workflows: SHA-pinned actions, actionlint          | `/skill:github-actions`       |
| grill-me             | One-question-at-a-time stress-testing of a plan                    | `/skill:grill-me`             |
| harness-engineer     | Meta: audit/improve this harness                                   | `/skill:harness-engineer`     |
| map-integration      | maplibre/mapbox-gl, deck.gl, turf, draw; GL map stack        | `/skill:map-integration`      |
| pidoc                | Harness setup health check; `--fix` rebuilds tools                 | `/skill:pidoc`                |
| playwright-tester    | e2e specs, stress runs, untested-critical-path coverage             | `/skill:playwright-tester`    |
| refactoring-ui       | Audit/fix existing UI: hierarchy, spacing, color, depth            | `/skill:refactoring-ui`       |
| session-audit        | Token/cost waste audit of `~/.pi/agent/sessions`                   | `/skill:session-audit`        |
| skill-manager        | Create/modify SKILL.md + mandatory validator gate                  | `/skill:skill-manager`        |
| rust-skills          | Comprehensive Rust coding guidelines — 269 rules across 26 categories | `/skill:rust-skills`          |
| sdk-development      | Develop, test, publish installable packages — SDKs, CLIs, plugins: codegen, exports map, semver, publish gate | `/skill:sdk-development`      |

## Skill layout (validator-enforced)

```text
<name>/
├── SKILL.md        # required; the only loose file allowed at top level
├── scripts/        # executable code (.sh/.mjs/.py/...), incl. helper modules
├── references/     # additional docs read on demand (progressive disclosure)
└── assets/         # static resources: templates, images, data files
```

Enforced by `node skills/skill-manager/scripts/validate-skill.mjs <skill-dir>`. `npm run doc:check` additionally verifies that harness commands and paths declared in markdown resolve.
