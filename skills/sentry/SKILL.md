---
name: sentry
description: "Fetch, understand, and resolve issues on the self-hosted Sentry (host from SENTRY_URL, org from SENTRY_ORG, both in the secrets file) for any project the org holds. The agent-home secrets env supplies SENTRY_URL, SENTRY_AUTH_TOKEN, and SENTRY_ORG; curl/jq against /api/0 is the backbone, the toolkit sentry CLI an optional accelerator. Use for 'triage sentry', 'list sentry issues', 'resolve issue X'. Not for client-side DSN/instrumentation setup."
---

`<skill-dir>` = this skill's directory. All paths below are absolute; checkout root comes from `SENTRY_CHECKOUTS` in the secrets env (default `~`).

## Sentry triage — self-hosted Sentry only, no MCP

Constraints: self-hosted instance, hosted side unchangeable; read-mostly token — a 403 on a mutating call is the expected mode, not an error (section 1); curl + jq is the only engine. No MCP server, no SaaS-only AI tools (section 3.6).

Base URL comes from `SENTRY_URL` in the secrets file (section 1); never write the host out. Any project in the org is triageable — the task names the project slug(s), or `all`; discover slugs via the projects call in section 2.

## Project → repo mapping

Local checkouts live under `"$SENTRY_CHECKOUTS"` (secrets env; default `~`), dir name = project slug by convention.
1. `[ -d "${SENTRY_CHECKOUTS:-$HOME}/<slug>" ]` → that is the repo.
2. Else `fd -H -t d -d 3 "^<slug>$" ~` — a checkout elsewhere on disk.
3. No checkout → read-only triage for that project: analyze the event, report findings and a suggested fix, record `skipped` with reason `no local repo`; never edit or resolve without code to fix.

## 1. Environment — pi-native secrets file, never printed

Sentry creds live in `~/.pi/agent/.secrets/sentry.env` (agent home, gitignored) — never in the repos, never in repo env files.

1. Load and call in one shell process, token never echoed:
   ```sh
   set -a; . ~/.pi/agent/.secrets/sentry.env; set +a
   curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/projects/" | jq -r '.[].slug'
   ```
2. File, `SENTRY_AUTH_TOKEN`, or `SENTRY_ORG` missing → stop and tell the user: create a token at the instance's `/settings/account/api/auth-tokens/` page with scopes `org:read project:read event:read` (write scopes only if the hosted side grants them — usually it does not), then write `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, and `SENTRY_ORG` lines (plus optional `SENTRY_CHECKOUTS`, default `~`) into `~/.pi/agent/.secrets/sentry.env`.
3. A read-only token is the normal mode, not an error: mutating calls (`resolve`/`ignore`/`archive`) answer 403 — never retry them; section 4 defines the `fixed-not-resolved` path.
4. Client-exposed vars in any repo — any framework public prefix (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `VUE_APP_`, `EXPO_PUBLIC_`) and any telemetry name shape (DSN/DNS/CSP-report endpoint) — are irrelevant to triage: never open repo env files (`.env*`) during triage; this holds for every repo and project. Suspected typos in tracked examples (e.g. `NEXT_PUBLIC_SENTRY_DNS` for `..._DSN`) are flagged in the report, never silently "fixed".

Ban: `cat`/`echo`/print of the secrets file, its values, or the token; the token stays inside the shell process.

## 2. Fetch — curl recipes

| Need | Call |
| --- | --- |
| Project slugs | `GET /api/0/organizations/$SENTRY_ORG/projects/` |
| Unresolved issues | `GET /api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&project=<slug>&statsPeriod=24h&sort=freq` |
| Regressed issues (fix failed) | `GET /api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved is:regressed&project=<slug>` |
| Archived issues | `GET /api/0/organizations/$SENTRY_ORG/issues/?query=is:archived&project=<slug>&sort=last_seen` |
| Latest event | `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/events/latest/` |
| Issue's events (variants) | `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/events/` |
| Issue notes (human context) | `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/notes/` |
| Latest releases (deploys) | `GET /api/0/organizations/$SENTRY_ORG/releases/?project=<slug>` → `.[0].version`, `.[0].dateReleased` |

Lists paginate at 100 per page: follow the response `link` header cursors (`rel="next"`) for full sets.

Fetch only what a decision needs: tags when a fix/no-fix call is borderline, breadcrumbs when frames are minified or absent, request/spans only for perf issues, notes only for a regressed issue or one with `firstSeen` older than 30 days; the list row plus the latest event replace a standalone issue-detail call.

Always pipe through jq and keep only what is needed:

```sh
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&project=$PROJECT_SLUG&statsPeriod=24h&sort=freq" | jq -r '.[] | [.id, .shortId, .level, .count, .userCount, .firstSeen, .lastSeen, .title, .culprit] | @tsv'
```

Stacktrace from the latest event — entry payloads nest under `.data` (exception values at `.entries[].data.values[0]`); frames are ordered outermost-first, the error site is the last in-app frame, and `// []` keeps jq quiet when the event carries none:

```sh
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/events/latest/" | jq '.entries[] | select(.type=="exception") | .data.values[0].stacktrace.frames // [] | map(select(.inApp != false)) | .[-5:]'
```

Minified clients often leave no usable frames; the event root's `.metadata` (`type`, `value`, `function`, `filename`) still names the failure and the handler — probe it first.

## 3. Understand

1. `title` + `culprit` name the failure; top in-app frames name the files. One grouped issue can hold several message variants — before declaring an issue fixed, read the latest event's message, not the count trend. Sample 2-3 more events from the section-2 events call — the fix must cover every variant title, not just the newest.
2. Map frames to the repo: match `filename` (or basename) with `fd`/`rg` inside the repo path; skip frames under `node_modules`/`webpack`/browser internals. Frames whose `filename`/`function` match nothing in the checkout (version skew, missing sourcemaps, unsymbolicated native crashes) → report the discrepancy; never edit on unmatched evidence.
3. Read the mapped file plus its callers before concluding anything — behavior claims need the consumption site.
4. Evidence beyond the stack — same latest-event call or one extra call:
   - Breadcrumbs (user actions before the error): `jq '.entries[] | select(.type=="breadcrumbs") | .data.values[-10:]'`
   - Tag distributions — impact scope (browser, environment, url, release): `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/tags/` and `.../tags/<key>/`
   - Request + span context (URL, method, status, transaction; spans for N+1/payload perf issues): `jq '.entries[] | select(.type=="request" or .type=="spans") | .data'` — perf issues flow through the same issue/event pipeline
   - Event context: `jq '{user, release, environment, tags}'` on the latest event
   - PII rule: event data may carry credentials/tokens/PII — note presence and type, never reproduce values in output
5. Root-cause hypothesis before any edit, four lines: error summary; immediate cause (code path that threw); hypothesis (why it reached that state); strongest alternative and why rejected.
6. Optional accelerator: the toolkit CLI (`github.com/getsentry/toolkit`, docs `cli.sentry.dev`) has `sentry issue list|events|view|explain|resolve|ignore|archive|merge|reopen` using the same env vars; self-hosted login is verified (`SENTRY_URL` + OAuth, `cli.sentry.dev/self-hosted`). Not installed here; installing needs user approval. The classic `getsentry/sentry-cli` is deprecated — never install it. MCP is a dead end here: Seer and `issue plan` are SaaS-only, MCP `search_events` is broken on self-hosted until the `/events/validate/` fixes ship, and mutations hit the same read-only 403. Treat CLI as convenience only; the curl recipes are the engine.

Analysis patterns ported from `getsentry/sentry-agent-skills` `sentry-fix-issues` (Apache-2.0).

## 4. Resolve — guardrailed

Order is fixed: reproduce → fix → verify → resolve → audit.

1. TDD per repo rules: failing test reproducing the error, minimal fix, scoped tests green.
2. Completeness sweep before declaring fixed: `rg` the repo for the same failure pattern (other call sites); for a regressed issue run the API sibling query once — siblings this change fixes are recorded `covered-by-fix`, live siblings keep the issue open.
3. Resolve — one PUT attempt, never retried:
   ```sh
   curl -sS -X PUT -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"resolved"}' "$SENTRY_URL/api/0/issues/<id>/" | jq -r '.status'
   ```
   200 → re-run the section-2 issue list; the id must be gone from `is:unresolved`. 403 → action `fixed-not-resolved`: hand the issue URL `$SENTRY_URL/$SENTRY_ORG/<slug>/issues/<id>/` to the user for manual resolve, verify via scoped tests green — never re-check the list, never retry.
4. Audit — append one NDJSON line to `~/.pi/agent/logs/sentry-triage.ndjson`; `action` comes from the fixed vocabulary `fixed-and-resolved | fixed-not-resolved | covered-by-fix | no-repo-fix | reported | noise-suggested-ignore`:
   ```json
   {"ts":"<iso>","repo":"<repo>","project":"<slug>","issue_id":"<id>","short_id":"<shortId>","title":"...","culprit":"...","fix_commit":"<sha-or-null>","action":"fixed-and-resolved"}
   ```
5. Hard bans: never resolve/ignore/archive/merge without a passing fix (duplicates only on explicit user order); bulk state changes need explicit approval; no package installs or commits unless granted.

## 5. Triage loop (automation)

Per project: fetch unresolved plus regressed (section-2 recipes) → rank regressed first — a regression means a prior fix missed a variant — then `count` desc, `lastSeen` desc → for each issue, sections 3–4. Batch guard: cap at 3 issues per project per run unless told otherwise; report remaining. Noise class (probe or delivery-check scripts, container checks, issues whose frames match no checkout) → `noise-suggested-ignore` with the reason; apply `ignored` only on the user's order. Report per issue, one line: `<issue_id> <error> — <action>` plus tests, with exit codes only when a command fails. Machine-readable summary per run: NDJSON to a `/tmp` path named by the caller, one line per issue handled (`{repo, issue_id, action, result}`).

Archived blind-spot pass, after the unresolved one: archived issues never auto-reopen, so a recurring one counts events invisibly. One jq-filtered call per project — the section-2 archived recipe plus a `lastSeen` filter (within 7 days, or newer than the release meant to fix it, section-2 releases row) — and analyze only when it returns rows. Changing an archived issue's state still needs a passing fix plus the user's order.
