// Per-rule gate counts on the dashboard: the guard writes no state of its
// own, so the counts come from the tags it writes in front of every reason in
// the session transcript. A block is an error result whose head is a reason; a
// note is a tag in the appended block of a successful result. Prose that merely
// mentions a tag (a command printing one) must not be counted.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { gateTagCounts, gateSummary, aggregateSessions, GATE_RULE_META } = await import(
  join(ROOT, "dashboard/scripts/data.mjs")
);
const { RULE_IDS } = await import(join(ROOT, "extensions/permission-gate/loader.ts"));
const gateConfig = JSON.parse(
  (await import("node:fs")).readFileSync(
    join(ROOT, "extensions/permission-gate/config.json"),
    "utf8",
  ),
);

const line = (o) => JSON.stringify(o);
// Real transcripts wrap each entry: {type:"message", message:{role, content, …}}.
const call = (id, name, args) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
});
// Real transcripts wrap each entry: {type:"message", timestamp, message:{role,
// content, …}} — the timestamp rides the wrapper, not the message.
const result = (id, isError, texts, toolName, ts) => ({
  type: "message",
  timestamp: ts,
  message: {
    role: "toolResult",
    toolCallId: id,
    toolName,
    isError,
    content: texts.map((text) => ({ type: "text", text })),
  },
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "gate-tags-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      line(call("c1", "pibash", { command: "cat f" })),
      line(
        result("c1", true, [
          "Hygiene (Reader-bypass): read windows go through piread — not cat/sed; a view command prints lines but is not the read tool.",
        ], "pibash"),
      ),
      line(call("c2", "piread", { path: "f" })),
      line(
        result("c2", false, [
          "file body the command printed",
          "Search (Scope): scope it. Hygiene (Error-swallow): drop '|| true'.",
        ], "piread"),
      ),
      // A command's own output mentioning a tag in its only text block: not a
      // gate note, must stay uncounted.
      line(result("c3", false, ["Hygiene (Reader-bypass): quoted from the source file"], "pibash")),
      // Same, behind real output: the last block is the command's, not a note.
      line(call("c4", "pibash", { command: "rg Reader-bypass" })),
      line(result("c4", false, ["src/rules.ts:137: Hygiene (Reader-bypass)"], "pibash")),
    ].join("\n") + "\n",
  );
  return { dir, file };
}

test("every configured rule has a human name, its id and a group", () => {
  const keys = Object.keys(gateConfig.rules);
  assert.equal(keys.length, 29, "the gate ships 29 rules");
  const missing = keys.filter((k) => !GATE_RULE_META[k]);
  assert.deepEqual(missing, [], `no dashboard meta for: ${missing.join(", ")}`);
  const drifted = keys.filter((k) => GATE_RULE_META[k].code !== RULE_IDS[k]);
  assert.deepEqual(drifted, [], `rule id drifted from loader.ts for: ${drifted.join(", ")}`);
  const badLabel = keys.filter(
    (k) => typeof GATE_RULE_META[k].label !== "string" || GATE_RULE_META[k].label.length < 8,
  );
  assert.deepEqual(badLabel, [], `a human label is missing or too terse: ${badLabel.join(", ")}`);
});

test("gateSummary carries the human name, id and group per rule", () => {
  const gate = gateSummary({}, gateConfig.rules, { gateTags: {} });
  const rows = gate.rules.filter((r) => r.id === "readerBypass" || r.id === "findFirst");
  const se2 = rows.find((r) => r.id === "readerBypass");
  assert.equal(se2.code, "SE2");
  assert.match(se2.label, /piread/);
  assert.equal(se2.group, "tokens");
  const ss3 = rows.find((r) => r.id === "findFirst");
  assert.equal(ss3.code, "SS3");
  assert.equal(ss3.group, "search");
});

test("tag counts carry the day each event happened", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-days-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    [
      line(call("c1", "pibash", { command: "cat f" })),
      line(
        result(
          "c1",
          true,
          ["Hygiene (Reader-bypass): read windows go through piread, not cat/sed."],
          "pibash",
          "2026-10-01T09:00:00.000Z",
        ),
      ),
      line(call("c2", "piread", { path: "f" })),
      line(
        result(
          "c2",
          false,
          ["body", "Search (Scope): scope every search."],
          "piread",
          "2026-10-02T09:30:00.000Z",
        ),
      ),
      // No timestamp on the message: the event still counts, just no day.
      line(call("c3", "pibash", { command: "rg x" })),
      line(
        result(
          "c3",
          true,
          ["Portability (grep -P): no grep -P on BSD."],
          "pibash",
          undefined,
        ),
      ),
    ].join("\n"),
  );
  try {
    const counts = gateTagCounts(file);
    assert.deepEqual(counts["Hygiene (Reader-bypass)"].byDay, {
      "2026-10-01": { block: 1, warn: 0 },
    });
    assert.deepEqual(counts["Search (Scope)"].byDay, {
      "2026-10-02": { block: 0, warn: 1 },
    });
    assert.equal(counts["Portability (grep -P)"].block, 1, "timestamp-less event still counts");
    assert.equal(counts["Portability (grep -P)"].byDay, undefined, "and lands on no day");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gate summary aligns a per-rule day trend to its day list", () => {
  const rules = { readerBypass: "warn", reReadGuard: "error", reReadConsume: "warn" };
  const gate = gateSummary({}, rules, {
    gateTags: {
      "Hygiene (Reader-bypass)": { block: 2, warn: 0, tools: {} },
      "Token Economy (Re-read)": { block: 3, warn: 2, tools: {} },
    },
    gateByDay: {
      "2026-10-02": { "Token Economy (Re-read)": { block: 2, warn: 2 } },
      "2026-10-01": {
        "Hygiene (Reader-bypass)": { block: 2, warn: 0 },
        "Token Economy (Re-read)": { block: 1, warn: 0 },
      },
    },
  });
  assert.deepEqual(gate.days, ["2026-10-01", "2026-10-02"], "days sort ascending");
  const byId = Object.fromEntries(gate.rules.map((r) => [r.id, r]));
  assert.deepEqual(
    byId.readerBypass.trend,
    [
      [2, 0],
      [0, 0],
    ],
    "days without the rule hold zeros, so indexes stay aligned",
  );
  assert.deepEqual(
    byId.reReadGuard.trend,
    [
      [1, 0],
      [2, 0],
    ],
    "blocks go to the error-severity sibling on every day",
  );
  assert.deepEqual(
    byId.reReadConsume.trend,
    [
      [0, 0],
      [0, 2],
    ],
    "warns go to the teaching sibling on every day",
  );
});

test("gate day rollup clips days outside the date window", () => {
  const mk = (gateTags, firstTs) => ({
    sessionId: firstTs,
    project: "p",
    turns: 1,
    cost: 0,
    toolCalls: 1,
    tools: {},
    toolCosts: {},
    blocksByTool: {},
    firstTs,
    lastTs: firstTs,
    gateTags,
  });
  const tags = {
    "Hygiene (Reader-bypass)": {
      block: 3,
      warn: 0,
      tools: {},
      byDay: {
        "2026-09-30": { block: 1, warn: 0 },
        "2026-10-01": { block: 1, warn: 0 },
        "2026-10-02": { block: 1, warn: 0 },
      },
    },
  };
  const both = aggregateSessions([mk(tags, "2026-09-30T00:00:00Z")]);
  assert.deepEqual(Object.keys(both.gateByDay).sort(), ["2026-09-30", "2026-10-01", "2026-10-02"]);
  const clipped = aggregateSessions([mk(tags, "2026-09-30T00:00:00Z")], {
    fromDay: "2026-10-01",
    toDay: "2026-10-01",
  });
  assert.deepEqual(clipped.gateByDay, {
    "2026-10-01": { "Hygiene (Reader-bypass)": { block: 1, warn: 0 } },
  });
});

test("per-rule avoided spend weights each tool's blocks by that tool's average call cost", () => {
  const rules = { readerBypass: "warn", searchScope: "warn", errorSwallow: "warn" };
  const gate = gateSummary({}, rules, {
    gateTags: {
      "Hygiene (Reader-bypass)": {
        block: 3,
        warn: 4,
        tools: {},
        toolsBlock: { pibash: 2, piread: 1 },
        toolsWarn: { piread: 4 },
      },
      "Search (Scope)": { block: 1, warn: 0, tools: {}, toolsBlock: { unknowntool: 1 } },
    },
    toolAvgCost: { pibash: 0.1, piread: 0.02 },
    globalAvgCost: 0.05,
  });
  const byId = Object.fromEntries(gate.rules.map((r) => [r.id, r]));
  assert.equal(
    byId.readerBypass.avoidedSpend,
    0.22,
    "2 pibash blocks at 0.10 + 1 piread block at 0.02; warns cost nothing",
  );
  assert.equal(
    byId.searchScope.avoidedSpend,
    0.05,
    "a tool with no observed cost falls back to the global average",
  );
  const quiet = gate.rules.find((r) => r.blocks + r.warns === 0);
  assert.equal(quiet?.avoidedSpend, 0, "a rule that never fired avoided nothing");
});

test("every firing rule carries the transcript tags that feed it", () => {
  const gate = gateSummary({}, { reReadGuard: "error", reReadConsume: "warn" }, {
    gateTags: {
      "Token Economy (Re-read)": { block: 1, warn: 0, tools: {} },
      "Token Economy (Reading)": { block: 1, warn: 0, tools: {} },
    },
  });
  const byId = Object.fromEntries(gate.rules.map((r) => [r.id, r]));
  assert.deepEqual(
    byId.reReadGuard.tags,
    ["Token Economy (Re-read)", "Token Economy (Reading)"],
    "live and retired tags both feed the row, so both must be searchable",
  );
  assert.deepEqual(byId.reReadConsume.tags, ["Token Economy (Re-read)"]);
});

test("tag counts separate blocks from notes and attribute the tool", () => {
  const { dir, file } = fixture();
  try {
    const counts = gateTagCounts(file);
    assert.equal(counts["Hygiene (Reader-bypass)"]?.block, 1, "error head is a block");
    assert.equal(counts["Hygiene (Reader-bypass)"]?.warn, 0, "no note for that tag");
    assert.equal(counts["Hygiene (Reader-bypass)"]?.tools?.pibash, 1, "tool attributed");
    assert.equal(counts["Search (Scope)"]?.warn, 1, "note counted");
    assert.equal(counts["Hygiene (Error-swallow)"]?.warn, 1, "second tag in one note counted");
    const total = Object.values(counts).reduce((n, c) => n + c.block + c.warn, 0);
    assert.equal(total, 3, "command prose mentioning a tag is not a gate event");
    assert.equal(counts["Search (Scope)"]?.toolsWarn?.piread, 1, "warn credited to its tool");
    assert.equal(counts["Search (Scope)"]?.toolsBlock?.piread, undefined, "no block for a note");
    assert.equal(counts["Hygiene (Reader-bypass)"]?.toolsBlock?.pibash, 1, "block credited to its tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retired tags land on live rules and internal errors get their own row", () => {
  const gate = gateSummary({}, gateConfig.rules, {
    gateTags: {
      "Token Economy (Command output)": { block: 3, warn: 0, tools: { bash: 3 } },
      "Search (node_modules)": { block: 2, warn: 0, tools: { bash: 2 } },
      "Token Economy (Reading)": { block: 1, warn: 0, tools: { piread: 1 } },
      "Permission Gate (Self-modify)": { block: 1, warn: 0, tools: { pibash: 1 } },
      "Permission Gate (Internal)": { block: 1, warn: 0, tools: {} },
    },
  });
  const byId = Object.fromEntries(gate.rules.map((r) => [r.id, r]));
  assert.equal(byId.outputCap.blocks, 3, "output-cap legacy tags roll up");
  assert.equal(byId.searchScope.blocks, 2);
  assert.equal(byId.reReadGuard.blocks, 1);
  assert.equal(byId.destructiveConfirm.blocks, 1);
  assert.equal(byId.__internal.code, "INT", "internal catch has its own row");
  assert.equal(byId.__internal.severity, "—");
  assert.deepEqual(gate.unmappedTags, [], "nothing observed is left unclaimed");
});

test("gateSummary rolls tags onto config rules and flags unmapped ones", () => {
  const { dir, file } = fixture();
  try {
    const rules = {
      readerBypass: "warn",
      searchScope: "warn",
      errorSwallow: "warn",
      reReadGuard: "error",
      reReadConsume: "warn",
    };
    const gate = gateSummary({}, rules, {
      gateTags: {
        ...gateTagCounts(file),
        "Token Economy (Re-read)": { block: 2, warn: 5, tools: { piread: 7 } },
        "Some Unknown (Tag)": { block: 4, warn: 0, tools: {} },
      },
    });
    const byId = Object.fromEntries(gate.rules.map((r) => [r.id, r]));
    assert.equal(byId.readerBypass.blocks, 1);
    assert.equal(byId.readerBypass.warns, 0);
    assert.equal(byId.readerBypass.topTool, "pibash");
    assert.equal(byId.searchScope.warns, 1);
    assert.equal(byId.errorSwallow.warns, 1);
    // Shared tag: the error-severity sibling takes the blocks, the teaching
    // rule takes the notes, so no call is counted twice.
    assert.equal(byId.reReadGuard.blocks, 2);
    assert.equal(byId.reReadGuard.warns, 0);
    assert.equal(byId.reReadConsume.warns, 5);
    assert.equal(byId.reReadConsume.blocks, 0);
    assert.deepEqual(gate.unmappedTags, [{ tag: "Some Unknown (Tag)", blocks: 4, warns: 0 }]);
    // Busiest rule first: the dashboard reads top-down and stops when it has
    // enough, so the ordering is part of the contract.
    assert.equal(gate.rules[0].id, "reReadConsume");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
