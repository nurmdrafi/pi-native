import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BUDGET_BUILTIN_DEFAULTS,
  parseBudgetFrontmatter,
  resolveBudget,
  createSessionBudgetMeter,
  checkBudgetExceeded,
  createBudgetStopper,
} from "../../extensions/subagents/budget.ts";
import { parseStatusConfig } from "../../extensions/subagents/status.ts";
import { readSubagentLoadout, writeSubagentLoadout } from "../../extensions/subagents/session.ts";

describe("budget frontmatter parsing", () => {
  it("parses a nested budget block", () => {
    const fm = [
      "name: worker",
      "budget:",
      "  wallClockSec: 900",
      "  turns: 50",
      "  costUsd: 2.5",
    ].join("\n");
    assert.deepEqual(parseBudgetFrontmatter(fm), {
      wallClockSec: 900,
      turns: 50,
      costUsd: 2.5,
    });
  });

  it("returns undefined when no budget block exists", () => {
    assert.equal(parseBudgetFrontmatter("name: worker\ntools: read"), undefined);
  });

  it("fails fast on an unknown budget key", () => {
    const fm = "budget:\n  wallClockSec: 900\n  maxTokens: 5";
    assert.throws(() => parseBudgetFrontmatter(fm), /unsupported budget key/i);
  });

  it("fails fast on a non-numeric value", () => {
    assert.throws(
      () => parseBudgetFrontmatter("budget:\n  turns: many"),
      /budget\.turns must be a positive/i,
    );
  });

  it("fails fast on a non-positive value", () => {
    assert.throws(
      () => parseBudgetFrontmatter("budget:\n  costUsd: 0"),
      /budget\.costUsd must be a positive/i,
    );
  });

  it("fails fast when turns is not an integer", () => {
    assert.throws(
      () => parseBudgetFrontmatter("budget:\n  turns: 1.5"),
      /budget\.turns must be a positive integer/i,
    );
  });
});

describe("budget resolution", () => {
  it("falls back to builtin defaults when nothing is declared", () => {
    assert.deepEqual(resolveBudget(undefined, undefined, undefined), BUDGET_BUILTIN_DEFAULTS);
  });

  it("config defaults replace builtin defaults", () => {
    const resolved = resolveBudget(undefined, undefined, { wallClockSec: 600 });
    assert.equal(resolved.wallClockSec, 600);
    assert.equal(resolved.turns, BUDGET_BUILTIN_DEFAULTS.turns);
  });

  it("role budget overrides config defaults", () => {
    const resolved = resolveBudget({ turns: 10 }, { turns: 100 });
    assert.equal(resolved.turns, 10);
  });

  it("spawn override may lower but never raise past the ceiling", () => {
    const ceiling = resolveBudget({ turns: 40 }, { turns: 80 });
    assert.equal(ceiling.turns, 40);
    const lowered = resolveBudget({ turns: 40 }, { turns: 5 });
    assert.equal(lowered.turns, 5);
  });

  it("without a role ceiling the applicable default caps the spawn override", () => {
    const resolved = resolveBudget(undefined, { turns: 10_000 }, { turns: 100 });
    assert.equal(resolved.turns, 100);
  });

  it("spawn override without config still clamps to builtin defaults", () => {
    const resolved = resolveBudget(undefined, { costUsd: 1_000 });
    assert.equal(resolved.costUsd, BUDGET_BUILTIN_DEFAULTS.costUsd);
  });
});

describe("budget config parsing", () => {
  it("accepts a budgetDefaults section", () => {
    const config = parseStatusConfig({
      status: { enabled: true },
      budgetDefaults: { wallClockSec: 600, turns: 20 },
    });
    assert.deepEqual(config.budgetDefaults, { wallClockSec: 600, turns: 20 });
  });

  it("fails fast on a non-numeric budgetDefaults value", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true }, budgetDefaults: { turns: "many" } }),
      /budgetDefaults\.turns must be a positive/i,
    );
  });

  it("fails fast on an unsupported budgetDefaults key", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true }, budgetDefaults: { maxTokens: 5 } }),
      /budgetDefaults has unsupported key/i,
    );
  });
});

describe("session budget metering", () => {
  let dir = "";
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "budget-meter-"));
    return dir;
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  const assistantLine = (costTotal: number) =>
    JSON.stringify({
      type: "message",
      message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: costTotal } } },
    });

  it("meters turns and cost from assistant messages only", () => {
    const d = setup();
    try {
      const file = join(d, "session.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ type: "model_change", modelId: "x" }),
          assistantLine(0.5),
          JSON.stringify({ type: "message", message: { role: "user" } }),
          assistantLine(1.5),
          "",
        ].join("\n"),
      );
      const meter = createSessionBudgetMeter(file);
      const m = meter.update();
      assert.equal(m.turns, 2);
      assert.ok(Math.abs(m.costUsd - 2.0) < 1e-9);
    } finally {
      cleanup();
    }
  });

  it("meters incrementally: appended lines only add", () => {
    const d = setup();
    try {
      const file = join(d, "session.jsonl");
      writeFileSync(file, assistantLine(0.25) + "\n");
      const meter = createSessionBudgetMeter(file);
      const first = meter.update();
      assert.equal(first.turns, 1);
      // Append a partial line, then complete it on the next update.
      writeFileSync(file, assistantLine(0.75).slice(0, 20), { flag: "a" });
      assert.equal(meter.update().turns, 1);
      writeFileSync(file, assistantLine(0.75).slice(20) + "\n", { flag: "a" });
      const second = meter.update();
      assert.equal(second.turns, 2);
      assert.ok(Math.abs(second.costUsd - 1.0) < 1e-9);
    } finally {
      cleanup();
    }
  });

  it("skips malformed lines without crashing", () => {
    const d = setup();
    try {
      const file = join(d, "session.jsonl");
      writeFileSync(file, ["{not json", assistantLine(0.1), ""].join("\n"));
      const meter = createSessionBudgetMeter(file);
      const m = meter.update();
      assert.equal(m.turns, 1);
      assert.ok(Math.abs(m.costUsd - 0.1) < 1e-9);
    } finally {
      cleanup();
    }
  });

  it("tolerates a missing session file", () => {
    const meter = createSessionBudgetMeter(join(tmpdir(), "budget-meter-absent.jsonl"));
    assert.deepEqual(meter.update(), { turns: 0, costUsd: 0 });
  });
});

describe("loadout budget persistence", () => {
  it("round-trips the resolved budget through the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-loadout-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeSubagentLoadout(sessionFile, {
        agent: "worker",
        toolAllowlist: null,
        model: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: false,
        cwd: null,
        agentDir: null,
        budget: resolveBudget({ turns: 10 }, { turns: 5 }),
      });
      const loaded = readSubagentLoadout(sessionFile);
      assert.equal(loaded?.budget?.turns, 5);
      assert.equal(loaded?.budget?.wallClockSec, BUDGET_BUILTIN_DEFAULTS.wallClockSec);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads pre-budget snapshots (missing budget field) without failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-loadout-"));
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeSubagentLoadout(sessionFile, {
        agent: null,
        toolAllowlist: null,
        model: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: false,
        cwd: null,
        agentDir: null,
      });
      const loaded = readSubagentLoadout(sessionFile);
      assert.equal(loaded?.budget, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("budget breach check", () => {
  const budget = { wallClockSec: 100, turns: 2, costUsd: 1 };

  it("returns null under budget", () => {
    assert.equal(
      checkBudgetExceeded(budget, { turns: 1, costUsd: 0.1 }, 50_000),
      null,
    );
  });

  it("reports the first breached dimension: wall clock before turns before cost", () => {
    assert.deepEqual(
      checkBudgetExceeded(budget, { turns: 0, costUsd: 0 }, 100_000),
      { dimension: "wallClockSec", value: 100, limit: 100 },
    );
    assert.deepEqual(
      checkBudgetExceeded(budget, { turns: 2, costUsd: 0 }, 1_000),
      { dimension: "turns", value: 2, limit: 2 },
    );
    assert.deepEqual(
      checkBudgetExceeded(budget, { turns: 1, costUsd: 1.5 }, 1_000),
      { dimension: "costUsd", value: 1.5, limit: 1 },
    );
  });
});

describe("budget stopper", () => {
  const baseBreached = { dimension: "turns" as const, value: 2, limit: 2 };

  it("interrupts once, then kills after the grace period", () => {
    let interrupted = 0;
    let killed = 0;
    let now = 1_000;
    const stopper = createBudgetStopper({
      interrupt: () => {
        interrupted++;
      },
      kill: () => {
        killed++;
      },
      graceMs: 5_000,
      now: () => now,
    });
    stopper.onBreach(baseBreached);
    assert.equal(interrupted, 1);
    stopper.onTick(); // still inside grace
    assert.equal(killed, 0);
    now += 6_000;
    stopper.onTick();
    assert.equal(killed, 1);
    assert.equal(interrupted, 1);
  });

  it("does not kill when the child exits within the grace period", () => {
    let killed = 0;
    let now = 1_000;
    const stopper = createBudgetStopper({
      interrupt: () => {},
      kill: () => {
        killed++;
      },
      graceMs: 5_000,
      now: () => now,
    });
    stopper.onBreach(baseBreached);
    stopper.onExit();
    now += 6_000;
    stopper.onTick();
    assert.equal(killed, 0);
  });

  it("ignores ticks before any breach", () => {
    let killed = 0;
    const stopper = createBudgetStopper({
      interrupt: () => {},
      kill: () => {
        killed++;
      },
      graceMs: 5_000,
      now: () => 0,
    });
    stopper.onTick();
    assert.equal(killed, 0);
  });
});
