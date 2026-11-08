---
name: browser-tools
description: "Playwright/e2e testing ONLY via CDP :9222: verify UI fixes in the running app, live replay of failing specs, DOM inspection, screenshots, storageState for e2e work. NOT research/web content (→ web-search), NOT manual QA, NOT general debugging (→ systematic-debugging), NOT frontend design (→ refactoring-ui)."
disable-model-invocation: true
---

`<skill-dir>` = this skill's directory (`location` attribute on the injected skill tag; normally `~/.pi/agent/skills/browser-tools`). All `scripts/`, `references/`, `assets/` paths in this skill resolve under it — never the session cwd.

# Browser Tools

## Invocation + reuse rules (mandatory)

- Load this skill before ANY live-browser interaction (navigation, eval, screenshots, DOM inspection of running page, replaying failing specs).
- No browser when filesystem/shell/static-code inspection answers the question; state briefly (internal workflow) what the browser is for before starting.
- Reproducible automated E2E → `playwright-tester` skill (Playwright Test fixtures), not ad-hoc scripting here. This skill = interactive/live work; rules complement, never duplicate, that skill.
- Reuse: never launch second Chrome when existing debug session on :9222 alive + safe — connect.
- Reuse existing tabs/contexts when safe (`--new` only when current tab must not be disturbed).
- **Verify tab targeting before trusting eval output**: after `browser-nav` (especially `--new`), confirm next eval lands in intended tab — standard recon reports URL + title first; they must match target. An eval once ran in stale "New Tab", read as blank page, sent investigation down false path.
- Close only resources current task created; leave developer's browser/tabs as found.
- Never expose debugging port beyond localhost (no `0.0.0.0` binding, no public port-forward for :9222).
- After each session, record evidence: URL, title, console errors, network errors, screenshot paths — in reply or task report.
- Record whether browser launched fresh, reused, or attached via CDP in any timing-related report.

## Routing

**This skill exists for Playwright/e2e testing only.** Anything else routes elsewhere:

- Read-only research / web content → web-search skill (`tvly search`, `tvly extract`); static pages `{baseDir}/scripts/web-fetch.mjs <url> <maxChars>` = cheapest extractor (headless, capped, no quota). Never this skill for research.
- Manual QA / visual review → refactoring-ui or user-driven, not agent browser driving.
- General debugging (runtime errors, wrong data) → systematic-debugging; go live only when failing spec needs it.
- Failing e2e/browser-mode spec the runner log doesn't explain → live replay: [references/debugging.md](references/debugging.md) (go live after ONE unexplained failure).
- Out of scope:
  - frontend feature testing outside e2e specs
  - visual inspection for design review
  - scraping for research
  - auth debugging outside e2e sessions
  - one-off DOM poking.
- Task not part of Playwright/e2e effort → doesn't need this skill's Chrome.

## Tools

CDP tools against Chrome on `:9222` (macOS + Linux): per-script usage, setup (`npm install` once), pre-flight, fresh-vs-`--profile` guidance: [references/tools.md](references/tools.md).

## References

- [references/tools.md](references/tools.md) — per-script usage, setup, pre-flight, profile trade-offs, slow-startup attribution.
- [references/debugging.md](references/debugging.md) — live replay of failing specs: procedure, error/console/network collector, canary probe, engine-source-as-ground-truth.
- [references/efficiency.md](references/efficiency.md) — eval patterns: standard recon, DOM-over-screenshots, single-call IIFEs, batching, polling.
