// Snapshot assembly on the server: the header's staleness readout wants the
// server process's own start time, so an operator can spot a dashboard
// process that predates the server code in the checkout (modules load once
// at start) instead of chasing blank charts.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { snapshotFor } = await import(join(ROOT, "dashboard/scripts/dashboard.mjs"));

const base = () => ({
  raw: [],
  sessions: [],
  active: [],
  generatedAt: "2026-10-30T12:00:00.000Z",
});

test("snapshot carries the server process start time", () => {
  const snap = snapshotFor(base(), { from: null, to: null });
  assert.equal(typeof snap.serverStartedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(snap.serverStartedAt)));
});

test("start time is stable across snapshots from one process", () => {
  const a = snapshotFor(base(), { from: null, to: null });
  const b = snapshotFor(base(), { from: "2026-10-29T00:00:00Z", to: null });
  assert.equal(a.serverStartedAt, b.serverStartedAt);
});
