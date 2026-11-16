---
name: test-suite-hygiene
description: Cleans Vitest suites running in jsdom — replaces runtime gaps (getComputedStyle with a pseudo-element, location navigation, ResizeObserver, matchMedia) with stubs the tests assert on, and cuts the cost of repeated full-suite runs with eslint and tsc caches. Use when a test run prints errors while every test passes ("Not implemented", jsdom navigation), when stubbing a browser global silently does nothing because the member is read-only, when hook or coverage runs get slow, or when reported noise must go away without hiding real failures. NOT for authoring new test cases (follow the repo's conventions) or end-to-end browser tests (use playwright-tester).
---

# Test suite hygiene

Two jobs: remove what the test host cannot do, and stop paying full price for runs that repeat themselves. Both change test infrastructure, not production code.

## 1. Decide what the noise is

Read the summary line before touching anything. `N passed` with errors above it means the host reported a gap, not a failure — those errors never failed the run and will not fail CI either.

- Message from the host's not-implemented shim, stack inside host internals (`node_modules/jsdom/...not-implemented.js`) → host gap. Fix by stubbing.
- Message from project code, or the suite exits non-zero → real failure. Go debug it.

Never silence by filtering the console: a global `console.error` filter hides the next genuine error too. Fix the gap, so the channel stays honest.

## 2. Close the gap at the boundary the tests cross

| Reported gap | Cause | Stub |
|---|---|---|
| `Not implemented: window.getComputedStyle(elt, pseudoElt)` | host cannot compute pseudo-element styles; UI kits probe scrollbar width via `::-webkit-scrollbar` | wrap once in the setup file: drop the pseudo argument, delegate to the original. The returned declaration is the element's own, which is what the host produced after the warning anyway |
| `Not implemented: navigation (except hash changes)` | any assignment to `location` or `location.replace` | `Object.defineProperty(window, 'location', { value: { pathname, replace: vi.fn() }, writable: true, configurable: true })`. `vi.spyOn(window.Location.prototype, 'replace')` fails: the spec descriptor is `configurable: false` |
| `ResizeObserver is not defined` | absent in the host | no-op class on `window` in the setup file (`observe`/`unobserve`/`disconnect`) |
| `IntersectionObserver is not defined` | absent | `vi.fn()` returning the same three methods |
| `window.matchMedia is not a function` | absent | `vi.fn()` returning `matches: false` plus the listener methods |

Reuse the stub shape the repo already has — a neighbouring test usually installed it first; copying it keeps two suites from diverging.

## 3. Assert on the stub

A stub that is never asserted converts a real behaviour into a silent no-op. Assert the value the code passed (a redirect target, a URL, an argument list), and add the negative case: the call that must not happen. That is the difference between removing noise and removing coverage.

## 4. Recover the cost of repeated runs

A hook or watch target that re-runs everything per commit pays full price each time:

- **eslint cache**: run the linter with `--cache --cache-location node_modules/.cache/eslint/`. The location keeps the artifact out of git by construction, so no ignore rule can be forgotten. Gains are modest for a handful of files — typed linting builds the TypeScript program before it lints anything, and that setup dominates.
- **tsc incremental for the test tsconfig**: `"incremental": true`. Each project writes its own build info file, named after its config, so the app and test projects do not collide; `*.tsbuildinfo` is already ignored in most repos. Measured on a mid-size suite: 5.6s cold → 2.6s warm.
- **test runner and coverage**: no result cache exists — coverage instruments and executes every time. Do not promise a speedup there; reduce the number of full runs instead (group commits, run the scoped file while iterating).

## Checklist

- [ ] Suite exit code and summary read before any edit; the reported error classified as host gap or real failure
- [ ] Gap closed in the setup file (shared) rather than per test file, when more than one suite hits it
- [ ] Stub asserted, including the case that must not fire
- [ ] No global console filter added
- [ ] Cache artifacts land under `node_modules/` or a matching ignore rule exists
- [ ] Cost claim measured (cold vs warm), not assumed
