# Instruction-file migration

This package is a proposed rewrite for the current pi-native repository, based on the public files inspected on 2026-11-21.

## Apply
1. Replace `AGENTS.md` with the supplied version.
2. Delete the repository-root `SYSTEM.md`. When this repository is cloned to `~/.pi/agent`, that file can replace Pi's default system prompt. The harness does not need that override.
3. Add `docs/tool-use.md` and update the related docs listed in this package.
4. Keep `docs/subagent-orchestration.md` as the detailed source of truth for the current roster and runtime limitations. Update only stale statements there; do not regenerate or hand-edit its agent table independently of `agents/` and the linter.
5. Review `README.md`, `docs/skills.md`, `extensions/README.md`, and `package.json` against the current source before merging. They contain generated inventories or runtime-specific claims and should not be rewritten from summaries.
6. Run the repository's current full check and inspect the final diff.

## Important
This is a proposal, not a commit to GitHub. The public repository may change after inspection. Reconcile these files with the checked-out branch before applying. In particular, verify whether the current permission gate, native-tool dispatch, and subagent extensions still enforce the behavior described by the docs.
