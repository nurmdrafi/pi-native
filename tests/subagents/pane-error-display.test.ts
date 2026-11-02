/**
 * Pane-failure error row.
 *
 * Defect: when a subagent restart ended in a tmux pane-not-found failure,
 * the raw multiplexer error ("can't find pane: %N") was sanitized out of
 * every user-visible surface — the diagnostic toast and the model-facing
 * text both describe the loss without the multiplexer's own words — so the
 * transcript never showed the failure the way provider errors (a red
 * "Error: ..." row) are shown.
 *
 * Contract under test:
 * - a pane-not-found restart failure emits a custom message typed
 *   subagent_pane_error, display:true, triggerTurn falsy, whose content
 *   carries the [pi-subagents] tag and the RAW "can't find pane: %N" text
 *   (from the error's stderr when present);
 * - finalizeLostSubagent emits that row on its restart-failure catch while
 *   keeping the existing loss-result delivery;
 * - the subagent_pane_error renderer draws an error-colored row prefixed
 *   "Error: " — the same shape as the provider error row.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeSubagentLoadout } from "../../extensions/subagents/session.ts";
import { __test__ } from "../../extensions/subagents/index.ts";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

/** execFile-shaped tmux failure, as split-window rejects with it. */
function paneNotFoundErr(): Error & { stderr: string } {
  return Object.assign(
    new Error("Command failed: tmux split-window -d -h -t %424242\ncan't find pane: %424242"),
    { stderr: "can't find pane: %424242" },
  ) as Error & { stderr: string };
}

type SentMessage = {
  msg: Record<string, unknown>;
  opts: Record<string, unknown> | undefined;
};

function recordingPi() {
  const sent: SentMessage[] = [];
  return {
    sent,
    sendMessage(msg: Record<string, unknown>, opts?: Record<string, unknown>) {
      sent.push({ msg, opts });
    },
    registerMessageRenderer() {},
  };
}

function writeSessionFixture(dir: string): string {
  const file = join(dir, "child.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "sess-fixture-pane-err", cwd: dir }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Partial analysis done." }],
        usage: { cost: { total: 0.01 } },
      },
    }),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function fakeRunning(sessionFile: string, cwd: string, artifactDir: string) {
  return {
    id: "pane-err-1",
    name: "mapmaker",
    task: "do a thing",
    agent: "worker",
    surface: "%424242",
    startTime: Date.now() - 60_000,
    sessionFile,
    interactive: false,
    autoExit: true,
    cwd,
    parentArtifactDir: artifactDir,
    statusState: { source: "pi", startTimeMs: Date.now() - 60_000, currentKind: "running" },
  } as never;
}

const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("pane-failure error row", () => {
  beforeEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
  });
  afterEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
    mock.restoreAll();
  });

  it("reportPaneErrorRow sends a display-only custom message with the raw pane error", () => {
    const pi = recordingPi();
    __test__.reportPaneErrorRow(pi as never, paneNotFoundErr(), `restart of "mapmaker" failed`);

    assert.equal(pi.sent.length, 1, "one message sent");
    const { msg, opts } = pi.sent[0];
    assert.equal(msg.customType, "subagent_pane_error");
    assert.equal(msg.display, true);
    assert.match(String(msg.content), /^\[pi-subagents\] restart of "mapmaker" failed: /);
    assert.match(String(msg.content), /can't find pane: %424242/);
    assert.equal((opts as Record<string, unknown> | undefined)?.triggerTurn ?? false, false);
  });

  it("prefers the error's stderr and falls back to its message", () => {
    const pi = recordingPi();
    const noStderr = new Error("can't find pane: %9");
    __test__.reportPaneErrorRow(pi as never, noStderr, "ctx");
    assert.match(String(pi.sent[0].msg.content), /can't find pane: %9/);
  });

  it("finalizeLostSubagent emits the row on a pane-not-found restart failure and still delivers the loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pane-err-finalize-"));
    const sessionFile = writeSessionFixture(dir);
    writeSubagentLoadout(sessionFile, {
      agent: "worker",
      toolAllowlist: null,
      model: null,
      thinking: null,
      systemPromptMode: null,
      identity: null,
      spawnable: null,
      autoExit: true,
      cwd: dir,
      agentDir: null,
    } as never);
    const artifactDir = join(dir, "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    const running = fakeRunning(sessionFile, dir, artifactDir);
    const pi = recordingPi();
    // Silence the diagnostic toast's no-UI console fallback for clean output.
    mock.method(console, "error", () => {});

    __test__.finalizeLostSubagent(pi as never, running, "pane_lost", {
      restart: async () => {
        throw paneNotFoundErr();
      },
    } as never);
    await settle();

    const paneRows = pi.sent.filter((s) => s.msg.customType === "subagent_pane_error");
    assert.equal(paneRows.length, 1, "exactly one pane-error row");
    assert.match(String(paneRows[0].msg.content), /can't find pane: %424242/);

    const loss = pi.sent.filter((s) => s.msg.customType === "subagent_result");
    assert.ok(loss.length >= 1, "loss result still delivered");
  });

  it("renderer draws an error-colored row prefixed Error:", () => {
    const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
    const renderer = __test__.renderSubagentPaneError(
      { content: `[pi-subagents] restart of "mapmaker" failed: can't find pane: %424242` } as never,
      {} as never,
      theme as never,
    );
    assert.ok(renderer, "renderer produced a component");
    const lines = renderer.render(200);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^<error>Error: \[pi-subagents\] restart of "mapmaker" failed: can't find pane: %424242$/);
  });
});
