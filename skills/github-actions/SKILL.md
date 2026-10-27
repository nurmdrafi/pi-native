---
name: github-actions
description: Authors and hardens GitHub Actions workflow files (.github/workflows) — pins actions to commit SHAs via gh api tag resolution, scopes secrets out of workflow-level env, applies least-privilege permissions via workflow/job-level only, validates with actionlint. Use when creating, editing, or fixing CI workflows, when removing or restructuring jobs (auditing `needs:` and lost toolchain setup), when a release pipeline derives a version or tag from CHANGELOG.md, when a review or issue flags unpinned actions, secret exposure, over-broad permissions, missing build gates, or tag overwriting. NOT for general pre-push diff review (use code-reviewer) or non-GitHub CI systems.
disable-model-invocation: true
---

# GitHub Actions workflows

Workflow editing = privileged: every `uses:` runs third-party code with job's secrets + GITHUB_TOKEN scopes. Steps below = standard procedure for creating/hardening.

## 1. Validate every edit with actionlint

Schema check catches what review misses — invalid step keys, bad expressions, wrong `permissions` placement. Never eyeball-only.

```sh
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -color
```

Docker down → standalone binary (args `VERSION DIR` — `latest /tmp`, not `/tmp latest`):

```sh
curl -sfL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash -o /tmp/dl-actionlint.sh
bash /tmp/dl-actionlint.sh latest /tmp && /tmp/actionlint
```

`-shellcheck=` skips shellcheck if unavailable. Re-run after every fix until exit 0.

Exit 0 alone proves nothing — actionlint reports success on valid-but-wrong YAML parsed from wrong dir. Confirm parser live before trusting pass: append real error (step-level `permissions:` key guaranteed invalid), check exit 1 + key named. Delete temp copy after.

## 2. Pin every `uses:` to full commit SHA

Mutable tags (`@v3`) movable by anyone with write access to action repo — moved tag = remote code execution in workflow. Pin 40-char SHA + tag comment.

Resolve tag → SHA:

```sh
for spec in actions/checkout:4 docker/login-action:3; do
  repo="${spec%:*}"; major="${spec##*:}"
  tag=$(gh api "repos/$repo/tags" --paginate --jq '.[].name' \
        | rg "^v?$major(\.[0-9]+)*$" | sort -V | tail -1)
  sha=$(gh api "repos/$repo/commits/$tag" --jq '.sha')
  echo "$repo@$sha # $tag"
done
```

```yaml
uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0
```

- Pin everything incl. first-party (`actions/*`, `docker/*`) — uniform pinning costs nothing, removes third-party judgment call.
- Current major only; never jump majors in same change.
- Reusable workflows same way: `uses: org/repo/.github/workflows/x.yml@<sha> # v1`. Single moving major tag (only `v1`, no patches) still pins.

## 3. Permissions: workflow + job level only — never step level

`permissions` invalid step key (valid step keys: continue-on-error, env, id, if, name, timeout-minutes, uses, with). Step-level permissions block = known trap; schema rejects.

```yaml
permissions:
  contents: read        # workflow default: least privilege
jobs:
  build:
    outputs:
      version: ${{ steps.version.outputs.version }}
  release:
    needs: build
    permissions:
      contents: write   # only place write granted
```

Scope write grants: split write-needing steps into own job (`needs:` + job-level `permissions`), data via job outputs. Extra job ~1 billed minute; write-scoped token never reaches build/notify steps.

## 4. Secrets out of workflow-level `env`

Workflow-level `env` visible to every step — incl. third-party actions with no business seeing it. Move each secret to consuming step's `with:`:

```yaml
# BAD: whole-workflow exposure
env:
  DOCKER_PASSWORD: ${{ secrets.DOCKER_PAT }}
# GOOD: only consuming (pinned!) action sees it
- uses: docker/login-action@<sha> # vX.Y.Z
  with:
    password: ${{ secrets.DOCKER_PAT }}
```

- Consuming third-party action necessarily sees secret — hence SHA-pinning (step 2).
- Non-secrets (usernames, image names) may stay in workflow `env` — multi-step use, no exposure risk.
- Removed env var → `rg` workflow dir for stale `env.<NAME>` refs; actionlint misses undefined runtime env.

## 5–8. Restructuring + release workflows

- Job removal (dangling `needs:`, lost toolchain) + build-gate deletion → `references/restructuring.md`.
- Version/tag derivation from one parser, tag-overwrite guards, multiline data between jobs → `references/release-versioning.md`.

## Checklist

- [ ] actionlint exit 0, confirmed vs deliberately broken temp copy (pass from non-git dir / valid-but-wrong YAML = meaningless)
- [ ] YAML re-parsed after structural edits; every `needs:` target resolves
- [ ] Job removed: no dangling `needs:`; toolchain the job set up (`setup-node` etc.) restored where still needed
- [ ] Every `uses:` = 40-char SHA + `# vX.Y.Z` comment
- [ ] No `${{ secrets.* }}` in workflow-level `env`
- [ ] Workflow defaults least privilege; write grants isolated in own job
- [ ] Version/tag derivation calls repo's own parser, fails non-semver, refuses existing remote tag, guard tested both directions vs real remote state
- [ ] Removed build gate + waived acceptance criteria recorded in commit message + related issue
- [ ] Self-hosted runners only private repos / isolated-ephemeral runners — never public repos (pull_request_target pwn risk)
- [ ] `concurrency` set — stale run can't overwrite same branch/tag
- [ ] Production image build runs quality gate (lint/typecheck/test) — never skipped via Dockerfile/`.dockerignore`
- [ ] Container/deploy hardening: fail fast on missing/placeholder env, correct escaping, no swallowed errors; healthcheck; memory/heap limits; non-root PID 1; no EOL base; verified toolchain tarball; registry private unless deliberate; no secret in image config
- [ ] Logs structured + retained; error reporting wired, not stripped in prod
- [ ] Dirty `.dockerignore`, dep mismatches, commented-out gates = findings, not noise
