#!/usr/bin/env node
/**
 * Black-box fixture runner for the permission-gate extension.
 *
 * Cases live under tests/gate/cases — one module per rule key from
 * extensions/permission-gate/config.json (cases/rules/), plus multi-rule scenes
 * (cases/scenes/). Harness code (stub API, helpers, preambles) is in
 * tests/gate/harness. This file only runs the assembled list: expectation check,
 * block-reason diet cap, non-zero exit on failure. See tests/gate/README.md.
 */
import { freshGate } from "./harness/helpers.mjs";
import { preambles } from "./harness/preambles.mjs";
import { cases } from "./cases/index.mjs";

let failed = 0;
for (const [name, expect, probe] of cases) {
  const pi = await (preambles[name] ?? (() => freshGate()))();
  const got = await probe(pi);
  const ok = (expect === "blocked") === got.blocked;
  if (!ok) failed++;
  if (got.blocked && got.reason) {
    // 2026-10-06 diet: prose reasons <= 220c; Anchor Guard may carry a <= 800c snippet
    const cap = got.reason.startsWith("Anchor Guard") ? 800 : 220;
    if (got.reason.length > cap) {
      failed++;
      console.log(
        `FAIL  ${name}  (block reason ${got.reason.length}c exceeds ${cap}c diet cap)`,
      );
    }
  }
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}  (expected ${expect}, got ${got.blocked ? "blocked" : "pass"})`,
  );
}

console.log(
  failed === 0
    ? `\n${cases.length}/${cases.length} PASS`
    : `\n${failed}/${cases.length} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);

