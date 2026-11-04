---
name: sdk-development
description: "Develop, test, publish installable packages — Go modules, npm SDKs/component libraries, plugins, CLIs: OpenAPI codegen, exports map, test pyramid, pack smoke, publish gate, semver upgrades, docs-as-contract. Use for SDK/library/publish/version-bump. NOT app e2e (→ playwright-tester), map work (→ map-integration), CI itself."
disable-model-invocation: true
---

# Package/SDK Development

Building/shipping installable packages: generated API SDKs, hand-written libraries, plugins, CLIs — Go module, npm package, plugin bundle. Core rule for libraries consumed by others: **docs = contract** — every README feature, prop, code example must run against built artifact.

## Archetypes (detect first)

- Generated SDK — OpenAPI spec via codegen (oapi-codegen / openapi-ts). Two layers, separate:
  - `gen/` / `*.gen.ts` — auto-generated, **never hand-edit**; change spec, regenerate, re-apply scripted post-fixes (e.g. `float32`→`float64`, casing-collision field drops).
  - `client/` / `src/lib/` — hand-written: simplified request types, client-side validation *before any HTTP call*, API-key injection, timeouts, SDK error types, defaults.
  - Sibling SDK in another language → defaults/validation/error semantics must match exactly; parity noted in comments. Deliberate divergence documented, never silent.
  - API drift lives in "Known API drift — intentional, do not fix" table in CONTRIBUTING.md; absorbed in hand-written layer (tolerant `UnmarshalJSON`/zod for number-or-string fields, documented auth ambiguities like `api_key` vs `key`).
- Hand-written library (component lib, plugin, CLI) — no codegen layer; tests + docs carry safety net.

## Package surface (npm)

- Define `exports` in package.json (`.` import/require conditions + subpaths like `./styles`).
- List `files`.
- Peer-deps for host frameworks (`react`, `react-dom`).
- Verify surface mechanically (pack smoke below), never eyeball config — exports map = what consumers resolve; typos invisible until install.

### Bundle externals

Externals from build config / emitted output, never top-of-file import scan — a scan once missed `maplibre-gl` (mid-file import); offline smoke sandbox failed on resolution. Grep built `dist/` entry for `require(`/`from` specifiers, or read bundler config.

## Testing

- SDKs: real API, real responses. No mocks, no smoke-only tests. Required env (e.g. `API_KEY`) read properly — tests fail loudly when missing, never skip silently.
- Native test runners — `node:test`, `go test`. No heavy test-framework dep.
- Table-driven per endpoint/method: happy path, each validation error, non-2xx + timeout mapped to SDK error types distinguishable via `errors.As`/typed catches.
- Coverage ≥80%, excluding auto-generated files — coverage *and* lint configs both exclude `gen/` (`.golangci.yml` paths, vitest coverage exclude). npm: `vitest run --coverage` wired into `npm test` itself — every run reports coverage, not just CI; Go: `make cover` in CI, `go tool cover -func=coverage.out` = source of truth.
- Completeness rule: every public API/method ships ≥1 test — "do tests cover all APIs we provide?" = pre-release question; answer before tagging.
- Test layout: per-module test files mirroring source (`client_test.go`, `geocoding_test.go`, `routing_test.go`, `search_test.go`, `integration_test.go`, …) + `helpers_test.go` shared fixtures; unit tests run without env vars where possible, integration tests behind real env keys.
- Plugins/CLIs: smoke-test real local install (`claude --plugin-dir <dir>`, packed tarball, or `go run` from consumer repo); reports under `docs/smoke-tests/` with findings + token cost — runs stay comparable across versions.
- Consumer testing (npm): tarball method, never `npm link` (symlinks cause phantom-symbol bugs — two React/peer copies):
  ```bash
  npm pack                      # builds <pkg>-<version>.tgz
  cd ../consumer-app && npm install ../<pkg>/<pkg>-<version>.tgz
  ```
  Alternative: `yalc publish` + `yalc add <pkg>`. Exercise core feature in real app.
- Regression rule: previous published version = behavior contract. Something breaks after bump (asset, rendering, export) → diff vs how previous version did it, match — never invent new behavior mid-version.

Pyramid layers, browser-mode pitfalls, e2e infra, pack smoke procedure: [references/testing.md](references/testing.md).

## Pre-publish gate (in order)

```
typecheck → lint → unit → browser-mode (npm) → e2e vs dist → README example validation
→ publint → pack smoke / consumer check → dependency hygiene → CHANGELOG → user publishes
```

1. Build, lint, typecheck, full test suite green. npm enforces via `prepublishOnly` (`check-types && build && test`); failing test blocks release — fix, don't bypass. Gated/deferred items → tracked issue, never silent skip.
2. README validation: extract every fenced example, compile against real package (`go vet` scratch program / `tsc --noEmit`). Example not building = bug. Documented examples = executable specs — test each verbatim as e2e case; docs + library move together. No local toolchain → Docker (`docker run --rm -v "$PWD":/app -w /app golang:… go vet …`) — never skip.
3. `npx publint` (npm) — fix exports/types/package.json warnings.
4. Consumer check: packed tarball installed in real app, core feature exercised. E2e host app imports every published entry point (main, `./styles`, subpaths) — not just main; a branding element once tested "missing" because host never imported styles export.
5. Dependency hygiene if touched: exact pins (no `^`), committed `.npmrc`, `npm/pnpm audit --audit-level high`, non-breaking upgrades only. Sweep dead `package.json` scripts + stray files — every script runnable + referenced; unreferenced scratch files deleted, not parked.
6. CHANGELOG.md complete for this version; missing shipped versions backfilled.
7. **User reviews, commits/publishes manually.** Agent never commits/pushes/publishes unprompted — suggests commit message, waits. User may test live first.
8. `npm publish --access public` (or CI release — details in [references/ci-and-upgrades.md](references/ci-and-upgrades.md).)

CI/CD pipelines + dependency major upgrades (engine-major contract breakage protocol): [references/ci-and-upgrades.md](references/ci-and-upgrades.md).

## Documentation (fixed set)

| File | Content |
|---|---|
| README.md | User-facing: description, install, quick start, per-feature examples (all validated), badges — npm/pkg.go.dev interactive labels, not bundlephobia. Feature matrix = e2e case registry's source of truth; every documented feature has a case. Never expose internal patterns as README examples. |
| CONTRIBUTING.md | Most important dev doc: quick start/setup, local package testing (tarball method), codegen workflow (if any), CI pipeline, npm hooks (`prepublishOnly`), test strategy with exact gate commands (typecheck → unit → browser → e2e → pack smoke), release process, drift table. |
| DEVELOPMENT.md | Optional deeper dive: architecture, internals, design decisions. Create when CONTRIBUTING crowded; no duplication between them. |
| LICENSE | MIT file at repo root, referenced from README badge. |
| CHANGELOG.md | Keep-a-Changelog `## [x.y.z] - YYYY-MM-DD`. Entries land **with** the change (one coherent entry/version), user-facing outcomes only — no process minutiae, internal jargon, test counts not test-file lists. Single version source: package version read from here, never hand-bumped independently. |
| AGENTS.md / CLAUDE.md | Generic agent instructions only — nothing task-specific, **no git permissions or instructions** (agent doesn't commit; suggests messages only). |

## Versioning

- Semver: breaking API change → major, new endpoint/feature → minor, fix → patch.
- Shipped versions missing from changelog → backfill before next release.
- Post-regression: patch release restoring parity with previous version's behavior, changelog entry covering regression + fix.

## R&D + comparison workflow

- New feature/R&D on library surface: document first (README entry), implement against test pyramid — unit mock → browser spec → e2e case → pack smoke — every feature lands with executable spec. Spike R&D in branch; merge gate = full pyramid, never demo.
- Comparing packages: read comparison target's docs AND shipped dist — compare API surface, exports, peer-dep handling, event-payload contracts. Docs/source-surface-only comparison once missed mid-file externals + behavior deltas. Adopting pattern → note delta in README/CHANGELOG.
