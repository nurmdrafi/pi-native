import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { traceGate } from "../../extensions/permission-gate/index.ts";

// The trace exists to explain a coverage block the block text cannot: without
// the flag file it must stay silent, with it every record lands as one NDJSON
// line whose ts is filled in by the writer.
test("traceGate stays silent without the flag file and appends one NDJSON line with it", () => {
  const home = mkdtempSync(join(tmpdir(), "gate-trace-"));
  const prev = process.env.HOME;
  const cache = join(home, ".pi", "agent", ".cache");
  const log = join(home, ".pi", "agent", "logs", "gate-trace.ndjson");
  process.env.HOME = home;
  try {
    mkdirSync(cache, { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "logs"), { recursive: true });

    traceGate({ ev: "no-flag", path: "/tmp/x" });
    assert.equal(existsSync(log), false, "no flag → nothing written");

    writeFileSync(join(cache, "gate-trace.on"), "");
    traceGate({ ev: "certify-read", path: "/tmp/x", span: { start: 10, end: 12 } });

    const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ev, "certify-read");
    assert.deepEqual(rows[0].span, { start: 10, end: 12 });
    assert.match(rows[0].ts, /^\d{4}-\d\d-\d\dT/);
  } finally {
    process.env.HOME = prev;
  }
});
