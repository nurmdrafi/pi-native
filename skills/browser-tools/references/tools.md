# Tool reference — CDP browser scripts

Chrome DevTools Protocol tools for agent-assisted web automation. Connect to Chrome on `:9222` with remote debugging. macOS + Linux. `{baseDir}` = this skill's root.

## Attach to the user's existing browser (Chrome >= 136)

Chrome 136+ ignores `--remote-debugging-port`/`--pipe` on the default user-data-dir (anti-cookie-theft change; no setting, flag, or policy lifts it — verified against developer.chrome.com/blog/remote-debugging-port). The sanctioned way to drive the user's real, logged-in profile:

1. One-time, user-side: enable remote debugging at `chrome://inspect/#remote-debugging`. Chrome must run with NO debug flags — a stale ignored `--remote-debugging-port` hangs the internal server at "starting" (clean relaunch writes `DevToolsActivePort` at once).
2. Agent-side driver (installed): `~/.pi/agent/tools/chrome-devtools-mcp/mcp-drive.mjs 'tool:{json-args}' ...` — spawns `chrome-devtools-mcp --autoConnect --channel=stable`, one connection per run, executes tools in order. Chrome pops a permission dialog; the user clicks Allow. Tools: `list_pages`, `navigate_page` (needs numeric pageId from list_pages), `take_snapshot`, `evaluate_script`, `click`, `fill`, ... (33 total).
3. Full runbook: `~/.pi/agent/tools/chrome-devtools-mcp/SETUP.md`.

Use this route whenever the task needs the user's real session (logins, personal state). The scripts below remain for debug-dir/fresh-profile work.

## Setup

Run once before first use (deps not committed):

```bash
cd {baseDir} && npm install
```

Pre-flight any session: `node_modules` exists in `{baseDir}`, dev server reachable (`curl -sf localhost:PORT`), `:9222` not already taken by another debug Chrome.

## Start Chrome

```bash
{baseDir}/scripts/browser-start.js              # Fresh profile
{baseDir}/scripts/browser-start.js --profile    # Copy user's profile (cookies, logins)
CHROME_PATH=/path/to/chrome {baseDir}/scripts/browser-start.js   # Explicit executable
```

Launch Chrome with remote debugging on `:9222`. Auto-detected per OS (macOS: `/Applications`, Linux: `google-chrome`/`chromium`/snap); override `CHROME_PATH` if detection fails.

Fresh vs `--profile`:
- Fresh (default) — clean, reproducible; use whenever task doesn't need developer's logins.
- `--profile` — only when target requires user's auth/cookies. Costs: extensions, service workers, stale caches, other profile state interfere. Never assert through `--profile` state when reproducibility matters — record `storageState` instead, feed to Playwright.

## Navigate

```bash
{baseDir}/scripts/browser-nav.js https://example.com
{baseDir}/scripts/browser-nav.js https://example.com --new
```

`--new` = new tab instead of reusing current.

## Evaluate JavaScript

```bash
{baseDir}/scripts/browser-eval.js 'document.title'
{baseDir}/scripts/browser-eval.js 'document.querySelectorAll("a").length'
```

Execute JS in active tab. Async context. Extract data, inspect page state, perform DOM operations.

## Screenshot

```bash
{baseDir}/scripts/browser-screenshot.js
```

Capture current viewport, return temp file path. Visually inspect page state or verify UI changes.

## Pick Elements

```bash
{baseDir}/scripts/browser-pick.js "Click the submit button"
```

User wants specific DOM elements selected → launches interactive picker; user clicks elements (multi via Cmd/Ctrl+Click, Enter to finish). Returns CSS selectors.

Use cases: "I want to click that button" → let them select; "extract data from these items" → select elements; need selectors but page structure complex/ambiguous.

## Cookies

```bash
{baseDir}/scripts/browser-cookies.js
```

All cookies for current tab incl. domain, path, httpOnly, secure flags. Debug auth issues / inspect session state.
