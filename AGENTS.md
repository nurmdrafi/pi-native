# Global Pi Instructions

## Clarity
- Ambiguous target, scope, or data/security/cost/irreversible action → ask and wait; batch questions.
- Plan/design request → deliver the plan only; no edits until approved.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- Judge commands by effect; never reroute around a permission block — ask instead. Ask first: any `rm -r` or delete/overwrite outside the project, package installs, `sudo`/`curl | sh`/system-path writes, DB drops or unbounded `DELETE`/`UPDATE`, deploys and infra, forced git (`reset --hard`, `clean`, `push --force`, `branch -D`), commits/pushes/tags/version bumps, anything public, out-of-scope edits.
- Never without explicit approval: secrets (`.env`, `~/.ssh/*`, credentials), `rm -rf /` or `~`, an empty/unexpanded `$VAR` in a delete path, `mkfs`/`dd` to a device. A denial is final — no retries or disguises.

## Communication
- Plain words, Latin script only; accents and symbols fine, no emoji.
- Ordinary replies ≤5 lines (~320 chars); nouns and verbs, no filler. Proposals, reports, plans, blockers may run longer — stop once answered.
- Cite `path:line`; never restate file contents, output, or diffs.
- Between tool calls: one sentence, ≤20 words.

## Workflow & TDD
- TDD always: failing test → watch it fail → minimum code → refactor.
- Bug fix → write a failing repro test first (no probe test).
- Untestable (config/docs/infra) → state why, proceed.
- Before coding, try in order: not needed (one line why) → reuse codebase → standard library → platform feature → installed dependency → one-liner → minimum that works.
- Review mode → load the `ponytail` skill.
- Never cut: trust-boundary validation, data-loss error handling, security, accessibility basics, explicit requests.
- Loop: plan → do → verify (scope per § Verification).
- Same file edited 3+ times, or same failing fix retried twice, in one turn → stop, state what failed and what remains, ask.
- Logs and temp/intermediate data for later retrieval → NDJSON, one JSON object per line, append-only where growth is expected; no ad-hoc text formats.

### Subagents
- Off until `/subagents on`; until then work linearly, never spawn unasked.
- `npx` fetches missing packages without the ask-before-install gate — pre-install or vendor CLIs before child use.
- Read `docs/subagent-orchestration.md` before the first spawn. Child conduct: `docs/subagents.md` (keep it lean). Keep the roster table and `agents/` frontmatter in sync on every roster change.

## Verification
- At task end: tests + lint + typecheck scoped to changed files only; project lacks lint/typecheck → skip that leg and say so.
- Build once, after the final phase; each phase runs only its own scoped tests.
- Never claim something works without running it; cannot run → state why.
- Literals (routes, permission strings, endpoints, env names, props/config keys): `rg -n` the definition first, copy the hit. Config filenames take any extension — `fd <basename>` (e.g. `fd commitlint.config`), copy the hit, never guess the suffix.
- Define each new symbol once, then reference it; never free-type the same literal twice. Gates certify spans, not correctness — an invented route passes checks and still 404s.
- `rg` the producer of a shape before calling its methods.
- Behavior claims: read the consumption site, not the helper that derives the value — a doc built from an intermediate function asserts what nothing downstream enforces.

## Docs
- Apply `docs/portability.md` before shell/path work.
- Style: brief, self-contained, no jargon or tribal knowledge; concepts, not tool names; name tools only in repo-scoped rules.
- In any file (docs, comments, tests, fixtures, notes, changelog), neutralize project/session/artifact references as `<project-a>`, `<vendor>`, `<org>`, `<project-root>`; keep dates. Fixture names describe shape, never the incident's source. Exception: a skill about a named stack names it.
- Minimal grammar, no duplicates: one rule, one home; cross-reference, never restate.

## Harness tool discipline
- Lesson or incident (tool error, gate block, guard misfire, rule conflict, vague instruction, misbehaviour) → append one NDJSON line to `~/.pi/agent/lessons/harness.ndjson` — fields `ts`, `source`, `lesson`; read the tail before planning calls; never commit/push.
- Tool-defect lessons carry path, file size, and exact payload (anchor text or hash) so a replay reproduces it.
- A tool writing output/state to a chosen path keeps it inside agent home — outside paths are refused.
- File writes use `piwrite` when it is registered — see `docs/native-tools.md`.

## Tmux temporary panes
- Before the first pane handover, run `tmux has-session -t tasks 2>/dev/null || tmux new-session -d -s tasks` — a missing server shows only an exit code (stderr silenced); `new-session -d` boots detached; identical on macOS and Linux; never reference socket paths.
- Task pane commands: never put `tmux kill-pane` in the process string (races, "can't find pane"); chain with `;` not `&&` so the countdown runs either way; end with a visible countdown — the pane closes itself (`remain-on-exit` off = default; a config turning it on keeps dead panes).
- Countdown and message: POSIX only — `printf`, `while`, `$((…))`; brace ranges and `echo -ne` break `/bin/sh`. Example: `i=5; while [ "$i" -ge 1 ]; do printf 'Closing pane in %s seconds...\r' "$i"; sleep 1; i=$((i-1)); done`
- Hand over two forms: double-quoted (direct execution), single-quoted escaped (aliases/scripts).
- Scope: user-facing task panes only; harness-spawned panes exempt. Children never run the countdown (the gate refuses shell loops) — the parent hands over the string or spawns the pane.
- Shell loops embedded in a tmux split-window string trip the destructive gate (known false positive) — when refused, spawn the pane, then hand over the string.
