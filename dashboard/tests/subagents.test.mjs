import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The pure helpers live inside the component module, which node cannot
// import directly (JSX + bare package specifiers). The block between the
// sentinel comments is dependency-free TypeScript, so it is copied verbatim
// into a temp .ts module and imported: node's built-in type stripping runs
// the real shipped source, not a copy of its logic.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, "../src/components/SubagentsTab.tsx"),
  "utf8",
);
const BEGIN = "/* subagent-helpers:begin";
const END = "/* subagent-helpers:end";
const beginAt = source.indexOf(BEGIN);
const endAt = source.indexOf(END);
assert.ok(beginAt >= 0, "helper block start sentinel missing in SubagentsTab.tsx");
assert.ok(endAt > beginAt, "helper block end sentinel missing in SubagentsTab.tsx");
const block = source.slice(beginAt, source.indexOf("*/", endAt) + 2);

const dir = mkdtempSync(join(tmpdir(), "subagents-helpers-"));
const modPath = join(dir, "helpers.ts");
writeFileSync(modPath, block);
after(() => rmSync(dir, { recursive: true, force: true }));

const { errorRate, errorRateLabel, sessionsForAgent, sortAgentRows } = await import(
  pathToFileURL(modPath).href
);

const agents = [
  { agent: "scout", spawns: 5, messages: 50, errors: 1, avgLatencyMs: 1200 },
  { agent: "worker", spawns: 10, messages: 40, errors: 4, avgLatencyMs: 300 },
  { agent: "quiet", spawns: 1, messages: 0, errors: 0, avgLatencyMs: 0 },
];

const sessions = [
  {
    sessionId: "s-aaaa1111",
    project: "/proj/alpha",
    cost: 1.5,
    subagents: {
      byAgent: [{ agent: "scout", spawns: 1, messages: 4, errors: 0, avgLatencyMs: 100 }],
    },
  },
  {
    sessionId: "s-bbbb2222",
    project: "/proj/beta",
    cost: 0.25,
    subagents: {
      byAgent: [
        {
          agent: "worker",
          spawns: 3,
          messages: 9,
          errors: 1,
          avgLatencyMs: 200,
          p50LatencyMs: 180,
          p95LatencyMs: 260,
          spawnToFirstMsgMs: 400,
        },
        { agent: "scout", spawns: 2, messages: 20, errors: 0, avgLatencyMs: 50 },
      ],
    },
  },
  {
    sessionId: "s-cccc3333",
    project: "/proj/gamma",
    cost: 9,
    subagents: { byAgent: [] },
  },
];

describe("errorRate", () => {
  it("returns errors over messages as a ratio", () => {
    assert.equal(errorRate(2, 10), 0.2);
    assert.equal(errorRate(1, 50), 0.02);
  });

  it("returns null when no messages were routed", () => {
    assert.equal(errorRate(0, 0), null);
    assert.equal(errorRate(3, 0), null);
  });

  it("returns 0 for errors with traffic, not null", () => {
    assert.equal(errorRate(0, 100), 0);
  });
});

describe("errorRateLabel", () => {
  it("formats whole percentages without decimals", () => {
    assert.equal(errorRateLabel(0, 100), "0%");
    assert.equal(errorRateLabel(2, 10), "20%");
    assert.equal(errorRateLabel(1, 50), "2%");
  });

  it("keeps one decimal below ten percent", () => {
    assert.equal(errorRateLabel(3, 1000), "0.3%");
    assert.equal(errorRateLabel(34, 1000), "3.4%");
  });

  it("dash when the rate is undefined", () => {
    assert.equal(errorRateLabel(0, 0), "-");
  });
});

describe("sortAgentRows", () => {
  it("sorts numeric columns descending and ascending", () => {
    assert.deepEqual(
      sortAgentRows(agents, "spawns", "desc").map((a) => a.agent),
      ["worker", "scout", "quiet"],
    );
    assert.deepEqual(
      sortAgentRows(agents, "spawns", "asc").map((a) => a.agent),
      ["quiet", "scout", "worker"],
    );
  });

  it("sorts the agent column alphabetically", () => {
    assert.deepEqual(
      sortAgentRows(agents, "agent", "asc").map((a) => a.agent),
      ["quiet", "scout", "worker"],
    );
  });

  it("sorts by error rate with null treated as zero", () => {
    assert.deepEqual(
      sortAgentRows(agents, "errorRate", "desc").map((a) => a.agent),
      ["worker", "scout", "quiet"],
    );
  });

  it("sorts latency ascending", () => {
    assert.deepEqual(
      sortAgentRows(agents, "avgLatencyMs", "asc").map((a) => a.agent),
      ["quiet", "worker", "scout"],
    );
  });

  it("sorts optional percentile and lag columns with absent values as zero", () => {
    const rows = [
      { agent: "a", spawns: 1, messages: 1, errors: 0, avgLatencyMs: 10, p95LatencyMs: 900 },
      { agent: "b", spawns: 1, messages: 1, errors: 0, avgLatencyMs: 10 },
      {
        agent: "c",
        spawns: 1,
        messages: 1,
        errors: 0,
        avgLatencyMs: 10,
        p95LatencyMs: 400,
        spawnToFirstMsgMs: 5000,
      },
    ];
    assert.deepEqual(
      sortAgentRows(rows, "p95LatencyMs", "desc").map((a) => a.agent),
      ["a", "c", "b"],
    );
    assert.deepEqual(
      sortAgentRows(rows, "spawnToFirstMsgMs", "asc").map((a) => a.agent),
      ["a", "b", "c"],
    );
  });

  it("returns a new array and leaves the input order intact", () => {
    const input = [...agents];
    sortAgentRows(agents, "messages", "desc");
    assert.deepEqual(agents, input);
  });
});

describe("sessionsForAgent", () => {
  it("returns matching sessions busiest first with their own counts", () => {
    const rows = sessionsForAgent(sessions, "scout");
    assert.deepEqual(
      rows.map((r) => r.sessionId),
      ["s-bbbb2222", "s-aaaa1111"],
    );
    assert.equal(rows[0].project, "/proj/beta");
    assert.equal(rows[0].spawns, 2);
    assert.equal(rows[0].messages, 20);
    assert.equal(rows[0].cost, 0.25);
    assert.equal(rows[1].cost, 1.5);
  });

  it("carries per-session numbers for each matched agent", () => {
    const rows = sessionsForAgent(sessions, "worker");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].spawns, 3);
    assert.equal(rows[0].messages, 9);
  });

  it("empty for an agent no session used", () => {
    assert.deepEqual(sessionsForAgent(sessions, "ghost"), []);
  });

  it("carries per-session errors and latency detail for the drill-in", () => {
    const rows = sessionsForAgent(sessions, "worker");
    assert.equal(rows[0].errors, 1);
    assert.equal(rows[0].avgLatencyMs, 200);
    assert.equal(rows[0].p50LatencyMs, 180);
    assert.equal(rows[0].p95LatencyMs, 260);
    assert.equal(rows[0].spawnToFirstMsgMs, 400);
  });

  it("leaves optional drill-in metrics undefined when the session lacks samples", () => {
    for (const r of sessionsForAgent(sessions, "scout")) {
      assert.equal(r.p50LatencyMs, undefined);
      assert.equal(r.p95LatencyMs, undefined);
      assert.equal(r.spawnToFirstMsgMs, undefined);
    }
  });
});
