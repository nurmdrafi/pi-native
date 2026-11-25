import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderedCoverageFromBlocks } from "../../../extensions/permission-gate/rules/read-coverage.ts";

/**
 * AB-2 compaction contract (agent-behaviour audit 2026-11-18): for a piread
 * result with structured omissions, the gate's walk over the RENDERED text
 * must derive exactly the structured ranges — rendered == structured. The
 * corpus freezes real (file, window, omissions, rendered-text) tuples from
 * the audited window (141 findings across 69 sessions; 19 mismatch rows +
 * 4 passing controls here). Regression: the walk's end-anchoring widened
 * the final gap whenever the forward walk fell short of the window end,
 * so every consumer tiling from structured ranges computed wrong coverage.
 */
const corpus = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/compaction-corpus.json", import.meta.url)),
    "utf8",
  ),
);

test("corpus is representative (>=15 mismatch rows, >=5 sessions)", () => {
  const mismatch = corpus.rows.filter((r) => r.mismatch).length;
  assert.ok(
    mismatch >= 15,
    `expected >=15 mismatch rows, corpus has ${mismatch}`,
  );
  assert.ok(new Set(corpus.rows.map((r) => r.session)).size >= 5);
});

test("rendered coverage gaps equal structured omissions on every corpus row", () => {
  const failures = [];
  for (const r of corpus.rows) {
    const winStart = r.offset ?? 1;
    const winEnd =
      r.offset != null && r.limit != null ? winStart + r.limit - 1 : undefined;
    const got = renderedCoverageFromBlocks(
      [{ type: "text", text: r.rendered }],
      winStart,
      r.omissions,
      winEnd,
    );
    const want = r.omissions.map((o) => ({
      start: o.startLine,
      end: o.endLine,
    }));
    const gotGaps = got ? got.gaps : undefined;
    try {
      assert.deepEqual(gotGaps, want);
    } catch {
      failures.push(
        `${r.session} ${r.file} [${winStart},${winEnd}] structured ${JSON.stringify(want)} derived ${JSON.stringify(gotGaps)}`,
      );
    }
  }
  assert.deepEqual(failures, []);
});
