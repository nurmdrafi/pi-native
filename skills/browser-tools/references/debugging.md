# Debugging failing e2e / browser-mode specs live

Read when a Playwright/Vitest-browser spec fails and runner log doesn't explain it — inspect live case instead of guessing from stack traces.

**Go live after ONE unexplained failure** — repeated log re-reads = anti-pattern: live replay routinely settles in minutes what hours of log analysis couldn't, surfacing real library bugs logs never show (crashing documented patterns, event-payload changes).

**Occluded-window freeze — check harness before rerunning.** Chromium freezes rendering (rAF + compositing) for occluded/backgrounded windows. Headed visual/e2e step reports "nothing happened" → suspect this first: verify by bringing window to front or screenshotting before rerunning suite — blind reruns reproduce same freeze.

## Procedure

0. Consume runner artifacts first: failure screenshot/trace/report + saved run logs usually answer with zero execution (see `playwright-tester` "Debugging a FAIL"). User asks for screenshot of failing case → prefer runner's failure screenshot over live one. Go live only when artifacts don't explain.
1. Start dev/test server in background (e.g. `npm run e2e:serve &`).
2. `{baseDir}/scripts/browser-start.js` → `{baseDir}/scripts/browser-nav.js <failing case URL>`.
3. Install error collector immediately after navigation (snippet below — idempotent, survives this tab), then standard recon eval via [efficiency.md](efficiency.md) as baseline.
4. Replay spec's steps with `browser-eval.js` IIFEs — query DOM, read app state (any exposed global, e.g. `window.__APP__`), compare vs spec assertions.
5. Fix spec or app, re-run runner headless to confirm.
6. Live window showing nothing moving = usually occlusion, not bug: Chromium suspends rAF/compositing for backgrounded/covered windows, map/canvas interactions replay silently. Bring tab to front (or run step headless) before concluding events don't fire — don't rerun suite.

Vitest Browser Mode specs debug same way — same CDP Chrome serves them; replay failing case URL exactly as Playwright specs.

## Error + console + network collector

Install once per tab, read after replay with `browser-eval.js 'JSON.stringify(window.__DBG__)'`:

```javascript
(function(){
  if (!window.__DBG__) {
    window.__DBG__ = {errors: [], console: [], requests: []};
    addEventListener("error", e => __DBG__.errors.push(String(e.error || e.message)));
    addEventListener("unhandledrejection", e => __DBG__.errors.push("rejection: " + e.reason));
    const ce = console.error;
    console.error = function(){ __DBG__.console.push([].map.call(arguments, String).join(" ")); ce.apply(null, arguments) };
    const of = window.fetch;
    window.fetch = function(){ var u = String(arguments[0]);
      return of.apply(this, arguments).then(
        function(r){ __DBG__.requests.push(u + " " + r.status); return r },
        function(e){ __DBG__.requests.push(u + " failed"); throw e }) };
  }
  return "collector installed";
})()
```

Requests made before collector: `performance.getEntriesByType("resource").map(e => e.name + " " + e.responseStatus)`.

## Pitfalls seen in practice

- Blank page, no error overlay: read trapped page errors — harness exposes page-error recorder (`window.__pageErrors__`) → read it; else install `window.addEventListener('error'/'unhandledrejection')` collectors via init script, reload, read. Swallowed render errors invisible otherwise.
- Bare-specifier imports don't resolve in page context — `browser-eval` runs in the page, not a bundler. IIFEs over already-loaded globals, or probe via harness.

## Event-flow tracing (canary probe)

Listener seems registered but never fires → instrument live object's event system, replay — settles "registered vs consumed vs removed" in one round where log-guessing failed repeatedly:

```javascript
// Canary next to the suspect registration
map.once('mouseup', () => console.log('canary-once-fired'))
const origOnce = map.once.bind(map)
map.once = (ev, fn) => { console.log('once-reg:', ev); return origOnce(ev, fn) }
// read log after replay: registration without firing = remover or event-name
// mismatch; canary fires but handler doesn't = different instance
```

## Engine source = ground truth

Live behavior contradicts expectation → read installed library's source (its dist in `node_modules`) for binding/gating logic — `rg` dist for `_on`, `once(`, event names. Source explains WHY (binding target, state machine, payload shape); live probe confirms. Two failed synthetic-event strategies + an "event payload lost a field" mystery both answered by reading dist directly — payload changes across major versions (e.g. drag events losing `lngLat`) visible in shipped code + `.d.ts`.

## Slow startup: measure before modifying

Browser interaction feels slow → attribute delay before changing anything. Time separately: CDP connection (`curl -sf localhost:9222/json/version` in a loop until it answers = Chrome's readiness), context discovery (`/json/list`), page discovery, first action (`scripts/browser-eval.js '1+1'` end-to-end). Classify: connection, browser launch, context creation, page creation, navigation, or application readiness (app boot / API deps). Typical signatures: everything fast except `goto`-like actions → application/server, not browser; slow first `browser-eval` but fast later → connection setup; slow `/json/version` → Chrome itself (profile size, flags, Rosetta on macOS arm64).
