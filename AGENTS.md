# Global Pi Instructions

Purpose: agent behavior + guidelines — clarity, safety, communication, workflow, verification, docs.
`pi-native`: personal pi coding-agent harness. Extensions: permission-gate, subagents, handoff. Rust tools: piread, piedit, pibash, pidx. npm; Node: `.nvmrc`.
Commands (this repo): `npm run check` (typecheck + lint + doc check + tests); `npm run gate:eval` (gate evaluation); `npm run daemons:kill` (kill stale native daemons after a rebuild). Other projects: use their own scoped test/lint/typecheck commands — the Completion rule states the goal, not the tool.
Always loaded. Deeper rules in `docs/` — read linked doc only when task touches that area.

## Clarity
- Unclear target, or scope/data/security/cost/deployment/irreversibility ambiguity → ask, wait. Batch questions.
- Plan/design request → plan only.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- permission-gate authoritative.
- Ask before: package install, destructive command, out-of-scope edit, sudo, `curl | sh`, secrets, forced git ops.
- Never commit, push, tag, or bump the version / `CHANGELOG.md` on your own — same class as git commit: ask first, every time. A repo instruction that says "append a changelog entry per change" does not override this; it means propose the entry, wait for approval.
- On block: stop → report reason → fix cause. No workaround without approval.

## Communication
- Short complete sentences, plain prose, no emoji.
- ≤5 lines ordinary replies; longer only for proposals, reports, plans, blockers.
- Cite `path:line`; never restate file contents, output, diffs.
- Between tool calls: max one short sentence.

## Workflow & TDD
- TDD always: failing test first → watch fail → minimum code → refactor. No implementation before failing test.
- Bug fix: failing repro test first.
- Untestable (config/docs/infra): state why, proceed.
- Loop: plan → do → verify.
- Machine/device/OS agnostic — detail: docs/portability.md.

## Verification
- Completion: run tests + lint + typecheck scoped to the changed files only (10 files changed → only their tests), not the full repo; once at task end, not after every edit.
- TDD-loop scoped runs fine; otherwise test once, narrowest check.
- Full suite only: shared config, CI, build change, broad refactor.
- Build only after risky structural edit or task end.
- Never claim works without running it; cannot run → state why.
- Verify literals before typing. Route paths, permission strings, API endpoints, env names, props/config keys → `rg -n` definition first, copy from hit. No definition exists yet (new symbol)? Define it once first, then reference it — never free-type the same literal twice. Gates certify spans not correctness; invented route passes all checks, still 404s.
- Shapes: `rg` producer before method calls.
- Commit body lines ≤72 (commitlint hook).

## Docs
- Rule writing style: concise yet self-contained — enough context that any LLM decodes it without tribal knowledge; agnostic by default — concepts, not tool names (OS/framework/language/platform/project/LLM); name tools only in rules explicitly scoped to this repo; minimal grammar, no duplicates — one rule, one home; cross-reference, never restate.
- [docs/change-discipline.md](docs/change-discipline.md) — change ladder, root cause, deployment
- [docs/portability.md](docs/portability.md) — macOS+Linux shell subset, dynamic paths
