/**
 * Pane errors stay internal; diagnostics never touch the input line.
 *
 * Defect: a pane-not-found failure that escaped the watcher's poll loop
 * surfaced as a raw child-error result — `Subagent error: Command failed:
 * tmux …\ncan't find pane: %N` — carrying the multiplexer's own words into
 * the result row and model context. And a diagnostic reported before any
 * UI context existed (module load, extension reload) raw-printed to
 * stderr, which interleaves with the TUI input editor where the user is
 * typing.
 *
 * Contract under test:
 * - a pane-not-found error thrown out of the watcher is handled internally:
 *   the same synthesized pane_lost result the poll loop delivers — no raw
 *   multiplexer wording anywhere in the result;
 * - any other tmux-shaped error is sanitized to the failure description
 *   (`tmux <subcommand> failed on pane %N`), never the raw exec text;
 * - a non-tmux error keeps its own message;
 * - diagnostics with NO UI context yet are held in a queue — nothing is
 *   printed to stderr while an interactive session may still be alive;
 * - the queue flushes inline through the host UI notify channel when a UI
 *   context arrives, and to stderr only once a context confirms headless.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";

delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;

/** execFile-shaped tmux failure, as the watcher's poll can reject with it. */
function tmuxErr(message: string, stderr?: string): Error & { stderr?: string } {
  const err = new Error(message) as Error & { stderr?: string };
  if (stderr !== undefined) err.stderr = stderr;
  return err;
}

function paneNotFoundErr(): Error & { stderr: string } {
  return Object.assign(
    new Error("Command failed: tmux capture-pane -p -t %424242 -S -5\ncan't find pane: %424242"),
    { stderr: "can't find pane: %424242" },
  ) as Error & { stderr: string };
}

/** Minimal RunningSubagent for the watcher — only the fields watchSubagent
 *  and synthesizeLostResult read. */
function watcherFixture(dir: string): Parameters<typeof __test__.watchSubagent>[0] {
  return {
    id: "fixture-1",
    name: "mapmaker",
    agent: "worker",
    task: "map the pane lifecycle",
    surface: "%424242",
    sessionFile: join(dir, "child.jsonl"),
    startTime: Date.now() - 5_000,
    interactive: false,
    statusState: { source: "pi", startTimeMs: Date.now() - 5_000, currentKind: "running" },
  } as never;
}

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "pane-internal-"));
}

describe("watcher pane errors stay internal", () => {
  beforeEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
  });
  afterEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
    mock.restoreAll();
  });

  it("synthesizes pane_lost when the watcher throws a pane-not-found error", async () => {
    const dir = makeDir();
    try {
      const running = watcherFixture(dir);
      const result = await __test__.watchSubagent(running, new AbortController().signal, {
        poll: (async () => {
          throw paneNotFoundErr();
        }) as never,
      });
      assert.equal(result.error, "pane_lost");
      assert.match(result.summary, /Pane lost/);
      assert.doesNotMatch(JSON.stringify(result), /can't find pane/i);
      assert.doesNotMatch(JSON.stringify(result), /Command failed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes any other tmux-shaped error instead of leaking exec text", async () => {
    const dir = makeDir();
    try {
      const running = watcherFixture(dir);
      const result = await __test__.watchSubagent(running, new AbortController().signal, {
        poll: (async () => {
          throw tmuxErr("Command failed: tmux display-message -p -t %424242 #{pane_id}\nsome mux noise");
        }) as never,
      });
      assert.equal(result.error, "tmux display-message failed on pane %424242");
      assert.doesNotMatch(JSON.stringify(result), /Command failed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a non-tmux error message as-is", async () => {
    const dir = makeDir();
    try {
      const running = watcherFixture(dir);
      const result = await __test__.watchSubagent(running, new AbortController().signal, {
        poll: (async () => {
          throw new Error("session file parse exploded");
        }) as never,
      });
      assert.equal(result.error, "session file parse exploded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diagnostics without a UI context queue instead of printing", () => {
  beforeEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
  });
  afterEach(() => {
    __test__.resetChannelState();
    __test__.setUiContext(null);
    mock.restoreAll();
  });

  const failingPi = (): { sendMessage: (m: unknown, o: unknown) => Promise<void> } => ({
    sendMessage: () => Promise.reject(new Error("channel gone")),
  });

  const flushMicrotasks = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  it("holds a dead-channel diagnostic when no UI context exists — no stderr", async () => {
    const err = mock.method(console, "error", () => {});
    __test__.sendMessageContained(failingPi() as never, { customType: "subagent_result", content: "m", display: true }, undefined);
    await flushMicrotasks();
    assert.equal(err.mock.calls.length, 0, "nothing raw-prints while a TUI may be alive");
    assert.equal(
      __test__.pendingDiagnostics().filter((l) => /could not be delivered/.test(l)).length,
      1,
      "the diagnostic is held for the next context",
    );
  });

  it("flushes the held queue inline through notify once a UI context arrives", async () => {
    __test__.sendMessageContained(failingPi() as never, { customType: "subagent_result", content: "m", display: true }, undefined);
    await flushMicrotasks();

    const notified: string[] = [];
    const err = mock.method(console, "error", () => {});
    __test__.setUiContext({
      hasUI: true,
      ui: { notify: (text: string, severity?: string) => void notified.push(`${severity}:${text}`) },
    } as never);
    assert.equal(
      notified.filter((l) => /could not be delivered/.test(l)).length,
      1,
      "the held diagnostic is delivered inline",
    );
    assert.ok(notified[0]!.startsWith("error:"), "severity is error");
    assert.equal(err.mock.calls.length, 0);
    assert.equal(__test__.pendingDiagnostics().length, 0, "queue drained");
  });

  it("prints to stderr only once a context confirms headless", async () => {
    __test__.sendMessageContained(failingPi() as never, { customType: "subagent_result", content: "m", display: true }, undefined);
    await flushMicrotasks();

    const err = mock.method(console, "error", () => {});
    __test__.setUiContext({ hasUI: false } as never);
    const lines = err.mock.calls.map((c) => c.arguments.join(" "));
    assert.equal(lines.filter((l) => /could not be delivered/.test(l)).length, 1);
    assert.equal(__test__.pendingDiagnostics().length, 0, "queue drained");
  });
});
