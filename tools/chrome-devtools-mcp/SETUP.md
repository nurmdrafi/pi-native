# chrome-devtools-mcp — existing-browser attach runbook

Drives the user's real, logged-in Chrome profile. Sanctioned route since
Chrome 136+ blocks `--remote-debugging-port`/`--pipe` on the default
user-data-dir (verified: developer.chrome.com/blog/remote-debugging-port).

## Installed versions (2026-11-13)

- Chrome 152.0.7977.82 stable, `/opt/google/chrome/chrome`, default profile
  `~/.config/google-chrome` (profiles: `Profile 2/3/4`, no `Default`).
- chrome-devtools-mcp 1.13.0 (npm, this dir; node v24.21.0 pinned in `.nvmrc`).
- Entry: `node_modules/chrome-devtools-mcp/out/Default/gen/src/bin/chrome-devtools-mcp.js`

## One-time setup (already done)

1. User enabled remote debugging: `chrome://inspect/#remote-debugging`.
   Chrome then writes `~/.config/google-chrome/DevToolsActivePort` on start.
2. Chrome runs with NO debug flags. A stale ignored
   `--remote-debugging-port` flag hangs the inspect-page server at
   "Server running at: starting…" — clean relaunch fixes it instantly.
3. Probe scripts here: `probe-mcp.mjs` (handshake + tools/list),
   `live-test.mjs` (list_pages end-to-end), `mcp-drive.mjs` (the driver).

## Per-session usage (preferred: bridge = ONE Allow-click per session)

```bash
nohup node ~/.pi/agent/tools/chrome-devtools-mcp/mcp-bridge.mjs >/tmp/mcp-bridge.log 2>&1 &
node ~/.pi/agent/tools/chrome-devtools-mcp/mcp-client.mjs 'list_pages:{}' \
  'navigate_page:{"pageId":1,"url":"https://www.linkedin.com/"}' 'take_snapshot:{}'
node ~/.pi/agent/tools/chrome-devtools-mcp/mcp-client.mjs '__quit__'   # stop: drops banner
```

- Bridge holds one MCP connection open: Chrome asks Allow ONCE per session,
  the "controlled by automated test software" banner stays while connected.
- Client calls are cheap; multiple steps per call execute in order.
- If Chrome restarts (DevToolsActivePort changes): kill and restart the bridge.
- `navigate_page` requires the numeric `pageId` from `list_pages`.

## Per-run usage (one-shot fallback; one dialog per run)

```bash
node ~/.pi/agent/tools/chrome-devtools-mcp/mcp-drive.mjs \
  'list_pages:{}' \
  'navigate_page:{"pageId":1,"url":"https://www.linkedin.com/"}' \
  'take_snapshot:{}'
```

## Tools available (33)

click, close_page, drag, emulate, evaluate_script, fill, fill_form,
get_console_message, get_css_styles, get_network_request, handle_dialog,
hover, lighthouse_audit, list_console_messages, list_network_requests,
list_pages, navigate_page, new_page, performance_analyze_insight,
performance_start_trace, performance_stop_trace, press_key, resize_page,
screencast_start, screencast_stop, select_page, set_logpoints,
take_heapsnapshot, take_screenshot, take_snapshot, type_text, upload_file,
wait_for

## Gotchas found

- Auto-connect is passive: the server only reads `DevToolsActivePort`; it
  cannot force the enable. Missing file = Chrome side not armed or stale flag.
- `--channel=stable` must match the installed Chrome channel.
- Root-cause chain if attach fails, in order: Chrome running? file exists?
  debug flags absent from process? channel correct?

## Fallback

Dedicated debug profile (works, zero dialogs, separate login):
`google-chrome --user-data-dir=~/.config/chrome-cdp --remote-debugging-port=9222`
— dir kept at `~/.config/chrome-cdp` from the pre-MCP attempt.
