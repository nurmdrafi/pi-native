# Dependabot version updates (`.github/dependabot.yml`)

GitHub schedules these runs itself: the file has no `on:` block and needs no workflow. On a private repository each scheduled run bills Actions minutes, so the count of ecosystems is the run cost.

## Where the file is read and where PRs open

- Read from the repository **default branch** only — a copy on a feature branch does nothing until it lands there.
- PRs open against the default branch unless `target-branch: <name>` says otherwise; that branch must exist on the remote, or no PRs open at all.

## One entry per manifest the build consumes

| Value | Covers | Notes |
|---|---|---|
| `bun` | `package.json` + `bun.lock` | Supported ecosystem (bun >= v1.1.39). Keeps the lockfile in step with a frozen-lockfile image build. |
| `docker` | `Dockerfile` | `FROM ${VAR}` resolves only when the `ARG` default sits in the same file. |
| `github-actions` | `uses:` refs | Keeps SHA pins and their version comments in step. |

Confirm a value against the supported-ecosystems table in GitHub docs before writing it: an unsupported value is accepted by the parser and then does nothing — no jobs, no PRs, no error. Leave out ecosystems whose manifest is absent, and leave out `docker-compose` when every compose image is built locally from the repo's own Dockerfile (nothing to bump).

## Volume controls

- `open-pull-requests-limit` — concurrent cap (default 5). `0` disables version updates while leaving security updates on.
- `groups` + `applies-to: 'version-updates'` + `update-types` — one PR per release train. Give majors their own group so a breaking bump cannot ride a minor train.
- `cooldown` — `default-days`, then `semver-patch-days` / `semver-minor-days` / `semver-major-days`. A release must age before it is proposed, which filters yanked and re-cut versions. Security updates ignore cooldown.
- `rebase-strategy: 'disabled'` — stops automatic rebases reopening the request.
- `schedule.interval` — weekly is the lowest frequency; lowering the PR count comes from groups and caps, not from the schedule.

Cost model when no workflow triggers on `pull_request`: open PRs cost nothing, each **merged** bump triggers whatever the base branch runs (an image build, typically). Grouping and caps therefore decide the spend; the schedule barely matters.

## Validation

No schema validator ships offline. Parse the file and assert its shape in the repo's own test suite: `version: 2`, exactly one entry per shipped ecosystem, weekly interval and day, the PR base branch, and that caps, cooldown and rebase strategy survive. A regex-shape test like the workflow config tests is enough and fails loudly when someone trims an entry.
