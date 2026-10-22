#!/usr/bin/env node
/**
 * Large-output regression suite for pibash (Step 8,
 * research/pibash-implementation-plan.md; fixtures per §4 of
 * research/pibash-large-output.md).
 *
 * Pins current behavior on the 1 MB fixture class — fast enough for the unit
 * suite: byte-exact child accounting, spill_bytes == child_bytes, and the
 * model-visible envelope staying O(envelope) under ENVELOPE_CAP_BYTES.
 * Peak-RSS assertions are best-effort (skipped without /usr/bin/time) and
 * record the accumulator's by-design scaling, not an O(1) goal.
 *
 * The 10 / 100 MB classes and the full metrics report live in the bench
 * harness: node custom-tools/pibash/bench-large-output.mjs
 * (writes benchmark/runs/pibash-large-output-<date>.md).
 *
 * Run: node --test tests/pibash-large-output.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FIXTURES,
  ENVELOPE_CAP_BYTES,
  RSS_CAP_BYTES,
  runDaemonFixture,
  measureRssOneshot,
} from "../custom-tools/pibash/bench-large-output.mjs";

const CLASS_1MB = FIXTURES.filter((f) => f.sizeClass === 1);

test("1 MB class: child bytes are byte-exact and spill equals child bytes", async () => {
  assert.ok(CLASS_1MB.length >= 3, "expected uniform/giant/stderr fixtures at 1 MB");
  for (const fixture of CLASS_1MB) {
    const m = await runDaemonFixture(fixture);
    assert.equal(m.childBytes, fixture.expectedChildBytes, `${fixture.name}: child_bytes`);
    assert.equal(m.truncated, true, `${fixture.name}: must spill (exceeds the 2000-line/50 KB accumulator)`);
    assert.equal(m.spillBytes, m.childBytes, `${fixture.name}: spill_bytes != child_bytes`);
    assert.equal(m.exitCode, 0, `${fixture.name}: exit code`);
  }
});

test("1 MB class: model-visible envelope stays under the pinned cap", async () => {
  for (const fixture of CLASS_1MB) {
    const m = await runDaemonFixture(fixture);
    assert.ok(
      m.envelopeBytes <= ENVELOPE_CAP_BYTES,
      `${fixture.name}: envelope_bytes ${m.envelopeBytes} > cap ${ENVELOPE_CAP_BYTES}`,
    );
  }
});

test("1 MB class: peak RSS under the pinned cap (best-effort, needs /usr/bin/time)", async (t) => {
  let sawRss = false;
  for (const fixture of CLASS_1MB) {
    const m = await measureRssOneshot(fixture);
    if (m?.peakRssBytes == null) continue;
    sawRss = true;
    assert.ok(
      m.peakRssBytes <= RSS_CAP_BYTES[fixture.sizeClass],
      `${fixture.name}: peak rss ${m.peakRssBytes} > cap ${RSS_CAP_BYTES[fixture.sizeClass]}`,
    );
  }
  if (!sawRss) t.skip("/usr/bin/time unavailable — RSS assertion skipped (recorded, not failed)");
});
