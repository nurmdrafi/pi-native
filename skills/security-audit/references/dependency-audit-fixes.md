# Dependency audit remediation mechanics

For vulnerability audits in a JS repo under any package manager. Fix classes in the SKILL.md table still apply; this file covers manager behavior that decides which class is executable. Command flags drift between versions — confirm against the installed manager's help before relying on a flag.

## 0 — Manager surface

| | audit | report JSON | auto-fix | override field | dependency trace |
|---|---|---|---|---|---|
| npm | `npm audit` | `--json` | `npm audit fix` (`--force` for breaking) | `overrides` | `npm ls <pkg>` |
| pnpm | `pnpm audit` | `--json` | `pnpm audit --fix` | `pnpm.overrides` (workspace root only) | `pnpm why <pkg>` |
| Yarn Berry | `yarn npm audit` | `--json` | none — set resolutions, reinstall | `resolutions` (selective `pkg@range` keys) | `yarn why <pkg>` |
| Yarn 1 | `yarn audit` | `--json` | not implemented — set resolutions, reinstall | `resolutions` | `yarn why <pkg>` |
| bun | `bun pm scan` | — | none — set overrides, reinstall | `overrides` | `bun pm why <pkg>` |

## 1 — Read the finding, not the suggested fix

- The audit report gives per-package vulnerable ranges and via chains. `fixAvailable` is advisory, not verified: it can suggest a version still inside the advisory range, or a downgrade that breaks app code built on the current version. Check the suggestion against the advisory range and the app's usage of the package before applying.
- `via` entries that are package names (not advisory objects) mean the vulnerability is inherited — fix the root, not the listed leaf.
- A semver-major fix separates a mechanical bump from a migration needing code changes.

## 2 — Choosing the fix

- Direct dependency, fix within semver range → install the pinned version (`save-exact` configs keep pins exact).
- Transitive-only → the manager's override field. Prefer an override over a suggested downgrade when the app depends on the current major's API; verify with a functional smoke test — overrides apply tree-wide, to every consumer of that package.
- Vulnerable subpackages arrive via a meta-package while the app imports only some of its modules → drop the meta, install the used packages plus their peer deps directly (deck.gl: meta → `@deck.gl/core` + `@deck.gl/layers` + `@deck.gl/mapbox`). Clears the unused vulnerable chain without any upgrade; imports usually unchanged.
- Major upgrade with API changes → migration task, separate from the audit run.
- Yarn resolutions are global unless keyed `pkg@range`; a blunt key forces every copy, which can pin a nested tooling copy the app never runs — key narrowly.

## 3 — Manager traps

- npm `min-release-age` counts DAYS. A seconds value (259200 for "3 days") becomes a ~700-year cutoff and every install fails `ETARGET` citing a medieval date. Three days = `3`. The same quarantine blocks freshly published patched releases: when the fixed version is younger than the window, take the newest patched release older than the window, or wait it out.
- Peer policies differ: npm `legacy-peer-deps=true` disables peer auto-install (install peers as direct deps or builds fail with module-not-found from inside the package); pnpm auto-installs peers by default. Check the active manager's policy before blaming the package.
- Override churn can leave gutted top-level package dirs (directory exists, files missing): builds fail `ENOENT` on the package entry. Remove the husk dirs and reinstall; then verify resolution from the consuming package's path (`require.resolve(pkg, { paths: [consumer] })`) — a manager's dependency listing can show a tree real resolution does not follow, e.g. copies nested under one consumer, invisible to sibling packages. Works through pnpm's symlink layout too.
- Lockstep ecosystems release companion packages per minor together (deck.gl ↔ luma.gl). Floating `^` ranges can mix minors and break runtime shader/module assembly with opaque asserts. Pin the companion line with overrides or exact direct deps.
- Install-script allowlists (npm >= 11) pin by name and version; a bump re-flags the package until re-approved. Approve by name and prune pins for packages no longer installed.

## 4 — Type-graph fallout

Manager-neutral: it follows the resolved versions, whichever manager produced them.

- A new transitive can fail typecheck even with `skipLibCheck`: parse errors in declaration files still surface. Fix at the source — override the transitive to a version whose declarations the toolchain parses (zod v4 needs TypeScript 5+; older toolchains take a zod-free or zod-3-compatible release) — or upgrade the toolchain.
- Major upgrades surface as config-load `TypeError`s: Sentry for Next.js v9+ exports `withSentryConfig` from `@sentry/nextjs/config` (not the package root); server and edge configs load only through `instrumentation` `register()`, and v9+ expects an `onRequestError` hook (`Sentry.captureRequestError`) exported there. The client config file still auto-loads.

## 5 — Verification ladder, cheapest first

1. Re-run the audit — zero in the severities in scope.
2. Resolution and functional smoke: `require.resolve` from the consumer's path, plus the manager's `why` listing; load and exercise the package (render an image, roundtrip a document).
3. Typecheck — catches declaration drift from new transitives.
4. Unit tests scoped to the touched areas.
5. Dev boot plus a request to a route importing the changed package — compile and config-load failures only surface there. Clear the stale build cache (`.next`) after dependency layout churned.
