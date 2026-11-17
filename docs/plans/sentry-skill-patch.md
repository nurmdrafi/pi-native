# Sentry skill patch — change record

- Date: 2026-11-17 · Status: implemented
- Targets: `skills/sentry/SKILL.md`, `agents/sentry-triage.md`, roster row in `docs/subagent-orchestration.md`
- Scope: self-hosted instance, hosted side unchangeable, no MCP, no secrets-file change; docs-only, so no tests or lint apply.

## Landed

- SKILL.md head: constraints note — self-hosted only, read-mostly token, curl + jq the only engine, no MCP or SaaS-only AI tools.
- §1: read-only token is the normal mode; mutating 403s are never retried.
- §2: rows for issue events/variants, regressed, notes, releases; 100/page `link` cursor note; conditional fetch policy replacing the standalone issue-detail call.
- §3: variant sampling (3.1), unmatched-frame guard (3.2), request/span evidence (3.4), toolkit currency — CLI verbs, deprecated classic CLI, MCP dead ends (3.6).
- §4: completeness sweep, one-attempt resolve, `fixed-not-resolved` + manual-resolve URL, fixed action vocabulary.
- §5: regressed-first ranking, noise class, archived blind-spot pass with a `lastSeen` filter.
- `agents/sentry-triage.md` plus roster row: read-only mode, one-attempt resolve, new vocabulary.

## Verified

- Full SKILL.md re-read: numbering coherent, placeholders only, no duplicated rules; one read-only projects call confirmed the recipes resolve.

## Out of scope

Secrets file, MCP/CLI install, hosted-side changes, other skills.
