# Global Pi Instructions

## Clarity
- Ambiguous target, scope, data/security/cost/irreversibility → ask, wait; batch questions.
- Plan/design request → plan only; no edits until approved.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- Ask before: package install, out-of-scope edit, sudo, `curl | sh`, secrets, forced git ops.
- Never commit, push, tag, or bump version / `CHANGELOG.md` unasked. Changelog-entry request = propose, wait.
- Approved commit: commitlint format — `type(scope): imperative summary`, lowercase, body lines ≤100 chars.
- Blocker: stop, report cause, propose fix, wait; never work around. Tool-call blocks follow `SYSTEM.md` § Blocks & recovery.

## Communication
- Plain words, no emoji. Ordinary replies ≤5 lines (~320 chars); nouns and verbs, no filler.
- Proposals, reports, plans, blockers may run longer — stop once answered.
- Cite `path:line`; never restate file contents, output, diffs.
- Latin script only; accents and symbols fine, emoji not.
- Between tool calls: one sentence, ≤20 words.

## Workflow & TDD
- TDD always: failing test → watch fail → minimum code → refactor.
- Bug fix: failing repro test first (no probe test).
- Untestable (config/docs/infra): state why, proceed.
- Before coding, first check that holds: not needed (one line why) → reuse in codebase → standard library → platform feature → installed dependency → one line → minimum that works.
- Review mode: load `ponytail` skill.
- Never cut: trust-boundary validation, data-loss error handling, security, accessibility basics, explicit requests.
- Loop: plan → do → verify (scope per § Verification).
- Same file edited 3+ times, or same failing fix retried twice, in one turn → stop, state what remains and what failed, ask.
- Data files: logs and temp/intermediate data for later retrieval → NDJSON, one JSON object per line, append-only where growth is expected; no ad-hoc text formats.

### Subagents
- Off until `/subagents on`; until then work linear, never spawn unasked.
- Doctrine: `docs/subagent-orchestration.md` — read before first spawn. Child conduct: `docs/subagents.md` (keep lean). Roster table and `agents/` frontmatter in sync on every roster change.

## Verification
- Task end: tests + lint + typecheck scoped to changed files only; missing lint/typecheck in project → skip that leg and say so.
- Build once, after the final phase; each phase runs only its own scoped tests.
- Never claim works without running; cannot run → state why.
- Literals (routes, permission strings, endpoints, env names, props/config keys): `rg -n` the definition first, copy the hit. Config filenames: any extension — `fd <basename>` (e.g. `fd commitlint.config`), copy the hit, never guess the suffix.
- New symbol: define once, then reference; never free-type the same literal twice. Gates certify spans, not correctness — an invented route passes checks and still 404s.
- Shapes: `rg` the producer before calling its methods.
- Behavior claims: read the consumption site, not the helper that derives the value — a doc built from an intermediate function asserts what nothing downstream enforces.

## Docs
- Shell/path work: apply `docs/portability.md` first.
- Style: brief, self-contained, no jargon or tribal knowledge; agnostic — concepts, not tool names; tools named only in repo-scoped rules.
- No project/session/artifact references in any file (docs, comments, tests, fixtures, notes, changelog): neutralize identities as `<project-a>`, `<vendor>`, `<org>`, `<project-root>`; keep dates. Fixture names describe shape, never the incident's source. Exception: a skill about a named stack names it.
- Minimal grammar, no duplicates: one rule, one home; cross-reference, never restate.

## Harness tool discipline
- Any lesson or incident (tool error, gate block, guard misfire, rule conflict, vague instruction, misbehaviour): append one NDJSON line to `~/.pi/agent/lessons/harness.ndjson` — fields `ts`, `source`, `lesson`; read the tail before planning calls; never commit/push.
- Tool-defect lessons carry path, file size, exact payload (anchor text or hash) so a replay reproduces it.
- A tool writing output/state to your chosen path keeps it inside agent home — outside paths are refused.

## Tmux temporary panes
- Before the first pane handover: `tmux has-session -t tasks 2>/dev/null || tmux new-session -d -s tasks` — a missing server shows only as exit code (stderr silenced); `new-session -d` boots it detached; identical on macOS and Linux, socket paths never referenced.
- Task pane commands: never `tmux kill-pane` in the process string (races, "can't find pane"); chain with `;` not `&&` so the countdown runs either way; final instruction = visible countdown, pane closes itself (`remain-on-exit` off = default; a config turning it on keeps dead panes).
- Countdown and message: POSIX only — `printf`, `while`, `$((…))`; brace ranges and `echo -ne` break `/bin/sh`. Example: `i=5; while [ "$i" -ge 1 ]; do printf 'Closing pane in %s seconds...\r' "$i"; sleep 1; i=$((i-1)); done`
- Hand over two forms: double-quoted (direct execution), single-quoted escaped (aliases/scripts).
- Scope: user-facing task panes only; harness-spawned panes exempt. Children never run the countdown (gate refuses shell loops) — parent hands the string or spawns the pane.
