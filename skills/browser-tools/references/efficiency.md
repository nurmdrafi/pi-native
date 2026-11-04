# Efficiency guide — eval patterns that keep context small

Read before writing browser-eval scripts. One rule drives everything: DOM is queryable — extract structured state in one eval instead of screenshotting or many small calls.

## DOM inspection over screenshots

Never screenshot to see page state. Parse DOM directly:

```javascript
// Page structure
document.body.innerHTML.slice(0, 5000)

// Interactive elements
Array.from(document.querySelectorAll('button, input, [role="button"]')).map(e => ({
  id: e.id,
  text: e.textContent.trim(),
  class: e.className
}))
```

## Complex scripts in single calls

Wrap everything in an IIFE for multi-statement code:

```javascript
(function() {
  const data = document.querySelector('#target').textContent;
  const buttons = document.querySelectorAll('button');

  // Interactions
  buttons[0].click();

  // Return results
  return JSON.stringify({ data, buttonCount: buttons.length });
})()
```

## Batch interactions

Never separate calls per click. Batch:

```javascript
(function() {
  const actions = ["btn1", "btn2", "btn3"];
  actions.forEach(id => document.getElementById(id).click());
  return "Done";
})()
```

## Typing/input sequences

```javascript
(function() {
  const text = "HELLO";
  for (const char of text) {
    document.getElementById("key-" + char).click();
  }
  document.getElementById("submit").click();
  return "Submitted: " + text;
})()
```

## State snapshot

```javascript
(function() {
  const state = {
    score: document.querySelector('.score')?.textContent,
    status: document.querySelector('.status')?.className,
    items: Array.from(document.querySelectorAll('.item')).map(el => ({
      text: el.textContent,
      active: el.classList.contains('active')
    }))
  };
  return JSON.stringify(state, null, 2);
})()
```

## Waiting for readiness (poll, never blind sleep)

Blind sleeps = flake factory banned in `playwright-tester`; same rule here. Poll a predicate — page first, then app readiness:

```bash
for i in $(seq 1 20); do
  {baseDir}/scripts/browser-eval.js 'document.readyState' | rg -q interactive && break
  sleep 0.25
done
```

```javascript
// App readiness: poll the engine's own readiness API in one eval —
// e.g. a map engine exposes loaded()/isStyleLoaded(); a framework exposes a
// mount/store flag. Pick the predicate the spec actually waits on.
(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const m = window.__APP__;
    if (m && m.isReady && m.isReady())
      return JSON.stringify({ready: true, ms: Date.now() - t0});
    await new Promise(r => setTimeout(r, 200));
  }
  return JSON.stringify({ready: false});
})()
```

## Standard recon (always start here)

One eval, one stable shape — URL, title, readyState, trapped errors, console errors, interactive elements, exposed app state. Install error collector first via [debugging.md](debugging.md) so error fields populate:

```javascript
(() => JSON.stringify({
  url: location.href,
  title: document.title,
  readyState: document.readyState,
  pageErrors: (window.__DBG__ && __DBG__.errors) || window.__pageErrors__ || [],
  consoleErrors: (window.__DBG__ && __DBG__.console) || [],
  interactives: Array.from(document.querySelectorAll('button, input, a, [role="button"]'))
    .slice(0, 25).map(e => ({tag: e.tagName, id: e.id, text: (e.textContent || '').trim().slice(0, 30)})),
  appState: Object.keys(window).filter(k => /^__/.test(k))
}))()
```

Then target specific elements based on what you find.
