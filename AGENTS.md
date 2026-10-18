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
- Repeat block same target → stop retrying. Re-read ALL regions call touches, send ONE corrected call. No loop.
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
- Batch always: independent calls (reads, searches, edits separate files) → one parallel block, never one-per-file. Default, not optimization.
- Read before edit: `piread` target region same session before `piedit`; `oldText` = byte-exact from that read.
- ONLY `piread` certifies. `sed`/`cat`/`rg`/`pibash` show bytes, certify NOTHING. Editing a file viewed only via `sed` = Anchor Guard block.
- Multi-region edit, coverage truncates BELOW first edited line after each edit. Edits at lines a<b<c: either ONE `piread` a..c then one `piedit`, or edit bottom-up (read+edit c, then b, then a). NEVER read all then edit all.
- Re-read = two halves. Don't re-read window fully covered by earlier read (R1 re-read = waste). Do treat own edits as certified spans. `[... omitted ...]` = display elision only, bytes remain, act on them. New regions only via `offset`/`limit`.
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
- Verify literals before typing. Route paths, permission strings, API endpoints, env names, props → `rg -n` definition first, copy from hit. Gates certify spans not correctness; invented route passes all checks, still 404s.
- Toolchain first. `node --version` at session start, `nvm use "$(cat .nvmrc)"` before any node/npm/npx. Mismatch known not discovered; proceeding = negligence.

## Docs
- [docs/change-discipline.md](docs/change-discipline.md) — change ladder, root cause, deployment
- [docs/portability.md](docs/portability.md) — macOS+Linux shell subset, no user paths
