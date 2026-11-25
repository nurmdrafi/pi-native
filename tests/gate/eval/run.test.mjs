/** gate:eval metrics persistence tests (2026-11-19): the eval's final metrics
 * object must land in the harness-watch metrics ledger — one {ts,key,n} NDJSON
 * record per scalar under eval:<name> keys, nulls and nested objects skipped —
 * so nightly runs build the pre_edit_read_rate series the loop's gate-change
 * decision waits on. A missing final newline in the target is healed before
 * appending, per the append-probe invariant. Run: node --test tests/gate/eval/run.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalMetricRecords, appendEvalMetrics } from "./run.mjs";

test("evalMetricRecords: one eval:<name> record per finite number; nulls and objects skipped", () => {
  const recs = evalMetricRecords(
    { pre_edit_read_rate: 0.7627, one_shot_recovery: null, block_fail: 1, by_family: { a: 1 }, fp_rate: 0.2561 },
    "2026-11-19T07:30:00Z",
  );
  assert.deepEqual(recs, [
    { ts: "2026-11-19T07:30:00Z", key: "eval:pre_edit_read_rate", n: 0.7627 },
    { ts: "2026-11-19T07:30:00Z", key: "eval:block_fail", n: 1 },
    { ts: "2026-11-19T07:30:00Z", key: "eval:fp_rate", n: 0.2561 },
  ]);
});

test("appendEvalMetrics: appends NDJSON lines, creates parent dirs, heals a missing final newline", () => {
  const file = join(mkdtempSync(join(tmpdir(), "eval-metrics-")), "nested/metrics.ndjson");
  assert.equal(appendEvalMetrics(file, { tokens_per_task: 646 }, "T1"), 1);
  let lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { ts: "T1", key: "eval:tokens_per_task", n: 646 });

  writeFileSync(file, JSON.stringify({ ts: "T0", key: "x", n: 1 })); // no trailing newline
  appendEvalMetrics(file, { unread_blocks: 489 }, "T2");
  lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2); // two records — the append never glues onto the last line
  assert.deepEqual(JSON.parse(lines[1]), { ts: "T2", key: "eval:unread_blocks", n: 489 });

  assert.equal(appendEvalMetrics(file, { by_family: {}, one_shot_recovery: null }, "T3"), 0); // nothing scalar → no write
  assert.equal(readFileSync(file, "utf8").split("\n").filter(Boolean).length, 2);
});
