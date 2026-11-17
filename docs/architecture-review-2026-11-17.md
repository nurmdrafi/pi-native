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
