---
name: sentry
description: "Fetch, understand, and resolve issues on the self-hosted Sentry (host from SENTRY_URL, org from SENTRY_ORG, both in the secrets file) for any project the org holds. The agent-home secrets env supplies SENTRY_URL, SENTRY_AUTH_TOKEN, and SENTRY_ORG; curl/jq against /api/0 is the backbone, the toolkit sentry CLI an optional accelerator. Use for 'triage sentry', 'list sentry issues', 'resolve issue X'. Not for client-side DSN/instrumentation setup."
---

`<skill-dir>` = this skill's directory. All paths below are absolute; checkout root comes from `SENTRY_CHECKOUTS` in the secrets env (default `~`).

# Sentry triage — self-hosted, org from `"$SENTRY_ORG"`

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
2. File, `SENTRY_AUTH_TOKEN`, or `SENTRY_ORG` missing → stop and tell the user: create a token at the instance's `/settings/account/api/auth-tokens/` page with scopes `org:read project:read project:write event:read event:write`, then write `SENTRY_URL`, `SENTRY_AUTH_TOKEN`, and `SENTRY_ORG` lines (plus optional `SENTRY_CHECKOUTS`, default `~`) into `~/.pi/agent/.secrets/sentry.env`.
3. Client-exposed vars in any repo — any framework public prefix (`NEXT_PUBLIC_`, `VITE_`, `REACT_APP_`, `VUE_APP_`, `EXPO_PUBLIC_`) and any telemetry name shape (DSN/DNS/CSP-report endpoint) — are irrelevant to triage: never open repo env files (`.env*`) during triage; this holds for every repo and project. Suspected typos in tracked examples (e.g. `NEXT_PUBLIC_SENTRY_DNS` for `..._DSN`) are flagged in the report, never silently "fixed".

Ban: `cat`/`echo`/print of the secrets file, its values, or the token; the token stays inside the shell process.

## 2. Fetch — curl recipes

| Need | Call |
| --- | --- |
| Project slugs | `GET /api/0/organizations/$SENTRY_ORG/projects/` |
| Unresolved issues | `GET /api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&project=<slug>&statsPeriod=24h&sort=freq` |
| Issue detail | `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/` |
| Latest event | `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/events/latest/` |

Always pipe through jq and keep only what is needed:

```sh
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/?query=is:unresolved&project=$PROJECT_SLUG&statsPeriod=24h&sort=freq" | jq -r '.[] | [.id, .shortId, .level, .count, .userCount, .firstSeen, .lastSeen, .title, .culprit] | @tsv'
```

Stacktrace from the latest event — frames are ordered outermost-first; the error site is the last in-app frame:

```sh
curl -sS -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" "$SENTRY_URL/api/0/organizations/$SENTRY_ORG/issues/$ISSUE_ID/events/latest/" | jq '.entries[] | select(.type=="exception") | .values[0].stacktrace.frames | map(select(.inApp != false)) | .[-5:]'
```

## 3. Understand

1. `title` + `culprit` name the failure; top in-app frames name the files.
2. Map frames to the repo: match `filename` (or basename) with `fd`/`rg` inside the repo path; skip frames under `node_modules`/`webpack`/browser internals.
3. Read the mapped file plus its callers before concluding anything — behavior claims need the consumption site.
4. Evidence beyond the stack — same latest-event call or one extra call:
   - Breadcrumbs (user actions before the error): `jq '.entries[] | select(.type=="breadcrumbs") | .values[-10:]'`
   - Tag distributions — impact scope (browser, environment, url, release): `GET /api/0/organizations/$SENTRY_ORG/issues/<id>/tags/` and `.../tags/<key>/`
   - Event context: `jq '{user, release, environment, tags}'` on the latest event
   - PII rule: event data may carry credentials/tokens/PII — note presence and type, never reproduce values in output
5. Root-cause hypothesis before any edit, four lines: error summary; immediate cause (code path that threw); hypothesis (why it reached that state); strongest alternative and why rejected.
6. Optional accelerator: the new toolkit CLI (`github.com/getsentry/toolkit`, docs `cli.sentry.dev`) has `sentry issue list|events|view|explain|resolve` using the same env vars, and `sentry mcp` can serve a local stdio MCP for self-hosted (`SENTRY_HOST`). Not installed here; installing needs user approval. `sentry issue plan` is Seer/SaaS-only — never on self-hosted. Its MCP `search_events` is broken on self-hosted until the `/events/validate/` fixes ship — treat CLI/MCP as convenience only; the curl recipes are the engine.

Analysis patterns ported from `getsentry/sentry-agent-skills` `sentry-fix-issues` (Apache-2.0).

## 4. Resolve — guardrailed

Order is fixed: reproduce → fix → verify → resolve → audit.

1. TDD per repo rules: failing test reproducing the error, minimal fix, scoped tests green.
2. Resolve:
   ```sh
   curl -sS -X PUT -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" -H "Content-Type: application/json" \
     -d '{"status":"resolved"}' "$SENTRY_URL/api/0/issues/<id>/" | jq -r '.status'
   ```
3. Verify: re-run the section-2 issue list; the id must be gone from `is:unresolved`.
4. Audit — append one NDJSON line to `~/.pi/agent/logs/sentry-triage.ndjson`:
   ```json
   {"ts":"<iso>","repo":"<repo>","project":"<slug>","issue_id":"<id>","short_id":"<shortId>","title":"...","culprit":"...","fix_commit":"<sha-or-null>","action":"resolved"}
   ```
5. Hard bans: never resolve/ignore/archive/merge without a passing fix (duplicates only on explicit user order); bulk state changes need explicit approval; no package installs or commits unless granted.

## 5. Triage loop (automation)

Per project: fetch unresolved → rank by `count` desc, `lastSeen` desc → for each issue, sections 3–4. Batch guard: cap at 3 issues per project per run unless told otherwise; report remaining. Per fixed issue, report shape: `fixed <issue_id> <error>` — frequency (events + users), first/last seen, root cause one line, fix files, verification commands + exit codes. Machine-readable summary per run: NDJSON to a `/tmp` path named by the caller, one line per issue handled (`{repo, issue_id, action, result}`).
