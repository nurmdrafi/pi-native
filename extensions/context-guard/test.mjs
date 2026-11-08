/**
 * Source-level tests for context-guard pure helpers (no test framework, no
 * installs). Run: node extensions/context-guard/test.mjs — exits non-zero on
 * the first failure.
 */
import assert from "node:assert/strict";
import { contextWindowFor, formatTokens, proxyTokens, stateFor, widgetLine } from "./index.ts";

// proxyTokens: cacheRead proxies context; input is the no-cache fallback.
assert.equal(proxyTokens({ input: 500, cacheRead: 130_000 }), 130_000);
assert.equal(proxyTokens({ input: 9_000, cacheRead: 0 }), 9_000);

// contextWindowFor: family map with 200K default.
assert.equal(contextWindowFor("anthropic/claude-sonnet-4"), 200_000);
assert.equal(contextWindowFor("openai/gpt-4.1"), 128_000);
assert.equal(contextWindowFor("openai/gpt-4o"), 128_000);
assert.equal(contextWindowFor("google/gemini-2.5-pro"), 1_000_000);
assert.equal(contextWindowFor("zai/glm-5.3"), 1_000_000); // static catalog: chunk-44DLKSKE.js:1
assert.equal(contextWindowFor("some-vendor/mystery-model"), 200_000);
assert.equal(contextWindowFor(null), 200_000);

// stateFor: OK <60% and <120K; WARN >=60% or >=120K; ALERT >=75% or >=150K.
assert.equal(stateFor(119_000, 200_000), "OK"); // 59.5% — under both bars
assert.equal(stateFor(120_000, 200_000), "WARN"); // absolute 120K bar
assert.equal(stateFor(130_000, 200_000), "WARN"); // 65% pct bar
assert.equal(stateFor(150_000, 200_000), "ALERT"); // absolute 150K bar
assert.equal(stateFor(156_000, 200_000), "ALERT"); // 78% pct bar
assert.equal(stateFor(100_000, 128_000), "ALERT"); // 78% of a smaller window
assert.equal(stateFor(1_500_000, 1_000_000), "ALERT"); // absolute bar ignores window
assert.equal(stateFor(100_000, 1_000_000), "OK"); // 10% and under 120K

// formatTokens.
assert.equal(formatTokens(0), "0K");
assert.equal(formatTokens(132_000), "132K");
assert.equal(formatTokens(1_500_000), "1.5M");

// widgetLine format: "ctx 132K/200K (66%) STATE", unknown-token and post-compact variants.
assert.equal(widgetLine(132_000, 200_000, "OK"), "ctx 132K/200K (66%) OK");
assert.equal(widgetLine(null, 200_000, "OK", true), "ctx –/200K OK · compacted");

console.log("context-guard: all helper assertions passed");
