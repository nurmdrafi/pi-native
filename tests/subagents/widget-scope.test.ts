/**
 * The running-subagents widget above the editor.
 *
 * Two failure modes made it invisible in a live session:
 *  - the render set was filtered to the current project scope, so a child
 *    registered under another repo root (worktree, `cwd` param, a second
 *    session in the same process) emptied the list and the widget was
 *    cleared instead of drawn;
 *  - nothing re-armed the refresh after a session start, so the widget
 *    stayed blank until the next tool call touched the UI context.
 *
 * Foreign-scope children now render dimmed with their repo name, and a
 * session start arms the refresh whenever children are already registered.
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { __test__ } from "../../extensions/subagents/index.ts";
import { createStatusState } from "../../extensions/subagents/status.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

const roots: string[] = [];

/** A temp directory that `repoRootFor` recognizes as a repo root. */
function fakeRepoRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  mkdirSync(join(dir, ".git"), { recursive: true });
  roots.push(dir);
  return dir;
}

function fakeRunning(id: string, name: string, scopeKey: string | undefined): any {
  const startTime = Date.now() - 12_000;
  return {
    id,
    name,
    task: "widget task",
    surface: "%99",
    startTime,
    sessionFile: join(tmpdir(), `${id}.jsonl`),
    cwd: scopeKey,
    ...(scopeKey === undefined ? {} : { scopeKey }),
    statusState: createStatusState({ source: "pi", startTimeMs: startTime }),
  };
}

interface RenderedWidget {
  key: string;
  value: unknown;
}

/** Minimal host context: records every setWidget call. */
function hostContext(cwd: string): { ctx: any; calls: RenderedWidget[] } {
  const calls: RenderedWidget[] = [];
  const ctx = {
    cwd,
    hasUI: true,
    ui: {
      setWidget: (key: string, value: unknown) => {
        calls.push({ key, value });
      },
      notify: () => {},
    },
  };
  return { ctx, calls };
}

function renderLines(value: unknown): string[] {
  assert.ok(value, "widget value is a render factory, not undefined (widget cleared)");
  const factory = value as (_tui: unknown, _theme: unknown) => { render(width: number): string[] };
  return factory(null, null).render(100);
}

function plain(lines: string[]): string[] {
  return lines.map((l) => l.replace(ANSI, ""));
}

describe("subagents widget scope rendering", () => {
  beforeEach(() => {
    __test__.runningSubagents.clear();
  });

  afterEach(() => {
    __test__.runningSubagents.clear();
    __test__.resetChannelState();
    __test__.setUiContext(null);
    while (roots.length > 0) {
      const dir = roots.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("draws a child registered under a foreign repo scope instead of clearing the widget", () => {
    const ownRoot = fakeRepoRoot("widget-own");
    const otherRoot = fakeRepoRoot("widget-other");
    __test__.runningSubagents.set("f1", fakeRunning("f1", "foreign-worker", otherRoot));

    const { ctx, calls } = hostContext(ownRoot);
    __test__.setUiContext(ctx);
    __test__.updateWidget();

    assert.equal(calls.length, 1, "one render pass");
    assert.equal(calls.at(-1)?.key, "subagent-status", "widget key unchanged");
    const lines = renderLines(calls.at(-1)?.value);
    const rows = plain(lines).filter((l) => l.includes("foreign-worker"));
    assert.equal(rows.length, 1, "foreign child still listed");
    assert.match(rows[0] ?? "", /@widget-other/, "foreign row names its repo");
  });

  it("marks a foreign child dim and leaves an in-scope child undimmed", () => {
    const ownRoot = fakeRepoRoot("widget-own");
    const otherRoot = fakeRepoRoot("widget-other");
    __test__.runningSubagents.set("o1", fakeRunning("o1", "own-worker", ownRoot));
    __test__.runningSubagents.set("f1", fakeRunning("f1", "foreign-worker", otherRoot));

    const { ctx, calls } = hostContext(ownRoot);
    __test__.setUiContext(ctx);
    __test__.updateWidget();

    const lines = renderLines(calls.at(-1)?.value);
    const own = lines.find((l) => l.includes("own-worker")) ?? "";
    const foreign = lines.find((l) => l.includes("foreign-worker")) ?? "";
    assert.ok(own.includes("own-worker") && foreign.includes("foreign-worker"), "both children drawn");
    assert.ok(!own.includes("@widget-other"), "own row carries no foreign tag");
    assert.ok(foreign.includes("@widget-other"), "foreign row tagged with its repo");
    assert.ok(
      foreign.includes("\x1b[38;2;128;128;128m"),
      "foreign name painted with the dim color",
    );
    assert.ok(
      !own.includes("\x1b[38;2;128;128;128mown-worker"),
      "own name not dimmed",
    );
  });

  it("clears the widget when no child is registered", () => {
    const ownRoot = fakeRepoRoot("widget-own");
    const { ctx, calls } = hostContext(ownRoot);
    __test__.setUiContext(ctx);
    __test__.updateWidget();

    assert.equal(calls.at(-1)?.value, undefined, "widget cleared with zero children");
  });

  it("arms the widget on session start so it reappears after a reload", () => {
    const ownRoot = fakeRepoRoot("widget-own");
    __test__.runningSubagents.set("o1", fakeRunning("o1", "own-worker", ownRoot));
    __test__.resetChannelState();

    const { ctx, calls } = hostContext(ownRoot);
    __test__.armWidgetForSession(ctx);

    assert.equal(__test__.channelTimersActive().widget, true, "refresh interval armed");
    const lines = renderLines(calls.at(-1)?.value);
    assert.ok(plain(lines).some((l) => l.includes("own-worker")), "widget drawn on arm");
  });
});
