# Global Pi Instructions

`pi-native`: personal pi coding-agent harness. Extensions: permission-gate, subagents, handoff. Rust tools: piread, piedit, pibash, pidx. npm; Node: `.nvmrc`.
Commands: `npm run check` (typecheck + lint + doc check + tests); `npm run gate:eval` (gate evaluation).
Always loaded. Deeper rules in `docs/` — read linked doc only when task touches that area.

## Clarity
- Unclear target, or scope/data/security/cost/deployment/irreversibility ambiguity → ask, wait. Batch questions.
- Plan/design request → plan only.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- permission-gate authoritative.
- Block = instruction. Do the named step, retry once. No verbatim re-send.
- Never search `node_modules`; exception: `node_modules/@earendil-works/` pi docs. Else ask.
- Ask before: package install, destructive command, out-of-scope edit, sudo, `curl | sh`, secrets, forced git ops.
- On block: stop → report reason → fix cause. No workaround without approval.

## Communication
- Short complete sentences, plain prose, no emoji.
- ≤5 lines ordinary replies; longer only for proposals, reports, plans, blockers.
- Cite `path:line`; never restate file contents, output, diffs.
- Between tool calls: max one short sentence.

## Workflow & TDD
- Locate before read: `rg -n term path` first, then `sed -n 'A,Bp'` on a hit. A window ≥100 lines on an unsearched path is blocked (R1c).
- Read before edit: `piread` target region same session before `piedit`; `oldText` = byte-exact from that read.
- No re-read of in-context regions. In-context = session-start project load, earlier `piread`, own edit. `[... omitted ...]` = display elision only, bytes remain — act on them. Read only new regions via `offset`/`limit`.
- TDD always: failing test first → watch fail → minimum code → refactor. No implementation before failing test.
- Bug fix: failing repro test first.
- Untestable (config/docs/infra): state why, proceed.
- Loop: plan → do → verify.

## Verification
- Completion: scoped tests + lint + tsc on changed files, not after every edit.
- TDD-loop scoped runs fine; otherwise test once, narrowest check.
- Full suite only: shared config, CI, build change, broad refactor.
- Build only after risky structural edit or task end.
- Never claim works without running it; cannot run → state why.

## Docs
- [docs/change-discipline.md](docs/change-discipline.md) — change ladder, root cause, deployment
- [docs/portability.md](docs/portability.md) — macOS+Linux shell subset, no user paths
