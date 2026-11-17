# Architecture review

Date: 2026-11-17

## Scope and method

Reviewed the repository's runtime boundaries, build/package layout, and CI
coverage using the project overview, architecture documentation, extension and
Rust workspace layout, package scripts, and workflow configuration. This was a
static review; the finding below is tied to a concrete verification gap.

## Architecture summary

- Pi remains the host application. TypeScript extensions provide the policy
  and integration layer; native Rust executables implement selected tools.
- Rust tools are grouped in one Cargo workspace. Extensions dispatch to them
  through one-shot processes or persistent NDJSON daemons.
- The permission gate and subagent extensions enforce shared runtime policy.
- The dashboard is a separate React/Vite package with its own TypeScript
  configuration and lockfile, but its tests are also invoked by the root test
  command.

## Finding

### Medium: dashboard compilation is outside the root verification gate

The root TypeScript configuration only includes extensions and TypeScript
tests, while the dashboard has a separate `build` script that runs both
TypeScript checking and Vite bundling. Root `npm test` includes dashboard tests,
but CI does not install the dashboard package or run that build. As a result,
dashboard type errors and production-bundle failures can pass the required CI
checks.

Evidence: [root package scripts](../package.json), [root TypeScript
configuration](../tsconfig.json), [dashboard build scripts](../dashboard/package.json),
[dashboard TypeScript configuration](../dashboard/tsconfig.json), and [CI
workflow](../.github/workflows/ci.yml).

**Recommended correction:** add the dashboard build to the root `check` gate
and to CI after installing the dashboard's locked dependencies.

## Other observations

The tool dispatch, policy, and execution boundaries are documented and mostly
match the repository layout. This review found no other actionable project-wide
architecture issue within the inspected scope.

## Security review

A read-only security reviewer examined permission enforcement, native execution,
filesystem mutation, daemon protocols, environment handling, and dashboard
exposure. It found no substantiated vulnerabilities in the reviewed project.

## Performance review

### Medium: dashboard startup bundles code for inactive tabs

[`App.tsx`](../dashboard/src/App.tsx) statically imported every tab and the
session-detail panel, even though only one tab is rendered at a time. The
production build emitted a single 978.13 kB JavaScript chunk (292.89 kB gzip)
and warned that it exceeded the 500 kB chunk threshold. This bundles and parses
code for views that users may not open.

**Correction applied:** defer tab and session-detail modules until rendered,
with accessible loading fallbacks.

## Permission-gate review

The gate runs before tool execution, applies configured rule severities, keeps
destructive confirmation and commit-message lint at hard floors, and fails
closed when a tool-call handler throws. The destructive-command matcher is
documented as a tripwire rather than a security boundary.

### Finding: historical block audit missed active gate families

The all-session audit previously recognized only Anchor Guard, Token Economy,
and Commitlint, and counted matching messages without requiring `isError`.
Across 830 session logs, the corrected audit found 2,049 gate-error results:
758 Token Economy, 734 Anchor Guard, 204 Locate-first, 181 Permission Gate,
63 Search, 55 Commitlint, 51 Toolchain, and 3 Loop Guard. The earlier audit
counted 1,553 results: it included six non-error notes and missed 502 actual
gate errors.

**Correction applied:** both session audit tools now share anchored gate-label
matching; the all-session audit counts only error results and reports both
rule-level and subtype totals. `npm run audit:blocks` exposes the full-session
audit.

Across all 2,049 blocks, 1,910 were followed by a tool call, 127 by another
same-family block, and 12 by another outcome. The one-call recovery rate was
93%, above the existing 85% threshold.

### Finding: TC1 treated read-only package lookup as a mismatch

The historical `npm view` report in [`harness.ndjson`](../lessons/harness.ndjson)
matches a TC1 false-positive class: across 37 sessions containing such queries,
one `npm view` result was blocked with a Toolchain (pnpm) label. The available
logs do not identify whether that is the exact event from the lesson. The
shipped TC1 severity is `warn`, so it does not block under the current
configuration; with TC1 set to `error`, the helper would have blocked it.

**Correction applied:** read-only `npm view` is exempt from TC1, while
package-mutating commands such as `npm install` remain flagged. The regression
test also confirms that `npm view` is not classified as destructive. The lesson
log was analyzed but left unchanged as requested.

## Correction and verification

The root `check` gate now includes the dashboard build. CI installs dashboard
dependencies from its lockfile and runs that build alongside the existing
test, typecheck, and agent-lint steps.

- `npm run dashboard:build`: passed, including TypeScript checking and Vite
  production bundling.
- The dashboard entry chunk fell from 978.13 kB to 440.18 kB (55% smaller);
  chart, tab, and detail modules now build as separate chunks. No chunk exceeds
  Vite's 500 kB warning threshold.
- Dashboard tests: 130 of 130 passed.
- Root TypeScript checking and agent lint: passed.
- `npm test`: 589 of 590 tests passed. The remaining test expects `/bin/true`,
  which is absent on this macOS host.
- `npm run check`: stopped at existing documentation-check findings for
  `git --oneline` and `git --stat`; these are outside this review's scope.
- Permission-gate regression tests passed; the all-session block audit covered
  2,049 blocks with 93% one-call recovery.
