---
name: security-audit
description: "Triages and remediates container image and dependency CVEs from scanner output (Docker Scout, Wiz, Grype, Twistlock) against real runtime exposure: separates OS-layer packages, embedded toolchain binaries and npm transitives, picks the correct fix class per finding, proves the residual unreachable instead of asserting it, and produces ticket-ready before/after evidence. Use when a ticket names CVE ids, an image scan, a base image advisory, an SLA'd vulnerability remediation, or asks whether an affected package is reachable. NOT for application code review (→ ponytail review) or unused dependency/file cleanup (→ fallow-audit)."
---

# Container image CVE remediation

A scanner finding says a package is present in an image. It does not say the vulnerable code path can be reached. Both halves decide the ticket answer, and the second half is the one clients ask about.

## 1 — Read the finding before the score

For each finding record: package, installed version, fixed version, which layer it lives in (base OS package, npm transitive, binary embedded inside another package).

- Fix class follows the layer, not the severity (step 3).
- An asset ID that cannot be matched to a running system is its own status line ("unidentified, input requested"), never folded into a host's remediation.
- A component compiled into a runtime binary (e.g. an HTTP server, a decoder) is not a removable dependency — only a version bump or an unreachability proof applies.

## 2 — Baseline

```text
docker scout cves <image>:<tag> --only-severity critical,high                    # triage subset
docker scout cves <image>:<tag> --format json > /tmp/scan-before.ndjson          # full inventory
docker scout sbom <image>:<tag> --format json > /tmp/sbom-before.json
```

Record counts per severity plus the package names, and keep the files: the after-scan diff is the deliverable.

## 3 — Fix by class

| Finding class | Fix | Verification |
|---|---|---|
| Base OS packages | Newer base image tag | Confirm the tag exists and stays on the same distro line; rebuild and rescan |
| Transitive npm package | Lockfile override (`pnpm.overrides` / `overrides`), or a direct dep at the fixed version | Check the resolved version in the lockfile, not the manifest; a caret in the manifest proves nothing |
| Direct dependency | Upgrade | Run the project's test + typecheck commands |
| Toolchain binary embedded in a build-only package | Exclude it from the build trace (e.g. Next `outputFileTracingExcludes`) | Boot the built server and exercise a request path that imports it |
| Fix exists but breaks the app | Revert; document accepted risk | Entry needs CVE, CVSS, why the path is unreachable, and what would change that |

An exclusion or override can pass build and tests while breaking the server at boot or on first use: a framework that eagerly requires a package then fails with `MODULE_NOT_FOUND` / a config-load `TypeError`. Boot the image and hit a real route before calling it fixed. If a fix breaks the app, record the failing signature in a code comment beside the exclusion so the next reviewer does not re-attempt it.

## 4 — Verify the remediation

1. Rebuild (use `--no-cache` once to prove the result does not depend on layer cache; static generation may OOM on constrained hosts — a retry is a legitimate second attempt).
2. Boot the container, check the health route and the main page returns 200.
3. Rescan and diff:

```text
docker scout cves <image>:<tag> --format json > /tmp/scan-after.ndjson
```

4. Confirm the removed package is absent from the shipped image, not just from the manifest: SBOM dump plus an in-container listing (`ls node_modules/.pnpm | rg <pkg>`, `dpkg -l | rg <pkg>`).

## 5 — Prove the residual, do not assert it

When a CVE stays open by design, the ticket needs evidence that the vulnerable path is unreachable, per direction of data flow. For a decoder or parser:

- Inbound: send a malformed payload with the relevant `Content-*` header and show it is not decoded (status, body untouched, no crash).
- Outbound: show what the app advertises upstream (`accept-encoding`, content types) — an upstream cannot send what was never accepted.
- Responses: show which encodings the app emits and what it does when the client asks for the vulnerable format only.
- Presence: show the library is absent from the image, or present only inside a binary that no request path reaches.

Record the exact probes and their outputs in the report; "not exploitable" without a probe is the finding that comes back next quarter.

## 6 — Ticket artifacts

- Answer the ticket's required actions in its own numbering, one section per action.
- Per-resource table for every listed resource: owner, status, action, target date. Distinguish what this team can execute (vendor access) from what the client must run.
- Host-tier items: SUSE/RHEL-style vendors backport fixes, so the upstream version number stays old and the **release suffix** carries the patch — check the vendor tracker for the advisory instead of comparing upstream versions.
- Interim control when no vendor fix exists: block the format/service that reaches the vulnerable path, and say which service that is.
- Neutralize client identifiers in committed docs per the repo's portability rules (`<project-a>`, `<org>`, `<vendor>`); keep dates and CVE ids.

## Guard rails

- Do not adopt a scanner's recommended base tag or package version without checking it exists and installs.
- Do not exclude a package from the trace because nothing imports it in source: frameworks import packages dynamically. Grep the framework's own loader, then boot-test.
- A green local typecheck is not the image build's type gate — `next build` inside the image type-checks again and catches what a stale local run missed.
- Keep the accepted-risk list short and each entry reasoned; a long list means a fix was skipped, not assessed.
