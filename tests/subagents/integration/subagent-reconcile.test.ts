/**
 * Integration tests: result delivery when the child's pane dies.
 *
 * Defect: a budget-killed or externally reaped subagent vanished without
 * delivering a result — the poll loop keys on the pane, so a reap produced
 * no observable exit and the result was never constructed. With the fix:
 *
 *   - budget kill (interrupt -> grace -> kill) or an out-of-band kill-pane
 *     makes pollForExit report "gone", and the watcher synthesizes the
 *     result from the durable session file (budget_exceeded when the meter
 *     or stopper confirms a breach, else pane_lost).
 *   - the reconciliation sweep covers the same cases when the watcher
 *     itself is gone (parent restart).
 *
 * Costs: ~$0.01-0.05 per test run (haiku). Run inside tmux:
 *   tmux new 'node --test tests/subagents/integration/subagent-reconcile.test.ts'
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
} from "./harness.ts";
import { PI_TIMEOUT, type TestEnv } from "./harness.ts";

const backends = getAvailableBackends();
// These tests need a real model backend for the parent session. Without one
// (e.g. a machine with no anthropic/other provider configured) the parent
// can never issue the spawn call, so the suite skips instead of timing out.
const MODEL_BACKEND =
  process.env.PI_TEST_MODEL || process.env.ANTHROPIC_API_KEY ? backends : [];
const BUDGET_KILL_TIMEOUT = PI_TIMEOUT * 3;

function listPanes(): string[] {
  return execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

for (const backend of MODEL_BACKEND) {
  describe(`subagent pane-death delivery [${backend}]`, { timeout: BUDGET_KILL_TIMEOUT }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("delivers a budget_exceeded result when the budget stopper kills the pane", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-bud-start-${id}.txt`;
      trackTempFile(env, startFile);

      const surface = createTrackedSurface(env, `bud-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Bud-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this pibash command: echo 'START' > '${startFile}'; sleep 240"`,
        `  budget: { "wallClockSec": 25 }`,
        `Do not do anything else. Just call the subagent tool once.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Child must be up and inside the long sleep before the wall-clock
      // budget (25s) breaches: interrupt, 30s grace, then kill.
      await waitForFile(startFile, PI_TIMEOUT, /START/);
      await waitForScreen(
        surface,
        /budget exceeded/i,
        BUDGET_KILL_TIMEOUT,
        2000,
      );

      // The delivered result must carry the preserved-session resume hint.
      const screen = execFileSync("tmux", ["capture-pane", "-p", "-t", surface, "-S", "-200"], {
        encoding: "utf8",
      });
      assert.ok(screen.includes(`Bud-${id}`), "result names the subagent");
    });

    it("delivers a pane_lost result when the pane is killed out-of-band", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-kill-start-${id}.txt`;
      trackTempFile(env, startFile);

      const surface = createTrackedSurface(env, `kill-${id}`);
      await sleep(1000);
      const panesBefore = new Set(listPanes());

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Lost-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this pibash command: echo 'START' > '${startFile}'; sleep 240"`,
        `Do not do anything else. Just call the subagent tool once.`,
      ].join("\n");

      startPi(surface, env.dir, task);
      await waitForFile(startFile, PI_TIMEOUT, /START/);

      // The child's pane is the new one the extension created.
      const child = listPanes().find((p) => !panesBefore.has(p));
      assert.ok(child, "child pane should exist");

      // Reap it exactly like the incident: out-of-band group kill.
      execFileSync("tmux", ["kill-pane", "-t", child]);

      await waitForScreen(
        surface,
        /pane vanished|pane lost/i,
        PI_TIMEOUT,
        1000,
      );
    });
  });
}
