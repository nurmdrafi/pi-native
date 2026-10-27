# Global Pi Instructions

Purpose: agent behavior + guidelines.
`pi-native`: personal pi coding-agent harness. Extensions: permission-gate, subagents, handoff.
Commands (this repo): `npm run check` (typecheck + lint + doc check + tests); `npm run gate:eval` (gate evaluation); `npm run daemons:kill` (kill stale native daemons after a rebuild). Other projects: their own scoped test/lint/typecheck commands.
Always loaded. Deeper rules in `docs/` — read linked doc only when task touches that area.

## Clarity
- Unclear target, or scope/data/security/cost/deployment/irreversibility ambiguity → ask, wait. Batch questions.
- Plan/design request → plan only.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- permission-gate authoritative.
- Ask before: package install, destructive command, out-of-scope edit, sudo, `curl | sh`, secrets, forced git ops.
- Never commit, push, tag, or bump the version / `CHANGELOG.md` on your own. A repo instruction to append a changelog entry means propose, wait for approval.
- On block: stop → report reason → fix cause. No workaround without approval.

## Communication
- Short complete sentences, plain prose, no emoji.
- ≤5 lines ordinary replies; longer only for proposals, reports, plans, blockers.
- Cite `path:line`; never restate file contents, output, diffs.
- Between tool calls: max one short sentence.
- Estimates: plans, task lists, and progress reports state wall-clock time per item and for the total, with confidence ("~15 min, low"). Cannot estimate → say so and name the blocking unknown.
- Estimate calibration: anchor to observed pace (tool rounds × ~1 min/round, recent same-kind tasks), quote a range ("2-4 min"), never pad; beaten by ~2x+ → next quote drops to the observed band.

## Workflow & TDD
- TDD always: failing test first → watch fail → minimum code → refactor.
- Bug fix: failing repro test first.
- Untestable (config/docs/infra): state why, proceed.
- Ponytail ladder — before writing code, stop at the first rung that holds: need it at all? (skip, one-line why — YAGNI) → already in the codebase? reuse it → stdlib? → native platform feature? → installed dependency? → one line? → then the minimum that works. Less code, never less care.
review: skill `ponytail`.
- Never cut: trust-boundary validation, data-loss error handling, security, accessibility basics, anything explicitly requested.
- Loop: plan → do → verify.
- Circling check: same file edited 3+ times, or the same failing fix retried twice, in one turn → stop, state what remains and what failed, ask before continuing.
- Machine/device/OS agnostic — detail: docs/portability.md.

## Token Economy
- Past ~150K context or ~200 turns, the accumulated prefix dominates cost: propose compaction or a fresh session rather than continuing.

## Verification
- Completion: tests + lint + typecheck scoped to changed files only (10 files changed → only their tests), once at task end — TDD-loop scoped runs fine.
- Full suite only: shared config, CI, build change, broad refactor.
- Build only after risky structural edit or task end.
- Never claim works without running it; cannot run → state why.
- Verify literals before typing. Route paths, permission strings, API endpoints, env names, props/config keys → `rg -n` definition first, copy from hit. No definition exists yet (new symbol)? Define it once first, then reference it — never free-type the same literal twice. Gates certify spans not correctness; invented route passes all checks, still 404s.
- Shapes: `rg` producer before method calls.
- English/Latin text only; cover multi-byte UTF-8 with accented Latin or symbol characters (é, €, emoji), never non-Latin script string.
- Commit body lines ≤72 (commitlint hook).

## Tooling
- Reuse before writing: the native tools already parse most of what a new script would — session logs (`pidx`), file reads (`piread`), edits (`piedit`), shell (`pibash`). Extend that crate (`rust-tools/`) instead of adding a second parser.
- A new compiled tool earns its place only when the work is byte-heavy per call, must run where Node is absent, and is called often enough for its latency to show. Otherwise the script belongs in `tests/tools/`.
- Never add a second build workspace: new crates join `rust-tools/`, install through `scripts/lib/install-native.sh`, and emit a one-line JSON envelope on stdout.

## Docs
- Rule writing style: concise yet self-contained — enough context that any LLM decodes it without tribal knowledge; agnostic by default — concepts, not tool names (OS/framework/language/platform/project/LLM); name tools only in rules explicitly scoped to this repo; minimal grammar, no duplicates — one rule, one home; cross-reference, never restate.
- [docs/change-discipline.md](docs/change-discipline.md) — change ladder, root cause, deployment
- [docs/portability.md](docs/portability.md) — macOS+Linux shell subset, dynamic paths
- [docs/rust-tools-optimization.md](docs/rust-tools-optimization.md) — safe path for optimizing a native tool: model the cost, freeze the old binary, pin the seam, swap, verification ladder, honest measurement
