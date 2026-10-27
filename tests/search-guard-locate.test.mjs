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
 * C4 hit-anchored seeding (2026-10-26 session audit, research/gate-locate-
 * first-seed.md): `searchedPathsFrom` read command argv only, so a file rg's
 * OUTPUT named nine times (`__tests__/…/orderApi.test.ts:158:`) never entered
 * the set and the compliant 140-line read was blocked. searchHitsFrom parses
 * rg-family result text into path → hit lines; hitAnchorsWindow allows a wide
 * read iff it covers a reported hit line (path-only results: any window).
 * Fail-closed: only rg-family results are parsed, and every candidate path
 * must exist on disk after cwd resolution.
 *
 * Run: node --test tests/search-guard-locate.test.mjs   (exit 0 = all pass)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  effectiveCwd,
  hitAnchorsWindow,
  isSearchSegment,
  searchCheck,
  searchHitsFrom,
  searchedPathsFrom,
} from "../extensions/permission-gate/search-guard.ts";

const root = mkdtempSync(join(tmpdir(), "sg-locate-"));
mkdirSync(join(root, "src/utils"), { recursive: true });
mkdirSync(join(root, "src/hooks"), { recursive: true });
writeFileSync(join(root, "src/utils/realtime.js"), "x");
writeFileSync(join(root, "src/utils/keep.ts"), "x");
writeFileSync(join(root, "src/hooks/hook.js"), "x");
writeFileSync(join(root, "plain.md"), "x");
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

// ---- C4 hit-anchored seeding (argv-blind spot) ----

test("rg hit-line output seeds the file with its hit line", () => {
  const out = searchHitsFrom(
    "src/utils/realtime.js:12:export function x() {\nno match here\nsrc/utils/keep.ts:34:  const y = 1;\n",
    undefined, rp, exists,
  );
  assert.deepEqual(out.get(rp("src/utils/realtime.js")), new Set([12]));
  assert.deepEqual(out.get(rp("src/utils/keep.ts")), new Set([34]));
});

test("column form path:line:col: seeds the line, not the column", () => {
  const out = searchHitsFrom(
    "src/utils/realtime.js:12:5:export function x() {", undefined, rp, exists,
  );
  assert.deepEqual(out.get(rp("src/utils/realtime.js")), new Set([12]));
});

test("bare path-only line (rg -l / fd output) seeds an empty set", () => {
  const out = searchHitsFrom(
    "src/utils/realtime.js\nsrc/hooks/hook.js\n", undefined, rp, exists,
  );
  assert.deepEqual(out.get(rp("src/utils/realtime.js")), new Set());
  assert.ok(out.has(rp("src/hooks/hook.js")));
});

test("rg -c count lines seed nothing (colon-bearing, prose-ambiguous)", () => {
  const out = searchHitsFrom("src/utils/realtime.js:7\n", undefined, rp, exists);
  assert.equal(out.size, 0);
});

test("prose quoting a file never seeds", () => {
  const out = searchHitsFrom(
    [
      "the block said foo.md:12 in the message",
      "see src/utils/realtime.js in the docs below",
      "error: nothing matched",
      "123 matched\n456 files contained matches",
    ].join("\n"),
    undefined, rp, exists,
  );
  assert.equal(out.size, 0);
});

test("nonexistent path in output seeds nothing (fail-closed)", () => {
  const out = searchHitsFrom(
    "src/utils/ghost.ts:12:x\nsrc/utils/ghost2.js\n", undefined, rp, exists,
  );
  assert.equal(out.size, 0);
});

test("basename-only hit seeds only when it resolves under cwd", () => {
  const seeded = searchHitsFrom("plain.md:12:x", undefined, rp, exists);
  assert.deepEqual(seeded.get(rp("plain.md")), new Set([12]));
  const missed = searchHitsFrom("nosuchbasename.js:12:x", undefined, rp, exists);
  assert.equal(missed.size, 0);
});

test("absolute output path seeded as-is", () => {
  const out = searchHitsFrom(
    `${join(root, "src/hooks/hook.js")}:3:x`, undefined, rp, exists,
  );
  assert.deepEqual(out.get(join(root, "src/hooks/hook.js")), new Set([3]));
});

test("scan caps at the first 4 KB", () => {
  const out = searchHitsFrom(
    "x".repeat(4096) + "\nsrc/utils/keep.ts:99:x", undefined, rp, exists,
  );
  assert.equal(out.size, 0);
});

test("effectiveCwd follows cd segments relative to the session cwd", () => {
  assert.equal(
    effectiveCwd(["cd src/utils", "rg -n x ."], undefined, rp),
    rp("src/utils"),
  );
  assert.equal(effectiveCwd(["rg -n x"], root, rp), root);
  assert.equal(
    effectiveCwd(["cd " + join(root, "src"), "rg x"], root, rp),
    join(root, "src"),
  );
});

test("effectiveCwd skips flag, bare and quoted cd forms (fail-closed)", () => {
  assert.equal(effectiveCwd(["cd -", "rg x"], root, rp), root);
  assert.equal(effectiveCwd(["cd", "rg x"], root, rp), root);
  assert.equal(effectiveCwd(['cd "quoted dir"', "rg x"], root, rp), root);
});

test("isSearchSegment mirrors the searchedPathsFrom family", () => {
  assert.ok(isSearchSegment("rg -n x src"));
  assert.ok(isSearchSegment("fd .ts"));
  assert.ok(isSearchSegment("grep -rn x src"));
  assert.ok(!isSearchSegment("cat file"));
  assert.ok(!isSearchSegment("echo src/utils/realtime.js"));
  // any-token match, same as searchedPathsFrom has always done
  assert.ok(isSearchSegment("echo rg"));
});

test("hitAnchorsWindow: overlap allows, empty set allows all, miss blocks", () => {
  const hits = new Map([
    [rp("src/utils/realtime.js"), new Set([12, 40])],
    [rp("src/hooks/hook.js"), new Set()],
  ]);
  assert.ok(hitAnchorsWindow(hits, rp("src/utils/realtime.js"), { start: 1, end: 140 }));
  assert.ok(hitAnchorsWindow(hits, rp("src/utils/realtime.js"), { start: 40, end: 60 }));
  assert.ok(!hitAnchorsWindow(hits, rp("src/utils/realtime.js"), { start: 400, end: 540 }));
  assert.ok(hitAnchorsWindow(hits, rp("src/hooks/hook.js"), { start: 400, end: 540 }));
  assert.ok(!hitAnchorsWindow(hits, rp("src/utils/keep.ts"), { start: 1, end: 140 }));
});

test.after(() => rmSync(root, { recursive: true, force: true }));
