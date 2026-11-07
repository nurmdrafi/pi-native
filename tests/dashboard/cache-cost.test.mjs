// Cache-cost governance: a billable prompt-prefix refresh (cacheWrite > 0 on a
// turn) emits exactly one warning line into the session audit trail, and a
// cache miss (cacheRead === 0 with input > 0) emits one notice naming the
// approximate re-billed token count. Detection is client-side over the detail
// wire (detailFor ships per-turn input/cacheRead/cacheWrite); the session
// detail header renders both counters beside the existing cache hit rate.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { cacheCostAudit } = await import(
  pathToFileURL(join(ROOT, "dashboard/src/lib/cache-cost.ts")).href
);

/** Detail-wire turn shape (types.ts TurnDetail): server fills every numeric
 *  field, but detection must tolerate missing/null fields all the same. */
const turn = (over = {}) => ({
  i: 0,
  ts: "2026-11-07T16:00:00.000Z",
  model: "test-model",
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
  ...over,
});

describe("cacheCostAudit — refresh warnings", () => {
  it("emits exactly one warn line per billable prefix refresh", () => {
    const turns = [
      turn({ i: 0, input: 40, cacheRead: 9000, cacheWrite: 0 }),
      turn({ i: 1, input: 20, cacheRead: 9000, cacheWrite: 8231 }),
    ];
    const audit = cacheCostAudit(turns);
    const warns = audit.lines.filter((l) => l.level === "warn");
    assert.equal(warns.length, 1);
    assert.equal(audit.refreshes, 1);
    assert.match(warns[0].text, /8,231/);
    assert.match(warns[0].text, /t2/);
  });

  it("emits one warn line per refresh turn — never merged, never duplicated", () => {
    const turns = [
      turn({ i: 0, input: 10, cacheRead: 500, cacheWrite: 1200 }),
      turn({ i: 1, input: 10, cacheRead: 500, cacheWrite: 3400 }),
      turn({ i: 2, input: 10, cacheRead: 500, cacheWrite: 0 }),
    ];
    const audit = cacheCostAudit(turns);
    assert.equal(audit.refreshes, 2);
    assert.equal(audit.lines.filter((l) => l.level === "warn").length, 2);
  });

  it("is pure: recomputing the same turns yields the identical trail", () => {
    const turns = [turn({ i: 0, input: 30, cacheRead: 0, cacheWrite: 700 })];
    assert.deepEqual(cacheCostAudit(turns), cacheCostAudit(turns));
  });
});

describe("cacheCostAudit — miss notices", () => {
  it("emits one notice naming the approximate re-billed token count", () => {
    const turns = [turn({ i: 0, input: 4496, cacheRead: 0, cacheWrite: 0 })];
    const audit = cacheCostAudit(turns);
    const notices = audit.lines.filter((l) => l.level === "notice");
    assert.equal(notices.length, 1);
    assert.equal(audit.misses, 1);
    assert.equal(audit.missTokens, 4496);
    assert.match(notices[0].text, /~4,496/);
  });

  it("counts input plus cacheWrite as the re-billed total on a cold miss", () => {
    const turns = [turn({ i: 0, input: 100, cacheRead: 0, cacheWrite: 2000 })];
    const audit = cacheCostAudit(turns);
    assert.equal(audit.missTokens, 2100);
    assert.match(audit.lines.find((l) => l.level === "notice").text, /~2,100/);
  });

  it("emits nothing for warm turns", () => {
    const turns = [turn({ i: 0, input: 40, cacheRead: 9000, cacheWrite: 0 })];
    const audit = cacheCostAudit(turns);
    assert.deepEqual(audit.lines, []);
    assert.equal(audit.refreshes, 0);
    assert.equal(audit.misses, 0);
    assert.equal(audit.missTokens, 0);
  });
});

describe("cacheCostAudit — counters and edge shapes", () => {
  it("aggregates refreshes, misses and re-billed tokens across a session", () => {
    const turns = [
      turn({ i: 0, input: 1000, cacheRead: 0, cacheWrite: 5000 }), // warn + notice
      turn({ i: 1, input: 20, cacheRead: 6000, cacheWrite: 300 }), // warn only
      turn({ i: 2, input: 800, cacheRead: 0, cacheWrite: 0 }), // notice only
      turn({ i: 3, input: 20, cacheRead: 6000, cacheWrite: 0 }), // warm
    ];
    const audit = cacheCostAudit(turns);
    assert.equal(audit.refreshes, 2);
    assert.equal(audit.misses, 2);
    assert.equal(audit.missTokens, 1000 + 5000 + 800);
    assert.equal(audit.lines.length, 4);
  });

  it("treats missing or non-finite usage fields as zero", () => {
    const audit = cacheCostAudit([
      { i: 0 },
      { i: 1, input: Number.NaN, cacheRead: undefined, cacheWrite: null },
    ]);
    assert.deepEqual(audit.lines, []);
    assert.equal(audit.refreshes, 0);
    assert.equal(audit.misses, 0);
  });

  it("returns an empty trail for an empty session", () => {
    const audit = cacheCostAudit([]);
    assert.deepEqual(audit.lines, []);
    assert.equal(audit.refreshes, 0);
    assert.equal(audit.misses, 0);
    assert.equal(audit.missTokens, 0);
  });

  it("orders the trail by turn position regardless of event kind", () => {
    const turns = [
      turn({ i: 0, input: 10, cacheRead: 0, cacheWrite: 0 }),
      turn({ i: 1, input: 10, cacheRead: 400, cacheWrite: 60 }),
    ];
    const audit = cacheCostAudit(turns);
    assert.deepEqual(audit.lines.map((l) => l.level), ["notice", "warn"]);
  });
});

describe("SessionDetail wiring", () => {
  const source = readFileSync(
    join(ROOT, "dashboard/src/components/SessionDetail.tsx"),
    "utf8"
  );

  it("derives the audit from the detail turns", () => {
    assert.match(source, /cacheCostAudit\(detail\.turns\)/);
  });

  it("renders both counters beside the existing cache hit rate", () => {
    const hit = source.indexOf("cache {detail.summary.cacheHitRate}%");
    assert.ok(hit >= 0, "cache hit-rate stat missing");
    const window = source.slice(hit, hit + 700);
    assert.match(window, /cacheAudit\.refreshes/);
    assert.match(window, /cacheAudit\.misses/);
    assert.match(window, /cacheAudit\.missTokens/);
  });

  it("renders the audit trail lines in a dedicated tab", () => {
    assert.match(source, /value="audit"/);
    assert.match(source, /cacheAudit\.lines/);
  });
});
