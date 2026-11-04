# Headed review runs and headless quirks

Read before running a headed suite or a review a human watches.

## Headed review runs (human watches the browser)

- Window sizing — never chase crop with size tweaks. Fixed `viewport` crops right/bottom on any display whose usable area < viewport + OS window chrome (macOS menubar/dock, Linux panels differ per machine — same fixed size fit one laptop, cropped another, both OSes). Headed review: `viewport: null` + `launchOptions: { args: ['--start-maximized'] }` — page renders at exactly visible desktop area on every OS/display. Headless keeps Chromium default size — fine for DOM/app-state assertions, never pixel layout.
- Per-test hold: wrap the `page` fixture itself (`page: async ({ page: basePage }, use, testInfo) => { await use(basePage); await hold(basePage, testInfo) }`) — lazy (instantiates page only when test depends on it), applies in every spec file. Module-level hooks in shared fixture module (`test.afterEach`) attach only to FIRST importing file; auto fixture instantiates default page even for tests using `{ browser }` (stray about:blank window). Guard with `project.use.headless === false`, `page.isClosed()`, `page.url() !== 'about:blank'` — wrap hold body in try/catch: cosmetic, destroyed execution context must never fail test.
- Geolocation tests: prefer per-test `test.use({ geolocation, permissions: ['geolocation'] })` + `page.addInitScript` faking API over `browser.newContext()` — one window, hold applies; custom context = usual source of "two windows at once" + missing hold bar.
- Consecutive camera actions (zoomOut ×2, chained flyTo): wait camera-idle between them. Click landing mid-ease cancels animation, re-eases from intermediate zoom (13 → 11.96 instead of 11) — assertion fails while code is correct.
- One review harness across every headed suite: shared review chrome — per-suite restyle reads to user as "visual UI does not match".
- Case transitions instant: snapshot/prepare heavy setup once (prebuilt apps, stored state), reuse browser across cases — fresh launch/reinstall per case adds dead seconds after every hold.
- Occluded/backgrounded windows freeze rendering — Chromium pauses rAF + compositing for hidden, fully covered, or backgrounded windows. Headed review "shows nothing"/stalls mid-animation = harness artifact, not app bug: verify by bringing window to front, screenshotting, or headless before rerunning — reruns reproduce same freeze.

## Headless quirks

- Fullscreen: fires `fullscreenchange` at load in headless → assert toggle direction-agnostically (class swaps between two known values), never initial direction.
- Geolocation: no permission prompt → override `navigator.geolocation` via `context.addInitScript` instead of granting permissions.
- CPU-rendered graphics rasterize slower than GPU → re-budget settle waits, see [acceptance-and-budgets.md](acceptance-and-budgets.md), prefer `expect.poll` with own timeout.
