---
name: playwright-tester
description: "Playwright test automation — e2e specs, stress/update-flow runs, bug-hunt iterations, slow-startup diagnosis. Attaches to running Chrome (CDP :9222) for logged-in sessions; falls back to isolated runs. Use for any Playwright/e2e/browser-automation task, including 'untested critical paths' / 'no e2e coverage' gaps (auth flow, 401 ladder, wallet/settlement). NOT one-off DOM poking (→ browser-tools), component specs (Vitest), CI."
disable-model-invocation: true
---

# Playwright Tester (CDP attach, session reuse)

## Invocation rules

- Load this skill before writing/changing any Playwright test or config code.
- No browser at all when shell, static-code, or unit tests answer the question.
- One-off live inspection/screenshots/DOM poking → `browser-tools`. Reproducible automated tests → here. Complements, never duplicates.

## Modes — pick before scaffolding

- CDP attach (default): live dev server + developer's Chrome on `:9222`, real logged-in session, `workers: 1`. Stress runs, update-flow crosschecks, live debugging.
- CI / isolated fallback: fresh launch, auth via `storageState` — record once (`context.storageState({ path: 'e2e/.auth/state.json' })`), then `use: { storageState: … }`. Parallel workers fine — `workers: 1` = shared-session constraint only. `webServer` serves production build, `reuseExistingServer: !process.env.CI`. CDP-attach fixture never ships to CI; guard with `process.env.CI` so one config serves both.
- Component-test boundary: component-level behavior vs repo source (rendering, props, events) → Vitest browser mode; whole-app/user flows + anything vs built artifact → here.

## Pre-flight (mandatory, ~30 s)

0. Detect, never assume URL: before writing target URL, find the running server (recon, not memory).
1. `npx playwright --version` resolves in target repo; chromium installed (`npx playwright install chromium` — idempotent; long installs detached, never inside test command).
2. Env/credentials present; commit `.env.example`, gitignore `.env` precisely — broad `.env*` once swallowed the example file.
3. Ports — one server owner: kill zombie dev servers from aborted tool calls (`pkill -f "[v]ite e2e"` — bracket so pkill never self-matches). Never mix manual server with runner's `webServer`: with `reuseExistingServer` local, runner once silently reused a zombie → whole suite failed ~250 ms, misread two rounds as "server never started". Port answers → `curl` health; diagnosing → verify run output contains `[WebServer]` startup lines.
4. Recon first, full suite second: run single failing spec before any full-suite run; long suites via `nohup … > /tmp/e2e.log 2>&1 &` + poll — full suite can outlive a tool call, get aborted mid-run.
5. "Nothing happened" = diagnose the window, not the app — blind reruns of headed suite = failure mode: Chromium freezes rendering (rAF + compositing) for occluded/backgrounded windows, map/canvas/animation steps silently no-op in headed browser that isn't visible. Before rerunning anything: screenshot or re-run the one step headless — headless works → app fine, window was occluded. One harness check beats N blind reruns.

## Performance rules

- Built-in fixtures (`test('…', async ({ page }) => …)`) — `browser` worker-scoped shared; `page` per-test isolated. Never `chromium.launch()` inside a test.
- Expensive shared setup → worker-scoped custom fixture, not per-test setup.
- Browser install = environment setup, never part of test command.
- `reuseExistingServer: !process.env.CI`; see Pre-flight §3 on mixing servers.
- CI prefers production build; library repos run e2e vs `dist/`.
- Always `headless: true` — headed only when user explicitly asks. No announcement; user knows.
- Never `slowMo` as perf fix; no per-test launches to "isolate" flake.
- Chromium flags: none by default — add one only when required, documented, reason recorded in config, measurably better. (Legit exception: headless GPU/WebGL needs `--use-angle=swiftshader --enable-unsafe-swiftshader`, + `--disable-dev-shm-usage` in containers; `--no-sandbox` only Docker/CI.)
- Tracing/screenshots/video: `on-first-retry` / `retain-on-failure` only.
- Report before/after timings with every performance change.

## Locator strategy

Selectors describe what user sees, priority:
1. `page.getByRole()` with accessible name
2. `page.getByLabel()` for form controls
3. `page.getByText()` for visible content
4. `page.getByTestId()` when app provides test contract
5. CSS/structured last — derived from rendered DOM (recon), never source guesses

Waits: actions auto-wait for actionability; web-first assertions (`await expect(locator).toBeVisible()`) or `locator.waitFor()` — never `waitForSelector`, fixed sleeps, or `networkidle` (SPAs with polling never go idle; poll app-readiness predicates instead).

```js
await page.getByLabel('Email').fill(process.env.E2E_EMAIL);
await page.getByRole('button', { name: 'Sign in' }).click();
await page.waitForURL('**/dashboard');
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
```

Never claim success without asserting resulting page state — report actions, failures, artifact paths from what page actually shows.

## Reconnaissance-then-action

Before writing selectors on dynamic app: wait for load, inspect rendered DOM (`page.content()`, `locator("button").all()`), screenshot. Selectors from rendered state, never source guesses.

- Never assert an attribute component doesn't forward (`data-testid`, classes) — verify forwarding in live DOM first.
- React StrictMode double-mounts duplicate ids → assert count-tolerantly (`>= n`) via `expect.poll`.
- Visual identity in CSS (icons as `background-image`, glyphs): assert computed style, not child elements — host app must import every published stylesheet/entry point (a logo once "vanished" because test host never imported library's styles export).
- Cap everything a recon/probe step returns before it lands in context: `JSON.stringify(x).slice(0, 500)` for `page.evaluate` dumps, `t=$(mktemp); <cmd> > "$t" 2>&1 || tail -20 "$t"` (tail only on failure — bare `| tail` masks exit code) on test-run output, `-o`/`| cut -c1-200` when grepping a library's `dist` — minified lines are megabytes; `head -N` bounds lines, not bytes.

Recon tools: `browser-tools` skill (CDP eval on running case, same-origin state, no login automation) or `npx playwright codegen <url>` — generating specs without either = failure mode this section prevents.

## Trusted input

Native canvas/gesture components (maps, drawings, editors) bind real container-level `mousedown`, ignore synthetic `dispatchEvent`. Drive with real `page.mouse.down()/move()/up()`. Before ANY synthetic-input attempt: `rg` the library's dist in `node_modules` for event binding — it states the binding target outright; two rounds of failed synthetic probing once answered by one `rg` of source.

## Scaffold

Copy from `{baseDir}/assets/`: `playwright.config.ts`, `e2e/fixtures/*.ts` (`cdp`, `api`, `report`), `e2e/example.spec.ts`. E2e code lives in the target repo — inside its existing e2e directory when one exists (`e2e/`, `__tests__/e2e/`, `tests/e2e/`), else `e2e/` when scaffolding fresh. Chrome 155+: `connectOverCDP` must pass `{ noDefaults: true }` (default connect issues browser-level `Browser.setDownloadBehavior`, which Chrome 155+ rejects); the copied `cdp` fixture already does. Add `"e2e": "playwright test"` to package.json. Env: `E2E_APP_URL`, `E2E_AUTH_TOKEN_KEY`, `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_ITERATIONS` — credentials never hardcoded. Adapt only `ADAPT` markers: selectors, endpoints, token key, server-managed fields.

## References

- `references/acceptance-and-budgets.md` — acceptance + artifacts rules, timeout budgeting, slow-startup measurement.
- `references/headed-review.md` — headed review runs (window sizing, per-test hold, camera, occlusion) + headless quirks.
- `references/library-and-stress.md` — library/SDK e2e (case registry), update-flow stress pattern, debugging a FAIL.
