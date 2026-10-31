import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { burnRate, sortedSkillRows } from "../src/lib/burn.ts";

const ev = (ts, cost) => ({ ts, cost });

describe("burnRate", () => {
  it("computes the hourly rate over the full span when windowMs is null", () => {
    const r = burnRate(
      [
        ev("2026-10-31T00:00:00Z", 0.5),
        ev("2026-10-31T00:01:00Z", 0.25),
        ev("2026-10-31T00:05:00Z", 0.25),
      ],
      null,
    );
    assert.ok(r);
    assert.ok(Math.abs(r.hourly - 12) < 1e-9);
    assert.equal(r.spanMs, 300_000);
    assert.equal(r.events, 3);
  });

  it("restricts the rolling window to events newer than newest - windowMs", () => {
    const r = burnRate(
      [
        ev("2026-10-31T00:00:00Z", 0.5),
        ev("2026-10-31T00:01:00Z", 0.25),
        ev("2026-10-31T00:19:00Z", 0.05),
        ev("2026-10-31T00:20:00Z", 0.25),
        ev("2026-10-31T00:21:00Z", 0.1),
      ],
      900_000,
    );
    assert.ok(r);
    assert.ok(Math.abs(r.hourly - 12) < 1e-9); // 0.4 over 2m
    assert.equal(r.spanMs, 120_000);
    assert.equal(r.events, 3);
  });

  it("returns null below the minimum event count", () => {
    const r = burnRate(
      [ev("2026-10-31T00:00:00Z", 1), ev("2026-10-31T00:05:00Z", 1)],
      null,
    );
    assert.equal(r, null);
  });

  it("returns null when the span is under the minimum", () => {
    const r = burnRate(
      [
        ev("2026-10-31T00:00:00Z", 1),
        ev("2026-10-31T00:00:30Z", 1),
        ev("2026-10-31T00:01:30Z", 1),
      ],
      null,
    );
    assert.equal(r, null);
  });

  it("drops events without a usable timestamp", () => {
    const r = burnRate(
      [
        ev(null, 5),
        ev("garbage", 5),
        ev("2026-10-31T00:00:00Z", 1),
        ev("2026-10-31T00:10:00Z", 1),
      ],
      null,
    );
    assert.equal(r, null); // only 2 usable events
  });

  it("excludes events exactly at the window cutoff", () => {
    const r = burnRate(
      [
        ev("2026-10-31T00:06:00Z", 1),
        ev("2026-10-31T00:15:00Z", 1),
        ev("2026-10-31T00:21:00Z", 1),
      ],
      900_000,
    );
    assert.equal(r, null); // 00:06 sits on the cutoff, leaving 2 events
  });
});

describe("sortedSkillRows", () => {
  it("sorts by uses descending with a name tiebreak", () => {
    assert.deepEqual(sortedSkillRows({ b: 2, a: 5, c: 2 }), [
      ["a", 5],
      ["b", 2],
      ["c", 2],
    ]);
  });

  it("returns an empty list for missing skills", () => {
    assert.deepEqual(sortedSkillRows(undefined), []);
    assert.deepEqual(sortedSkillRows(null), []);
    assert.deepEqual(sortedSkillRows({}), []);
  });
});
