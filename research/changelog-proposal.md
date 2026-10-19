# CHANGELOG proposal — 2026-10-19 harness changes

Status: **pending approval**. Draft only — do not merge into `CHANGELOG.md`.
On approval, paste the block below at the top of `CHANGELOG.md` (repo
convention: latest-first). Heading style assumes a dated `## 2026-10-19`
section with conventional-commit `###` entries; adjust to match
`CHANGELOG.md`'s existing format if it differs [uncited].

---

## Proposed CHANGELOG.md block

## 2026-10-19

### fix(subagents): resolve native tool-extension paths so children are no longer toolless

**What:** Hardcoded the four first-party `-e` paths (piread, piedit, pibash,
pidx) into getToolExtensionPath's built-in map, beside the existing
web_search/safe_bash precedent (`extensions/subagents/index.ts`).

**Why:** Runtime `registerToolExtension` registrations were silent no-ops due
to alphabetical extension load order — subagents loads after the native
extensions, so paths were unknown at child-spawn time. Children spawned with
`--no-extensions` received zero native `-e` flags; every worker/researcher
child since 2026-10-19 was toolless (4 documented stand-downs).

**Risk:** Low — built-in map entries are used only when the on-disk path
exists; the runtime registration fallback is retained
(`extensions/subagents/index.ts`).

**Measured delta:** New regression test "resolves tool-extension paths for
the four native tools (load-order safe)" passes; full subagents suite
156/156 green.

**Activation:** Effective for orchestrator sessions started after the edit
(in-memory extension staleness); the probe run from the editing session
correctly stayed toolless post-fix.

### docs: restructure README to 133 lines, migrate detail to docs/

**What:** README cut 438 → 133 lines per the revision plan in
`research/readme-repo-metadata.md`. Detail migrated verbatim to
`docs/native-tools.md` (101 lines), `docs/skills.md` (38),
`docs/subagents.md` (25), `docs/design-rules.md` (51),
`docs/development.md` (117). Contents section removed; demo left as a TODO
placeholder (HTML comment); architecture ASCII diagram added. GitHub About
description swapped and 16 topics applied via `gh` (researched set incl.
harness-engineering, coding-agent, ai-agents).

**Why:** Follows the revision plan in `research/readme-repo-metadata.md`
(README had outgrown front-page scope [uncited]).

**Risk:** Docs-only, low — detail migrated verbatim, so no content lost
[uncited].

**Measured delta:** README 438 → 133 lines (-305); 5 docs pages totalling
332 lines; GitHub About + 16 topics applied.

### docs(extensions): document tool-backing env vars

**What:** New "Tool-backing env vars" section in `extensions/README.md`
covering the `PI_*_BIN` overrides and `PI_SUBAGENT_EXTRA_EXTENSIONS`.

**Why:** Closes part of the doc:check env-vars findings family.

**Risk:** Docs-only, none.

**Measured delta:** doc:check env-vars family 14 findings → 9; forwarded
`PI_*` context keys remain open.

### docs(research): add 8 research reports

**What:** Eight reports added under `research/`: readme-repo-metadata,
pibash-large-output, daemon-protocol, process-groups-cancellation,
benchmark-observability, permission-gate-audit + adjustment plan,
security-boundary, subagents.

**Why:** Records the investigations backing today's changes and the deferred
items [uncited].

**Risk:** Docs-only, none.

**Measured delta:** research/ corpus grew by 8 reports.

---

## Open items deliberately NOT in this entry

- pibash double-serialization fix
- daemon protocol v1
- permission-gate adjustment implementation
- child-model default resolution: children without an explicit model param
  resolved deepseek-v4-pro despite settings glm-5.3; explicit model param
  verified working (probe3 session shows zai/glm-5.3)
