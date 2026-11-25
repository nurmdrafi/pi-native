---
name: puppeteer
description: >
  Puppeteer / headless Chrome automation: scripted browser flows, scraping,
  screenshot and PDF generation, network interception, CDP sessions.
  Triggers on: "Puppeteer", "headless Chrome", "page.goto", "scrape",
  "render HTML to PDF", "print to PDF", "PDF parity", "extra blank page",
  "PDF fonts wrong", "table columns shift".
disable-model-invocation: true
languages:
  - JavaScript
  - TypeScript
category: e2e-testing
license: MIT
metadata:
  author: TestMu AI
  version: "1.0"
  source: https://github.com/LambdaTest/agent-skills/tree/main/puppeteer-skill
---

# Puppeteer Automation Skill

Puppeteer ships breaking API moves every few majors; the snippets below are
kept current for puppeteer >= 22 and called out where older guides are wrong:

- `headless: 'new'` was removed — use `headless: true` (full Chrome) or
  `headless: 'shell'` (old headless shell, lighter, no extensions).
- `page.waitForTimeout` was removed — use `new Promise(r => setTimeout(r, ms))`
  or a real condition (`waitForSelector` / `waitForFunction`).
- `page.setContent(html, { waitUntil: 'networkidle0' })` is rejected by the
  typings in v25: wait for `load`, then `await page.waitForNetworkIdle()`.
- `browser.on('disconnected', …)` fires on crash/close — a long-lived service
  must drop its cached browser there, otherwise every later call fails.
- Inside containers Chromium needs `--no-sandbox --disable-setuid-sandbox`
  (no user namespaces for the runtime user) and its shared libraries plus
  fonts installed, or it exits before the first navigation.

## Core Patterns

### Basic Script

```javascript
const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    await page.goto('https://example.com', { waitUntil: 'networkidle0' });
    await page.type('#username', 'user@test.com');
    await page.type('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });

    const title = await page.title();
    console.log('Title:', title);

    await browser.close();
})();
```

### Wait Strategies

```javascript
// Wait for selector
await page.waitForSelector('.result', { visible: true, timeout: 10000 });

// Wait for navigation
await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle0' }),
    page.click('a.nav-link'),
]);

// Wait for function
await page.waitForFunction('document.querySelector(".count").innerText === "5"');

// Wait for network request
const response = await page.waitForResponse(resp =>
    resp.url().includes('/api/data') && resp.status() === 200
);
```

### Screenshot & PDF

```javascript
await page.screenshot({ path: 'screenshot.png', fullPage: true });
await page.pdf({ path: 'page.pdf', format: 'A4', printBackground: true });
```

A PDF that must *match a reference render* is a different job from a PDF that
merely exists — go to [Print parity](#print-parity-html--pdf) below before
shipping one.

### Print parity (HTML → PDF)

Chrome is the only engine that lays out the document you author and the PDF you
print with the same code, so parity work is about pinning the inputs it leaves
loose. `scripts/html-to-pdf.mjs` does the whole sequence for one file:

```bash
node scripts/html-to-pdf.mjs input.html out.pdf --public ./public \
    --margin 5 --expect-pages 1
```

Each invariant below silently changes the output; none of them errors:

- **An unloaded webfont is a different document.** `waitUntil: 'load'` does not
  cover `@font-face`; printing mid-load falls back to the system family and
every glyph width shifts. Await `document.fonts.ready` before `page.pdf()`.
- **Webfonts are cross-origin when the document came from `setContent`.** That
  document has an opaque origin, so `@font-face` fetches need an
  `Access-Control-Allow-Origin` header. Without it Chrome logs a font error and
  prints the fallback — the asset server has to answer CORS, not the page.
- **The UA sheet sizes tables at `1em` of `medium` (16px), not the document
  size.** A table inside `body{font-size:10px}` still prints at 16px: cells look
  oversized and rows inflate. Add `table { font-size: inherit }` when porting
  another engine's stylesheet.
- **A floated row contributes no height.** Children of `float:left/right`
  collapse the parent, so the next block starts inside the float. Clear it
  (`<div style="clear: both"></div>`) instead of trusting float handling.
- **Auto table layout shrinks columns around empty cells.** One null value
  narrows that column in every row; `table-layout: fixed` plus header widths
  keeps siblings at their share regardless of content.
- **`printBackground` + `print-color-adjust: exact`** keep header fills and
  borders; without both, colored cells print white.
- **px → pt is exactly 0.75** (96px = 1in = 72pt), so a px stylesheet ports
  without unit conversion; `page.pdf({ margin })` takes its own units (mm).
- **A stray page means the first block overflowed.** Negative margins, a
  background on `body`, or an un-cleared float push the layout down; fix the
  cause rather than shrinking `line-height` until it fits.
- **Page size has one source.** `preferCSSPageSize: false` keeps `format` +
  `margin` authoritative, so a template `@page` rule cannot resize the sheet.

For migration parity, the reference is the final PDF from the original generator,
not the HTML preview. Compare the same sanitized input snapshot, selected records,
assets, locale and time. Before adjusting CSS, check each printed value against
its expected record and section. Include repeated records with different answers
and intentional blanks: an unavailable source is not evidence for a blank or a
fallback value. Report a binding mismatch separately from a positioning mismatch.

Inspect both **assembled PDFs**, including appended pages:

```bash
pdfinfo out.pdf | grep Pages      # page count
pdffonts out.pdf                  # embedded family: a system name means failure
pdftohtml -xml -stdout out.pdf    # per-string top/left/width for a diff
pdftocairo -svg out.pdf out.svg   # border weights/colors as vector data
```

Check page dimensions, count and order before comparing text bounds and embedded
fonts. Rasterize both PDFs with the same rasterizer and resolution; overlay each
page to catch shifted seals, clipped captions, missing glyphs and distorted
attachment images. Neither matching text nor matching geometry proves data
identity. Trace extra or missing pages to selection, assembly or pagination
before changing margins. Record the fixture, render settings and result per
format; no paired reference means unverified, even if a sibling format passes.

### Network Interception

```javascript
await page.setRequestInterception(true);
page.on('request', request => {
    if (request.resourceType() === 'image') request.abort();
    else request.continue();
});

// Mock API
page.on('request', request => {
    if (request.url().includes('/api/data')) {
        request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ items: [] }),
        });
    } else request.continue();
});
```

### TestMu AI Cloud

For full setup, capabilities, and shared capability reference, see [reference/cloud-integration.md](reference/cloud-integration.md).

```javascript
const capabilities = {
    browserName: 'Chrome', browserVersion: 'latest',
    'LT:Options': {
        platform: 'Windows 11', build: 'Puppeteer Build',
        user: process.env.LT_USERNAME, accessKey: process.env.LT_ACCESS_KEY,
    },
};

const browser = await puppeteer.connect({
    browserWSEndpoint: `wss://cdp.lambdatest.com/puppeteer?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`,
});
```

## Quick Reference

| Task | Code |
|------|------|
| Launch headed | `puppeteer.launch({ headless: false })` |
| Evaluate JS | `await page.evaluate(() => document.title)` |
| Extract text | `await page.$eval('.el', el => el.textContent)` |
| Extract all | `await page.$$eval('.items', els => els.map(e => e.textContent))` |
| Set cookie | `await page.setCookie({ name: 'token', value: 'abc' })` |
| Emulate device | `await page.emulate(puppeteer.devices['iPhone 12'])` |

## Deep Patterns → `reference/playbook.md`

Also in `reference/`: `advanced-patterns.md` (PDF/screenshot tuning,
parallelism, CDP session reuse) and `cloud-integration.md` (TestMu AI / LambdaTest
remote grids).

| § | Section | Lines |
|---|---------|-------|
| 1 | Production Setup & Configuration | Launch options, Jest integration |
| 2 | Page Object Pattern | BasePage, LoginPage, DashboardPage |
| 3 | Network Interception & Mocking | Request mock, response capture |
| 4 | Wait Strategies | DOM, network, custom conditions |
| 5 | Screenshots, PDF & Media | Full page, clip, PDF, video |
| — | Print parity (HTML → PDF) | In-file section above + `scripts/html-to-pdf.mjs` |
| 6 | Authentication & Cookies | API login, session save/restore |
| 7 | iFrame, Dialog & File Operations | Upload, download, dialogs |
| 8 | Performance & Metrics | Web Vitals, Lighthouse, coverage |
| 9 | Accessibility Testing | axe-core integration |
| 10 | CI/CD Integration | GitHub Actions, Docker |
| 11 | Debugging Quick-Reference | 11 common problems |
| 12 | Best Practices Checklist | 13 items |
