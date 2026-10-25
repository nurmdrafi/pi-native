#!/usr/bin/env node
/**
 * R1c locate-first: glob search targets must seed the searched-path set.
 *
 * 2026-10-18 session audit: `rg <term> src/utils/*.js` returned hits in
 * notificationRealtime.js, yet a 100-line read of that file was blocked —
 * "no search has named this session". `searchedPathsFrom` only credits tokens
 * that resolve to an existing path, so the literal `*.js` glob was dropped and
 * a compliant locate-first flow got blocked anyway. The gate's recognition was
 * narrower than the rule it enforces.
 *
 * Pins: (1) a glob token credits the files it matches; (2) plain paths keep
 * working; (3) a glob whose directory does not exist credits nothing, no
 * crash; (4) a non-search command carrying a glob still credits nothing.
 *
 * Also pins PB1's detection unit: `grep -P` / `--perl-regexp` on darwin
 * must raise the Portability family; `rg -P` (the suggested remedy) and
 * off-darwin `grep -P` must not. PB1 was demoted to `warn` 2026-10-21, so
 * the e2e case in permission-gate.test.mjs expects a pass — these units
 * keep the detection itself from rotting behind the advisory default.
 *
 * Run: node --test tests/search-guard-locate.test.mjs   (exit 0 = all pass)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { searchCheck, searchedPathsFrom } from "../extensions/permission-gate/search-guard.ts";

const root = mkdtempSync(join(tmpdir(), "sg-locate-"));
mkdirSync(join(root, "src/utils"), { recursive: true });
mkdirSync(join(root, "src/hooks"), { recursive: true });
writeFileSync(join(root, "src/utils/realtime.js"), "x");
writeFileSync(join(root, "src/utils/keep.ts"), "x");
writeFileSync(join(root, "src/hooks/hook.js"), "x");
const rp = (p, cwd) => resolve(cwd ?? root, p);
const exists = (p) => existsSync(p);

test("glob token credits the files it matches", () => {
  const out = searchedPathsFrom(
    ["rg -n term src/utils/*.js"], undefined, rp, exists,
  );
  assert.deepEqual(out, [join(root, "src/utils/realtime.js")]);
});

test("plain path token still credited", () => {
  const out = searchedPathsFrom(
    ["rg -n term src/hooks/hook.js"], undefined, rp, exists,
  );
  assert.deepEqual(out, [join(root, "src/hooks/hook.js")]);
});

test("glob with missing directory credits nothing", () => {
  const out = searchedPathsFrom(
    ["rg -n term nope/*.js"], undefined, rp, exists,
  );
  assert.deepEqual(out, []);
});

test("glob in a non-search command credits nothing", () => {
  const out = searchedPathsFrom(
    ["cat src/utils/*.js"], undefined, rp, exists,
  );
  assert.deepEqual(out, []);
});

// ---- PB1 detection pins (rule demoted to warn 2026-10-21; detection stays) ----

test("searchCheck flags grep -P on darwin", () => {
  const r = searchCheck("grep -Prn 'foo\\.bar' src/", true);
  assert.ok(r?.startsWith("Portability (grep -P)"), `got: ${r}`);
});

test("searchCheck flags grep --perl-regexp on darwin", () => {
  const r = searchCheck("grep -n --perl-regexp 'x' src/", true);
  assert.ok(r?.startsWith("Portability (grep -P)"), `got: ${r}`);
});

test("searchCheck does not flag rg -P on darwin (the suggested remedy)", () => {
  assert.equal(searchCheck("rg -Prn 'x' src/", true), undefined);
});

test("searchCheck never raises the Portability family off darwin", () => {
  const r = searchCheck("grep -Prn 'x' src/", false);
  assert.ok(!r?.startsWith("Portability (grep -P)"), `got: ${r}`);
});

test.after(() => rmSync(root, { recursive: true, force: true }));
