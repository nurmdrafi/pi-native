import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GATE_SHARE_BUCKETS,
  dayKey,
  failureStreakLeague,
  gateShareBucket,
  perCall,
  perCallRate,
  toolLeaderboard,
} from "../src/lib/derive.ts";

describe("gateShareBucket", () => {
  it("puts exact zero in the no-gate-tokens bucket", () => {
    assert.equal(gateShareBucket(0), 0);
  });

  it("keeps each boundary inside the lower bucket", () => {
    assert.equal(gateShareBucket(0.1), 1);
    assert.equal(gateShareBucket(5), 1);
    assert.equal(gateShareBucket(5.1), 2);
    assert.equal(gateShareBucket(10), 2);
    assert.equal(gateShareBucket(10.1), 3);
    assert.equal(gateShareBucket(20), 3);
  });

  it("sends anything above 20 to the high bucket", () => {
    assert.equal(gateShareBucket(20.1), 4);
    assert.equal(gateShareBucket(99.9), 4);
  });

  it("labels five ascending buckets ending above 20", () => {
    assert.equal(GATE_SHARE_BUCKETS.length, 5);
    assert.equal(GATE_SHARE_BUCKETS[0], "0");
    assert.equal(GATE_SHARE_BUCKETS[4], ">20");
  });
});

describe("dayKey", () => {
  it("formats the local calendar day as a zero-padded key", () => {
    // Built from local parts, so the expected day holds in any timezone.
    const localNoon = new Date(2026, 0, 9, 12, 0, 0).toISOString();
    assert.equal(dayKey(localNoon), "2026-01-09");
  });

  it("round-trips an ISO timestamp back to its local calendar day", () => {
    const earlyLocalMorning = new Date(2026, 10, 5, 6, 0, 0).toISOString();
    assert.equal(dayKey(earlyLocalMorning), "2026-11-05");
  });

  it("zero-pads single-digit months and days", () => {
    const localNoon = new Date(2026, 2, 1, 12, 0, 0).toISOString();
    assert.equal(dayKey(localNoon), "2026-03-01");
  });
});

describe("perCall", () => {
  it("uses two digits from a dime up", () => {
    assert.equal(perCall(0.1), "$0.10");
    assert.equal(perCall(0.42), "$0.42");
    assert.equal(perCall(1.5), "$1.50");
  });

  it("keeps a third digit under a dime, including zero", () => {
    assert.equal(perCall(0.099), "$0.099");
    assert.equal(perCall(0.05), "$0.050");
    assert.equal(perCall(0), "$0.000");
  });

  it("groups thousands like the money formatter", () => {
    assert.equal(perCall(1234.5), "$1,234.50");
  });
});

describe("perCallRate", () => {
  it("divides summed cost by summed calls", () => {
    assert.ok(Math.abs(perCallRate(4.2, 10) - 0.42) < 1e-9);
    assert.ok(Math.abs(perCallRate(0.5, 3) - 1 / 6) < 1e-9);
  });

  it("returns null on zero calls — no rate from no calls", () => {
    assert.equal(perCallRate(3.5, 0), null);
  });

  it("returns null on negative calls — bad sums carry no rate", () => {
    assert.equal(perCallRate(3.5, -2), null);
  });
});

describe("toolLeaderboard", () => {
  it("prices each recorded tool once — cost never counted twice", () => {
    const rows = toolLeaderboard([
      { tools: { read: 2, write: 1 }, toolCosts: { read: 5, write: 3 } },
    ]);
    assert.deepEqual(rows, [
      { name: "read", calls: 2, cost: 5 },
      { name: "write", calls: 1, cost: 3 },
    ]);
  });

  it("adds cost-only tools once with zero calls", () => {
    const rows = toolLeaderboard([{ tools: {}, toolCosts: { deploy: 7 } }]);
    assert.deepEqual(rows, [{ name: "deploy", calls: 0, cost: 7 }]);
  });

  it("accumulates calls and cost across sessions", () => {
    const rows = toolLeaderboard([
      { tools: { read: 2 }, toolCosts: { read: 5 } },
      { tools: { read: 3, write: 1 }, toolCosts: { read: 4, write: 2 } },
    ]);
    assert.deepEqual(rows, [
      { name: "read", calls: 5, cost: 9 },
      { name: "write", calls: 1, cost: 2 },
    ]);
  });

  it("sorts by cost desc, then calls desc", () => {
    const rows = toolLeaderboard([
      {
        tools: { low: 1, tieFew: 1, tieMany: 3, high: 1 },
        toolCosts: { low: 1, tieFew: 5, tieMany: 5, high: 9 },
      },
    ]);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["high", "tieMany", "tieFew", "low"],
    );
  });

  it("returns an empty league for no sessions", () => {
    assert.deepEqual(toolLeaderboard([]), []);
  });
});

describe("failureStreakLeague", () => {
  it("orders worst maxFailureStreak first", () => {
    const rows = failureStreakLeague([
      { sessionId: "mid", agent: { maxFailureStreak: 3, failureStreakCalls: 9 } },
      { sessionId: "worst", agent: { maxFailureStreak: 7, failureStreakCalls: 2 } },
      { sessionId: "best", agent: { maxFailureStreak: 1, failureStreakCalls: 40 } },
    ]);
    assert.deepEqual(
      rows.map((s) => s.sessionId),
      ["worst", "mid", "best"],
    );
  });

  it("breaks max-streak ties on failureStreakCalls desc", () => {
    const rows = failureStreakLeague([
      { sessionId: "fewCalls", agent: { maxFailureStreak: 4, failureStreakCalls: 5 } },
      { sessionId: "manyCalls", agent: { maxFailureStreak: 4, failureStreakCalls: 12 } },
    ]);
    assert.deepEqual(
      rows.map((s) => s.sessionId),
      ["manyCalls", "fewCalls"],
    );
  });

  it("keeps clean sessions out — zero streak is no league entry", () => {
    const rows = failureStreakLeague([
      { sessionId: "clean", agent: { maxFailureStreak: 0, failureStreakCalls: 0 } },
      { sessionId: "failed", agent: { maxFailureStreak: 2, failureStreakCalls: 3 } },
    ]);
    assert.deepEqual(
      rows.map((s) => s.sessionId),
      ["failed"],
    );
  });

  it("returns an empty league for no sessions", () => {
    assert.deepEqual(failureStreakLeague([]), []);
  });
});
