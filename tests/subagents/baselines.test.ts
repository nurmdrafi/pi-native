import "./test-env.ts";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test__ } from "../../extensions/subagents/index.ts";

/** Minimal history row factory — only the fields the baseline and duplicate
 *  helpers read. */
function makeRecord(o: {
  id?: string;
  ts?: number;
  name: string;
  summary?: string;
  durationMs?: number;
  costUsd?: number;
}) {
  return {
    id: o.id ?? o.name,
    name: o.name,
    ts: o.ts ?? 0,
    files_changed: [],
    summary: o.summary ?? "",
    ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
    ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}),
  };
}

describe("agent baselines from history", () => {
  it("computes median/p90 elapsed and median cost per agent, ignoring name suffixes", () => {
    const rows = [
      makeRecord({ name: "worker-1", durationMs: 60_000, costUsd: 0.1 }),
      makeRecord({ name: "worker-2", durationMs: 120_000, costUsd: 0.2 }),
      makeRecord({ name: "worker", durationMs: 300_000, costUsd: 0.3 }),
      makeRecord({ name: "worker-4", durationMs: 600_000, costUsd: 0.4 }),
      makeRecord({ name: "worker-5", durationMs: 900_000, costUsd: 0.5 }),
    ];
    const b = __test__.agentBaselineFor(rows, "worker");
    assert.ok(b, "baseline exists for five usable rows");
    assert.equal(b.count, 5);
    assert.equal(b.medianMs, 300_000);
    assert.equal(b.p90Ms, 900_000);
    assert.equal(b.medianCostUsd, 0.3);
  });

  it("reports no baseline under three usable rows", () => {
    const two = [
      makeRecord({ name: "worker-1", durationMs: 60_000 }),
      makeRecord({ name: "worker-2", durationMs: 120_000 }),
    ];
    assert.equal(__test__.agentBaselineFor(two, "worker"), null);
    // Five rows but only two carry a usable durationMs.
    const sparse = [
      ...two,
      makeRecord({ name: "worker-3" }),
      makeRecord({ name: "worker-4" }),
      makeRecord({ name: "worker-5" }),
    ];
    assert.equal(__test__.agentBaselineFor(sparse, "worker"), null);
  });

  it("groups rows by the agent recovered from the child name", () => {
    const rows = [
      makeRecord({ name: "scout", durationMs: 60_000 }),
      makeRecord({ name: "scout-2", durationMs: 120_000 }),
      makeRecord({ name: "scout-3", durationMs: 180_000 }),
      makeRecord({ name: "worker-1", durationMs: 900_000 }),
    ];
    const b = __test__.agentBaselineFor(rows, "scout");
    assert.ok(b);
    assert.equal(b.count, 3);
    assert.equal(b.medianMs, 120_000);
  });

  it("strips exactly one trailing -N suffix from history names", () => {
    assert.equal(__test__.agentOfHistoryName("worker-3"), "worker");
    assert.equal(__test__.agentOfHistoryName("worker"), "worker");
    assert.equal(__test__.agentOfHistoryName("ui-verifier"), "ui-verifier");
    assert.equal(__test__.agentOfHistoryName("worker-2-3"), "worker-2");
  });
});

describe("baseline ack line", () => {
  it("formats the spawn-ack typical line exactly", () => {
    const line = __test__.formatBaselineLine("worker", {
      count: 5,
      medianMs: 300_000,
      p90Ms: 900_000,
      medianCostUsd: 0.34,
    });
    assert.equal(line, "typical for `worker`: median 5m · p90 15m · $0.34");
  });

  it("omits the cost segment when no row carried a cost", () => {
    const line = __test__.formatBaselineLine("worker", {
      count: 3,
      medianMs: 300_000,
      p90Ms: 900_000,
    });
    assert.equal(line.includes("$"), false);
    assert.equal(line, "typical for `worker`: median 5m · p90 15m");
  });

  it("clamps sub-minute figures up to 1m", () => {
    const line = __test__.formatBaselineLine("worker", {
      count: 3,
      medianMs: 30_000,
      p90Ms: 90_000,
      medianCostUsd: 0.01,
    });
    assert.equal(line, "typical for `worker`: median 1m · p90 2m · $0.01");
  });
});

describe("near-identical task matching", () => {
  it("normalizes case, punctuation, and whitespace", () => {
    assert.equal(__test__.tasksNearIdentical("Fix the  login-bug!", "fix the login bug"), true);
  });

  it("accepts token-level near-identical texts and rejects different ones", () => {
    const a = "refactor the inbox drain to skip corrupt lines and keep the last row per id";
    const b = "refactor the inbox drain to skip corrupt lines keeping the last row per id";
    assert.equal(__test__.tasksNearIdentical(a, b), true);
    assert.equal(
      __test__.tasksNearIdentical(a, "write a README section about the spawn queue"),
      false,
    );
  });

  it("matches a task contained in a longer summary verbatim", () => {
    const task = "make the prior-work injection block carry artifact references for history rows";
    const summary =
      "Task completed. make the prior-work injection block carry artifact references for history rows, " +
      "caps enforced after the addition. Two tests added.";
    assert.equal(__test__.tasksNearIdentical(task, summary), true);
  });
});

describe("duplicate spawn detection", () => {
  const now = 1_800_000_000_000;

  it("warns when a near-identical task is already running under the same agent", () => {
    const note = __test__.findDuplicateSpawn(
      { agent: "worker", task: "fix the login bug" },
      [
        {
          name: "worker-2",
          agent: "worker",
          task: "Fix the login-bug",
          startTime: now - 5 * 60_000,
        },
      ],
      [],
      now,
    );
    assert.ok(note);
    assert.match(note, /already running as "worker-2"/);
    assert.match(note, /5 min ago/);
  });

  it("warns from history when an identical task ran recently, citing the summary head", () => {
    const note = __test__.findDuplicateSpawn(
      { agent: "worker", task: "add baseline metrics to the spawn acknowledgement text" },
      [],
      [
        makeRecord({
          name: "worker-3",
          ts: now - 12 * 60_000,
          summary:
            "add baseline metrics to the spawn acknowledgement text. Changed index.ts and added tests; suite green.",
        }),
      ],
      now,
    );
    assert.ok(note);
    assert.match(note, /ran 12 min ago/);
    assert.match(note, /add baseline metrics to the spawn acknowledgement text/);
  });

  it("stays silent for other agents or unrelated tasks", () => {
    const otherAgent = __test__.findDuplicateSpawn(
      { agent: "scout", task: "fix the login bug" },
      [{ name: "worker-2", agent: "worker", task: "fix the login bug", startTime: now }],
      [],
      now,
    );
    assert.equal(otherAgent, null);
    const otherTask = __test__.findDuplicateSpawn(
      { agent: "worker", task: "write the changelog entry" },
      [{ name: "worker-2", agent: "worker", task: "fix the login bug", startTime: now }],
      [makeRecord({ name: "worker", ts: now, summary: "fixed the queue drain race" })],
      now,
    );
    assert.equal(otherTask, null);
  });
});

describe("p90 flag on live children", () => {
  const history = [
    makeRecord({ name: "worker-1", durationMs: 60_000 }),
    makeRecord({ name: "worker-2", durationMs: 120_000 }),
    makeRecord({ name: "worker-3", durationMs: 180_000 }),
  ];

  it("flags a running child past its agent's p90, not one under it", () => {
    const flagged = __test__.annotatePastP90(
      [{ name: "worker-1", agent: "worker", phase: "running", elapsedSec: 842 }],
      history,
    );
    assert.equal(flagged[0].pastP90Min, 3);
    const under = __test__.annotatePastP90(
      [{ name: "worker-1", agent: "worker", phase: "running", elapsedSec: 10 }],
      history,
    );
    assert.equal(under[0].pastP90Min, undefined);
  });

  it("leaves queued children and baseline-less agents untouched", () => {
    const out = __test__.annotatePastP90(
      [
        { name: "worker-q", agent: "worker", phase: "queued" },
        { name: "scout-1", agent: "scout", phase: "running", elapsedSec: 9_999 },
      ],
      history,
    );
    assert.equal(out[0].pastP90Min, undefined);
    assert.equal(out[1].pastP90Min, undefined);
  });

  it("renders the flag in the compact live-children line", () => {
    const line = __test__.formatChildMetricsLine({
      name: "worker-1",
      phase: "running",
      elapsedSec: 842,
      pastP90Min: 3,
    });
    assert.match(line, /past p90 \(3m\)/);
  });
});
