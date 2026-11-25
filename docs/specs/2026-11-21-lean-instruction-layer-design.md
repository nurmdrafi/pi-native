# Lean instruction layer — design spec (Option C: super-minimal, solid protections)

Date: 2026-11-21
Status: proposal (not applied)
Applies to: the pi-native agent home (`~/.pi/agent`)

## Goals

1. Super-minimal always-on instruction surface.
2. Solid architecture: gate enforces, instructions stay tiny, detail is on demand.
3. Solid protections: keep the permission gate fully armed and the self-healing
   loop intact; never weaken safety.

## Decision — Option C

- **Delete `SYSTEM.md`** (no system-prompt override; keep Pi's default prompt).
- **No `APPEND_SYSTEM.md`.**
- **`AGENTS.md` shrinks to ~19 lines** (~1.9 KB): universal behavior + the gate
  contract + the few countermeasures with the best block-per-token return.
- **`docs/tool-use.md`** holds the full tool-calling detail (on demand; costs
  nothing in the always-on budget).
- **Keep** the permission gate, `harness-watch`, `self-learn`, and `pi-mechanic`
  — they are the protections. Only their `SYSTEM.md` references move.

## Empirical grounding

### Gate-block audit (`npm run audit:blocks`, reads session logs)

```
blocks=1680  one-shot-recovery=1535 (91%)  same-family-reblock=101  other-next=44
rules: Anchor Guard=633  Token Economy=341  Permission Gate=312  Hygiene=131
       Locate-first=110  Search=72  Commitlint=50  Toolchain=19  Loop Guard=12
OK: recovery gate >= 85%
```

The 91% one-shot recovery is the justification for Option C: the gate's block
messages already teach the remedy just-in-time, so the always-on layer does not
need to carry the full discipline.

### Lessons (`lessons/harness.ndjson`, 122 records)

Recurring causes, in order: `cat`/`sed -n`/`head` file views trip reader-bypass;
`rm`/inline-interpreter one-liners trip the destructive gate; unread-anchor
edits trip Anchor Guard; `rg -rn` mis-parses as `--replace`.

### Changelog (1.79.0)

`SYSTEM.md` standing rules were added to counter "Anchor Guard (633 history
blocks), re-reads (225), vendored-tree searches, reader discipline, bounded
windows, and identical re-sends." Prior releases repeatedly moved detailed
doctrine out of `AGENTS.md` into scoped docs to shrink always-on context — this
design extends that pattern to the limit.

### Gate family → countermeasure map

| Family | blocks | Always-on countermeasure (kept in `AGENTS.md`) | Full detail (`docs/tool-use.md`) |
|---|---|---|---|
| Anchor Guard | 633 | edit only regions read this session | edit anchors from session reads; re-read before edit if the file changed |
| Token Economy | 341 | never re-read a span already seen | continue at named offset; don't widen; batch calls |
| Permission Gate (Destructive) | 312 | never bypass a block; follow the message | prefer non-destructive; `/tmp` scratch; `>>` final-byte probe |
| Hygiene (Reader-bypass) | 131 | `piread` windows; never `cat`/`sed -n`/`head` a file | `cat`/`head`/`sed` only trim command output |
| Locate-first | 110 | covered by the gate contract | resolve paths before reading |
| Search | 72 | covered by the gate contract | `rg`/`fd` first; never `node_modules/`/`vendor/`/`dist/` |
| Commitlint | 50 | covered by the gate contract | commit-message shape |

The always-on file covers the top four families directly; the remaining three are
handled by the gate's block messages (already 91% self-healing).

## Target architecture

| Surface | Content | Load |
|---|---|---|
| Pi default system prompt + tool schemas | Pi-managed | every turn |
| `AGENTS.md` | ~19 lines: behavior + gate contract + top countermeasures + repo pointer | every turn |
| `docs/tool-use.md` | full tool-calling detail (former `SYSTEM.md` body) | on demand |
| `docs/*.md` | scoped procedures | on demand |
| permission gate + `harness-watch` + `self-learn` | mechanical enforcement + self-healing | runtime / on demand |

## Target content: `AGENTS.md`

```markdown
# Agent instructions

## Behavior
- Clarify only when uncertainty changes scope, correctness, cost, security, or irreversibility; otherwise state a reasonable assumption and proceed.
- A plan or design request is planning-only until implementation is authorized.
- Ask before destructive, externally visible, costly, privileged, deployment, or out-of-scope actions. Never write secrets or credentials into tracked files.
- Use plain, concise language. No emoji.

## Gate contract
- The permission gate enforces read/edit/search/commit discipline. A block is final for that operation: read the block message, apply its remedy, or ask — never bypass, reroute, or disguise.
- Edit only file regions read this session; never re-read a span already seen this session.
- View files through `piread` windows — never `cat`/`sed -n`/`head` a file (use them only to trim command output).

## Change discipline
- Prefer the smallest change that fixes the root cause; add or update a regression test for behavior changes; verify the changed scope and never claim a check passed unless it ran.

## Repository rules
When working in this repo (`~/.pi/agent`), read `docs/tool-use.md` before tool-heavy work and the relevant scoped doc for subagent, portability, or release changes. Keep machine-specific paths, credentials, and private endpoints out of tracked files.
```

## Target content: `docs/tool-use.md`

Take the full body of the pre-rewrite `SYSTEM.md`
(`git show HEAD^:SYSTEM.md`) and change its title only:

- `# Tool Calling` → `# Tool-use conventions`
- add directly under the title:
  `These conventions apply to maintenance of the pi-native repository. They are not global requirements for unrelated projects.`

Body (Call economy, File lookup, Bash, Recovery, Delegated calls, Lesson-log
calls, Commit calls, Portability) stays verbatim.

## Reference updates (SYSTEM.md → new home)

| File:line | Change |
|---|---|
| `prompts/harness-watch.md:12` | `SYSTEM.md/AGENTS.md tool rules` → `AGENTS.md / docs/tool-use.md tool rules` |
| `agents/pi-mechanic.md:21` | `SYSTEM.md/AGENTS.md tool rules` → `AGENTS.md / docs/tool-use.md tool rules` |
| `docs/harness-watch.md:20` | `AGENTS.md/SYSTEM.md/scout` → `AGENTS.md/docs/tool-use.md/scout` |
| `skills/self-learn/SKILL.md:50` | `(SYSTEM.md tool-path/bash/blocks,` → `(docs/tool-use.md tool-path/bash/blocks,` |
| `skills/self-learn/references/detectors.md:71` | `(SYSTEM.md tool-path/bash/blocks,` → `(docs/tool-use.md tool-path/bash/blocks,` |
| `extensions/permission-gate/rules/anchor-guard.ts:396` | `// (SYSTEM.md Re-reads).` → `// (AGENTS.md gate contract / tool-use.md Re-reads).` |
| `scripts/harness-watch.mjs` | `DOC_FILES = ["AGENTS.md", "agents/scout.md"]` → `["AGENTS.md", "docs/tool-use.md", "agents/scout.md"]` |

## Other changes

- Delete `MIGRATION.md`.
- `scripts/agents-lint.mjs` is already `AGENTS.md`-only at HEAD; no change.
- `rust-tools/docheck/src/mdcmds.rs`: add `"git stash --staged"` to
  `FLAG_WAIVERS` and to the `flag_waivers_cover_valid_subcommand_flags` test
  (the restored `docs/development.md` documents that version-gated flag).
- Restore the evolved on-demand docs from `HEAD^` (on-demand, so no always-on
  cost): `CONTRIBUTING.md`, `docs/change-rules.md`, `docs/design-rules.md`,
  `docs/development.md`, `docs/portability.md`, `docs/subagents.md`.
- `settings.json` `lastChangelogVersion: "1.6.0"` is correct (tracks Pi's
  version, not this repo's changelog); leave it.

## Verification

1. Baseline first: `npm run audit:blocks` — record `blocks` and
   `one-shot-recovery`.
2. `npm run lint:agents` → exit 0.
3. `cargo test -p docheck` (from `rust-tools/`) → all pass.
4. Rebuild docheck, then `npm run doc:check` → exit 0, "all 4 families passed".
5. `npm run bench:model-visible -- --compare` → no growth (shrinkage expected).
6. `npm test` → green.
7. Re-run `npm run audit:blocks` → recovery must stay `>= 85%`.

## Risks and rollback

- Removing always-on detail may raise the absolute block count (more mistakes)
  even though recovery stays ~91%. If the post-change block count rises sharply,
  re-add the corresponding one-liner to the "Gate contract" section rather than
  recreating `SYSTEM.md`.
- Rollback: `git revert` the apply commit, or restore `SYSTEM.md` with
  `git show HEAD^:SYSTEM.md > SYSTEM.md`.

## Alternatives considered

- **A (lean AGENTS.md only, no gate contract emphasis)** — closest to this but
  without the explicit block-family mapping; rejected in favor of grounding the
  kept rules in the measured block counts.
- **B (APPEND_SYSTEM.md discipline layer)** — keeps the discipline in the system
  prompt; rejected as non-minimal and a second always-on file to sync.
