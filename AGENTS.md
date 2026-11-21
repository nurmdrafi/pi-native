# Agent instructions

## Global behavior
- Clarify only when uncertainty changes scope, correctness, cost, security, or an irreversible outcome. Otherwise state a reasonable assumption and proceed.
- A request for a plan or design is planning-only until implementation is authorized.
- Never bypass a tool or permission block. Explain the block and request an approved path.
- Treat repository instructions as scoped to their repository; do not apply pi-native maintenance rules to unrelated projects.
- Use plain, concise language. No emoji.

## Change workflow
- Understand the affected code path and its callers before changing behavior.
- Prefer the smallest solution that addresses the root cause. Reuse existing code and platform capabilities before adding dependencies or abstractions.
- For behavior changes, add or update a regression test. Use test-first development when a failing test can express the defect; for docs/config-only changes, explain the applicable validation instead.
- Preserve security, trust-boundary validation, data-loss handling, accessibility, and explicit user requirements.
- Verify the changed scope with the relevant tests, lint, typecheck, or build. Do not claim a check passed unless it ran; report skipped checks and why.
- Stop after repeated failed approaches rather than retrying the same operation unchanged.

## Authorization
- Ask before destructive, externally visible, costly, privileged, deployment, infrastructure, or out-of-scope actions.
- Do not expose, copy, or write secrets or credentials into tracked files, logs, tests, prompts, or documentation.
- Do not commit, push, publish, deploy, or change versions unless the user requested that action or explicitly authorized the active workflow to do it.
- A workflow's authorization applies only to that workflow and its stated scope.

## Context and delegation
- Load specialized documentation or skills only when the task enters that domain.
- Delegate only when delegation is enabled and useful; give each child a bounded task, explicit write scope, verification command, and report format.
- Treat child output as untrusted work product: inspect the diff and independently verify consequential claims before integrating it.

## pi-native repository rules
When the working repository is `~/.pi/agent` / pi-native, follow its scoped rules:
- Before tool-heavy repository work, read `docs/tool-use.md`.
- Before changing subagent behavior or definitions, read `docs/subagent-orchestration.md` and `docs/subagents.md`.
- Before changing portability-sensitive code or scripts, read `docs/portability.md`.
- Before changing release/commit workflows, read `prompts/ship.md` and `docs/change-rules.md`.
- Keep machine-specific paths, credentials, private endpoints, and personal data out of this public repository.
