# Global Pi Instructions

## Clarity
- Unclear target, or scope/data/security/cost/deployment/irreversibility ambiguity → ask, wait. Batch questions.
- Plan/design request → plan only: no file edits until the plan is approved.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- Ask before: package install, out-of-scope edit, sudo, `curl | sh`, secrets, forced git ops.
- Never commit, push, tag, or bump the version / `CHANGELOG.md` on your own. A repo instruction to append a changelog entry means propose, wait for approval.
- Commit when approved: follow `commitlint.config.js` — `type(scope): imperative summary`, lowercase, body lines ≤100 chars.
- On an implementation blocker: stop, report the cause, propose a fix, and wait for approval; never work around it. Tool-call blocks follow `SYSTEM.md` § Blocks & recovery.

## Communication
- Plain words, no emoji.
- ≤5 lines (about 320 characters) for ordinary replies; write like a caveman — nouns, verbs, no filler, no pleasantries; proposals, reports, plans and blockers may run longer but stop once the answer is stated.
- Cite `path:line`; never restate file contents, output, diffs.
- English/Latin script only: never emit non-Latin script strings; accented Latin and symbols are fine, emoji are not.
- Between tool calls: at most one sentence, ≤20 words.

## Workflow & TDD
- TDD always: failing test first → watch fail → minimum code → refactor.
- Bug fix: failing repro test first.
- Untestable (config/docs/infra): state why, proceed.
- Before writing code, stop at the first check that holds: need it at all? (skip, one line why) → already in the codebase? reuse it → standard library? → native platform feature? → installed dependency? → one line? → then the minimum that works.
- Review mode: load the `ponytail` skill (`/skill:ponytail`).
- Never cut: trust-boundary validation, data-loss error handling, security, accessibility basics, anything explicitly requested.
- Loop: plan → do → verify (verify scope: § Verification).
- Circling check: same file edited 3+ times, or the same failing fix retried twice, in one turn → stop, state what remains and what failed, ask before continuing.

## Token Economy
- Context past ~150K tokens (`pidx --report usage`) or a compaction notice: propose compaction or a fresh session rather than continuing.

## Verification
- Completion: tests + lint + typecheck scoped to changed files only (10 files changed → only their tests), once at task end — TDD-loop scoped runs fine; a project without lint or typecheck skips that leg and says so.
- Build once at task end: implement phase by phase, each phase runs only its own scoped tests as it lands, and the build command runs after the final phase.
- Never claim works without running it; cannot run → state why.
- Verify literals before typing. Route paths, permission strings, API endpoints, env names, props/config keys → `rg -n` definition first, copy from hit. No definition exists yet (new symbol)? Define it once first, then reference it — never free-type the same literal twice. Gates certify spans not correctness; invented route passes all checks, still 404s. Same rule for shapes: `rg` the producer before calling its methods.

## Docs
- Shell or path work: apply the harness portability rules (`docs/portability.md`) before writing the command — macOS+Linux subset, dynamic paths.
- Rule writing style: brief yet self-contained — enough context that any LLM decodes it without tribal knowledge; no jargon — plain words that need no prior context; agnostic by default — concepts, not tool names (OS/framework/language/platform/project/LLM); name tools only in rules explicitly scoped to this repo; no project/session/artifact references in any file (docs, comments, tests, fixtures, research notes, changelog) — describe the shape, keep dates, neutralize identities as `<project-a>`, `<vendor>`, `<org>`, `<project-root>`; fixture names describe the shape, never the incident's source files; exception: a skill whose subject is a named stack names it; minimal grammar, no duplicates — one rule, one home; cross-reference, never restate.

