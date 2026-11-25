# Lean instruction layer — implementation plan (Option C)

Companion to: `docs/specs/2026-11-21-lean-instruction-layer-design.md`.
Self-contained and ordered for a model to apply.

**Status: superseded — not applied.** The shipped change set kept the full
`AGENTS.md` (not the 19-line version below) and made `docs/tool-use.md` apply in
every project. The steps below are the historical plan; do not execute them
(Step 0's `git reset --hard` would discard current work).

## Step 0 — clean base + baseline measurement

The working tree currently holds a superseded, uncommitted restore. Discard it:

```bash
cd ~/.pi/agent
git reset --hard HEAD
git status --short   # must print nothing
```

Record the pre-change gate-block baseline (this reads session logs):

```bash
npm run audit:blocks
```

Note `blocks=` and `one-shot-recovery=` for the Step 8 comparison.

## Step 1 — delete the proposal artifact

```bash
git rm MIGRATION.md
```

## Step 2 — rewrite `AGENTS.md`

Replace the entire file with exactly:

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

## Step 3 — create `docs/tool-use.md` from the pre-rewrite SYSTEM.md

```bash
git show HEAD^:SYSTEM.md > docs/tool-use.md
```

Then edit only these two lines in `docs/tool-use.md`:

- `# Tool Calling` → `# Tool-use conventions`
- insert directly after the title:
  `These conventions apply to maintenance of the pi-native repository. They are not global requirements for unrelated projects.`

Keep the rest of the body verbatim.

## Step 4 — confirm SYSTEM.md stays absent

`SYSTEM.md` is already deleted at HEAD. Do not recreate it. Do not add
`APPEND_SYSTEM.md`.

## Step 5 — update SYSTEM.md references

Apply these exact replacements:

1. `prompts/harness-watch.md`
   - `SYSTEM.md/AGENTS.md tool rules` → `AGENTS.md / docs/tool-use.md tool rules`

2. `agents/pi-mechanic.md`
   - `SYSTEM.md/AGENTS.md tool rules` → `AGENTS.md / docs/tool-use.md tool rules`

3. `docs/harness-watch.md`
   - `AGENTS.md/SYSTEM.md/scout` → `AGENTS.md/docs/tool-use.md/scout`

4. `skills/self-learn/SKILL.md`
   - `(SYSTEM.md tool-path/bash/blocks,` → `(docs/tool-use.md tool-path/bash/blocks,`

5. `skills/self-learn/references/detectors.md`
   - `(SYSTEM.md tool-path/bash/blocks,` → `(docs/tool-use.md tool-path/bash/blocks,`

6. `extensions/permission-gate/rules/anchor-guard.ts`
   - `// (SYSTEM.md Re-reads).` → `// (AGENTS.md gate contract / tool-use.md Re-reads).`

7. `scripts/harness-watch.mjs`
   - `const DOC_FILES = ["AGENTS.md", "agents/scout.md"];`
     → `const DOC_FILES = ["AGENTS.md", "docs/tool-use.md", "agents/scout.md"];`

## Step 6 — doccheck waiver for `git stash --staged`

In `rust-tools/docheck/src/mdcmds.rs`, add `"git stash --staged"` to the
`FLAG_WAIVERS` list (after `"git --untracked-files",`) and to the
`flag_waivers_cover_valid_subcommand_flags` test array (same position).

## Step 7 — restore evolved on-demand docs from HEAD^

These are on-demand, so this does not affect the always-on budget:

```bash
git checkout HEAD^ -- CONTRIBUTING.md docs/change-rules.md docs/design-rules.md docs/development.md docs/portability.md docs/subagents.md
```

## Step 8 — verify

```bash
npm run lint:agents                 # exit 0
cd rust-tools && cargo test -p docheck && cd ..   # all pass
cd rust-tools && cargo build --release -p docheck && cp target/release/docheck ../bin/docheck && cd ..
npm run doc:check                   # exit 0, "all 4 families passed"
npm run bench:model-visible -- --compare   # no growth (shrinkage expected)
npm test                            # green
npm run audit:blocks                # one-shot-recovery >= 85%; blocks not sharply up vs Step 0
```

Final sanity: `git status --short` shows no `SYSTEM.md`, and `wc -c AGENTS.md`
is roughly 1.9 KB (down from 7,899 bytes).
