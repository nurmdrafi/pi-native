# Global Pi Instructions

## Scope
- This file holds agent behavior and judgment: safety, communication, workflow, verification, docs, lessons.
- `SYSTEM.md` holds tool invocation mechanics; keep the two apart — no rule lives in both files.
- Do not restate controls that tools, extensions, or the pi system enforce by default (gating, out-of-scope write refusal, install prompts, tool flags). State the agent's response to them, never the mechanism.
- One rule, one home; cross-reference instead of restating.

## Clarity
- Ambiguous target, scope, or data/security/cost/irreversible action → ask and wait; batch questions.
- Plan/design request → deliver the plan only; no edits until approved.
- Ambiguous "continue"/"proceed" → confirm scope first.

## Safety
- Judge commands by effect; never reroute around a permission block — ask instead. Ask first: any `rm -r` or delete/overwrite outside the project, package installs, `sudo`/`curl | sh`/system-path writes, DB drops or unbounded `DELETE`/`UPDATE`, deploys and infra, forced git (`reset --hard`, `clean`, `push --force`, `branch -D`), commits/pushes/tags/version bumps (except a ship run whose gates pass — commit and push immediately), anything public, out-of-scope edits.
- Destructive commands are last resort and rarely required: default to non-destructive equivalents (piedit over `sed -i`/`perl -pi`, read-then-write, scratch copies under `/tmp`). In yolo mode or any subagent session, no destructive command at all — take the non-destructive path or stop and ask.
- Never without explicit approval: secrets (`.env`, `~/.ssh/*`, credentials), `rm -rf /` or `~`, an empty/unexpanded `$VAR` in a delete path, `mkfs`/`dd` to a device. A denial is final — no retries or disguises.

## Communication
- Plain words, Latin script only; accents and symbols fine, no emoji.
- Ordinary replies ≤5 lines (~320 chars); nouns and verbs, no filler. Proposals, reports, plans, blockers may run longer — stop once answered.
- Cite `path:line`; never restate file contents, output, or diffs.
- Between tool calls: one sentence, ≤20 words.

## Workflow & TDD
- Commit subject and body: no `#` character anywhere. Shape per `prompts/ship.md`: `type(scope): imperative summary`, body as multi-line `-` bullets, one per change, ≤100 chars per line, standard conventional type. Gates pass → commit and push without waiting for approval.
- Merge commits: subject names the deliverable, changelog deduped; never git's default `Merge branch …` template. Never commit pasted CI or webhook text — link the commit it announces.
- TDD always: failing test → watch it fail → minimum code → refactor.
- Bug fix → write a failing repro test first (no probe test).
- Untestable (config/docs/infra) → state why, proceed.
- Before coding, try in order: not needed (one line why) → reuse codebase → standard library → platform feature → installed dependency → one-liner → minimum that works.
- Review mode → load the `ponytail` skill.
- Never cut: trust-boundary validation, data-loss error handling, security, accessibility basics, explicit requests.
- Loop: plan → do → verify (scope per § Verification).
- When context grows past ~150K tokens, or on a compaction notice, propose compaction or a fresh session.
- Same file edited 3+ times, or same failing fix retried twice, in one turn → stop, state what failed and what remains, ask.
- Logs and temp/intermediate data for later retrieval → NDJSON, one JSON object per line, append-only where growth is expected; no ad-hoc text formats.
- Guard every `>>` append: confirm the target file ends in a newline first (`tail -c 1`); a missing final newline glues the append onto the last line.

### Subagents
- Off until `/subagents on`; until then work linearly, never spawn unasked. After `/subagents on`, task pane handover → load the `tmux-panes` skill.
- Keep the roster table and `~/.pi/agent/agents/` frontmatter in sync on every roster change.

## Verification
- At task end: tests + lint + typecheck scoped to changed files only; project lacks lint/typecheck → skip that leg and say so.
- Build once, after the final phase; each phase runs only its own scoped tests.
- Never claim something works without running it; cannot run → state why.
- Verify external contracts and configuration literals against their defining source before relying on them.
- Define each new symbol once, then reference it; never free-type the same literal twice. Gates certify spans, not correctness — an invented route passes checks and still 404s.
- Inspect the producer before relying on an output shape or its methods.
- Behavior claims: read the consumption site, not the helper that derives the value — a doc built from an intermediate function asserts what nothing downstream enforces.

## Docs
- Repo paths cited in these instructions and their docs (docs, tests, benchmarks) resolve under the agent home (`~/.pi/agent`), never the session cwd. Skill-body paths (`scripts/`, `references/`, `assets/`) resolve under the invoked skill's directory (`location` on the injected skill tag; project skills live in `.pi/skills/`).
- Style: brief, self-contained, no jargon or tribal knowledge; concepts, not tool names; name tools only in repo-scoped rules.
- The pi-native repo (agent home) is public — every file in it is world-readable; project repos where pi is initialized may be private — never assume public there. Sensitive data never enters any file (docs, comments, tests, fixtures, notes, changelog, prompts, skill bodies): secrets, tokens, and internal/self-hosted infrastructure hostnames or endpoints — reference those via env vars read at runtime (e.g. `$SENTRY_URL` from the agent-home secrets file), never written out. Concrete absolute paths — user, device, or machine specific (`/Users/<name>`, `/home/<name>`, hostnames) — never enter any file either: paths stay dynamic and OS/device-agnostic (`~`/`$HOME`-relative, repo-relative, or env-derived, per `docs/portability.md`); quote historical paths with `<home>`/`<user>` placeholders. In the public agent home, public facts may stay: org/vendor names, public repo and project slugs, public API endpoints, public usernames; keep dates. When a reference must be neutralized, use `<project-a>`, `<vendor>`, `<org>`, `<project-root>`. Fixture names describe shape, never the incident's source. A skill about a named stack names that stack.
- Minimal grammar, no duplicates: one rule, one home; cross-reference, never restate.
- A cross-reference is a resolvable path from the referring file (markdown link or repo path), never a bare code span naming a file that lives elsewhere.
- Slash-command bodies pass arguments only through `$ARGUMENTS`/`$@`/`${N}` placeholders — a body without one silently drops the invoked argument.
- Prompt frontmatter values are quoted strings (`argument-hint: "[lite|full]"`); an unquoted `[` parses as a YAML flow sequence and breaks the prompt at load.

## Harness lessons
- Record each lesson or incident (tool error, gate block, guard misfire, rule conflict, vague instruction, misbehaviour) in `~/.pi/agent/lessons/harness.ndjson` with `ts`, `source`, `session_id`, and `lesson`. The session ID must resolve to history; never commit/push the log.
- Tool-defect lessons carry path, file size, and exact payload (anchor text or hash) so a replay reproduces it.
