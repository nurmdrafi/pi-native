#!/usr/bin/env node
/**
 * Differential compaction audit (2026-10-28): Rust truth vs TS consumer.
 *
 * Runs the REAL bin/piread (PI_READ_COMPRESS=1) over fixture shapes and
 * windows, then feeds the live envelope — rendered content plus
 * `compaction.omissions[]` — to the permission gate's coverage walk
 * (`renderedCoverageFromBlocks`, winEnd-anchored). The two layers must
 * agree: the walk honors the structured ranges exactly, spans+gaps tile
 * the window with no holes, and the marker count matches the omission
 * count. Any drift here is the false-block class of 2026-10-27
 * (gap boundaries off by one), caught cross-implementation instead of
 * inside one.
 *
 * Run: node --test tests/parity/piread-compaction-walk.test.mjs (also via npm test)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderedCoverageFromBlocks } from "../../extensions/permission-gate/rules/read-coverage.ts";

const BIN = process.env.PI_READ_BIN ?? join(process.env.HOME, ".pi/agent/bin/piread");

/** Deterministic fixtures: every shape class that has bitten before. */
function fixtures() {
  const mk = (name, n, line) => ({
    name,
    lines: Array.from({ length: n }, (_, i) => line(i + 1)),
  });
  return [
    mk("plain", 240, (i) => `line ${i}`),
    mk("blank-heavy", 240, (i) => (i % 4 === 0 && i !== 240 ? "" : `row ${i}`)),
    mk("long-lines", 160, (i) => (i % 5 === 0 ? `${"w".repeat(300)} ${i}` : `line ${i}`)),
    mk("repetitive", 160, (i) => `repeat ${Math.floor(i / 6)}`),
    mk("unicode", 160, (i) => `café — ligne ${i} — €${i % 97} →`),
    mk("mixed", 240, (i) =>
      i % 7 === 0 ? "" : i % 5 === 0 ? `${"y".repeat(240)} ${i}` : `mix ${i} é €`,
    ),
  ];
}

function readWindow(path, offset, limit) {
  const r = spawnSync(
    BIN,
    ["--path", path, "--offset", String(offset), "--limit", String(limit)],
    { env: { ...process.env, PI_READ_COMPRESS: "1" }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `piread exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

const markerRe = /^\[\.\.\. omitted \d+ chars \/ \d+ lines \.\.\.]$/;

test("differential: Rust omissions[] agree with the TS walk over the real binary", { skip: !existsSync(BIN) && `missing ${BIN}` }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "piread-walk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let checked = 0;
  for (const fx of fixtures()) {
    const path = join(dir, fx.name);
    const body = fx.lines.join("\n");
    writeFileSync(path, body);
    const total = fx.lines.length;
    for (const [offset, limit] of [
      [1, total],
      [Math.max(1, Math.floor(total / 3)), 130],
      [Math.floor(total / 2), 12],
    ]) {
      const env = readWindow(path, offset, limit);
      const content = env.content;
      const comp = env.compaction;
      const tag = `${fx.name} offset=${offset} limit=${limit}`;
      if (!comp || comp.strategy === "none") {
        assert.ok(!content.split("\n").some((l) => markerRe.test(l.trim())), `no marker without compaction (${tag})`);
        continue;
      }
      const omissions = comp.omissions ?? [];
      const markers = content.split("\n").filter((l) => markerRe.test(l.trim()));
      assert.equal(markers.length, omissions.length, `marker count (${tag})`);

      const winStart = offset;
      const winEnd = Math.min(offset + limit - 1, total);
      const got = renderedCoverageFromBlocks(
        [{ type: "text", text: content }],
        winStart,
        omissions,
        winEnd,
      );
      assert.ok(got, `walk produced coverage (${tag})`);
      // The structured ranges must win: the anchored walk agrees with them.
      assert.deepEqual(
        got.gaps,
        omissions.map((o) => ({ start: o.startLine, end: o.endLine })),
        `walk gaps === structured spans (${tag})`,
      );
      // Spans and gaps tile the window exactly — no hole, no overlap.
      const all = [...got.spans, ...got.gaps].sort((a, b) => a.start - b.start);
      let cursor = winStart;
      for (const s of all) {
        assert.equal(s.start, cursor, `tiling hole/overlap at ${cursor} (${tag})`);
        cursor = s.end + 1;
      }
      assert.equal(cursor, winEnd + 1, `tiling reaches window end (${tag})`);
      // First window line always renders (head-heavy split, non-partial).
      if (!comp.partial) {
        assert.equal(content.split("\n")[0], fx.lines[offset - 1], `head line renders (${tag})`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 10, `differential covered ${checked} compacted windows`);
});

test("differential: window ending in an empty line — fully accounted, exact tiling, no widening", { skip: !existsSync(BIN) && `missing ${BIN}` }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "piread-walk-eol-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Line 120 is empty: the raw path counts it, so compaction must too
  // (no-gap contract, 2026-10-28). The tail renders it (content ends with
  // the blank) and the walk must agree with the structured span exactly —
  // spans+gaps tile the window with no widening and no hole.
  const lines = Array.from({ length: 120 }, (_, i) =>
    (i + 1) % 4 === 0 ? "" : `row ${i + 1}`,
  );
  const path = join(dir, "trailing-blank");
  writeFileSync(path, lines.join("\n"));
  const env = readWindow(path, 1, 120);
  assert.ok(env.compaction, "compaction engaged");
  const omissions = env.compaction.omissions;
  assert.equal(omissions.length, 1);
  const got = renderedCoverageFromBlocks(
    [{ type: "text", text: env.content }],
    1,
    omissions,
    120,
  );
  assert.deepEqual(
    got.gaps,
    omissions.map((o) => ({ start: o.startLine, end: o.endLine })),
    "structured spans honored exactly — no widening",
  );
  const all = [...got.spans, ...got.gaps].sort((a, b) => a.start - b.start);
  let cursor = 1;
  for (const s of all) {
    assert.equal(s.start, cursor, `tiling at ${cursor}`);
    cursor = s.end + 1;
  }
  assert.equal(cursor, 121, "tiling reaches winEnd + 1");
});
