/**
 * Delivery-path hardening: bounded git calls and the child/parent
 * files_changed merge.
 *
 * The delivery path runs two synchronous git invocations (status delta +
 * capped diff). A wedged git (hung mount, stale index lock) must never stall
 * result delivery — both calls are bounded by a timeout and stay fail-soft.
 *
 * The merge rule: the child appends its own durable record (same id,
 * observedByParent: false) at agent end, carrying the child-computed
 * files_changed. The parent appends its record at delivery, and the drain
 * keeps the LAST record per id. So when the parent-side delta computes to
 * null (git failed, baseline unreadable), the parent record must ADOPT the
 * child's already-durable files_changed — otherwise it strips it from the
 * durable view. When the parent delta is non-null, the parent wins.
 */
// Scrub inherited child-identity env and redirect the durable inbox BEFORE any
// extension import loads — every invocation style must get the same isolation.
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { appendSubagentResult, repoRootFor } from "../../extensions/subagents/inbox.ts";

// The spawn allowlist is captured when the extension module loads; scrub it
// BEFORE importing the extension so these fixtures are not gated by whatever
// allowlist the environment running this suite inherited.
delete process.env.PI_SUBAGENT_ALLOWED;
delete process.env.PI_SUBAGENT_AGENT;
const subagentsModule = await import("../../extensions/subagents/index.ts");
const { __test__ } = subagentsModule;

function fakePi() {
  const sent: { content: string; details: unknown }[] = [];
  return {
    sent,
    sendMessage(msg: { content: string; details?: unknown }) {
      sent.push({ content: msg.content, details: msg.details });
    },
  };
}

function fakeRunning(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-hard-1",
    name: "Worker-1",
    task: "harden the delivery path",
    agent: "worker",
    surface: "%999999",
    startTime: Date.now() - 60_000,
    sessionFile: "/nonexistent/session.jsonl",
    parentSessionId: "parent-sess",
    interactive: false,
    statusState: { source: "pi", startTimeMs: Date.now() - 60_000, currentKind: "running" },
    ...overrides,
  };
}

function resultFor(running: { name: string; task: string }) {
  return { name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 };
}

function inboxRecords(inboxPath: string): Record<string, any>[] {
  return readFileSync(inboxPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("delivery-path git hardening", () => {
  // projectDir is the (real) child repo; scratchDir keeps every fixture the
  // repo must NOT see in its status delta (inbox override, baseline, history).
  let projectDir = "";
  let scratchDir = "";
  let inboxPath = "";
  const prevInbox = process.env.PI_SUBAGENT_INBOX;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "delivery-harden-repo-"));
    execFileSync("git", ["init", "-q", projectDir], { stdio: "ignore" });
    scratchDir = mkdtempSync(join(tmpdir(), "delivery-harden-scratch-"));
    inboxPath = join(scratchDir, "inbox.jsonl");
    process.env.PI_SUBAGENT_INBOX = inboxPath;
  });

  afterEach(() => {
    process.env.PI_SUBAGENT_INBOX = prevInbox;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("adopts the child's durable files_changed when the parent delta is null", () => {
    // Baseline exists but points at a bogus repoRoot: the delivery-time
    // `git status` throws and computeFilesChanged yields null.
    const baseline = join(scratchDir, "base.json");
    writeFileSync(baseline, JSON.stringify({ repoRoot: join(projectDir, "no-such"), porcelain: "" }));
    const running = fakeRunning({ id: "merge-1", cwd: projectDir, gitBaselinePath: baseline });

    // The child already self-reported durably with its own computed delta.
    appendSubagentResult({
      id: "merge-1",
      ts: Date.now() - 1_000,
      name: running.name,
      task: running.task,
      agent: "worker",
      sessionFile: "/nonexistent/session.jsonl",
      parentSessionId: "parent-sess",
      repoRoot: scratchDir,
      summary: "child self-report",
      exitCode: 0,
      elapsed: 1,
      observedByParent: false,
      files_changed: ["src/in.ts"],
      files_changed_source: "git_status_delta",
    });

    const pi = fakePi();
    __test__.deliverSubagentResult(pi as never, running as never, resultFor(running));

    const recs = inboxRecords(inboxPath).filter((r) => r.id === "merge-1");
    assert.equal(recs.length, 2, "child self-report + parent record");
    const parentRec = recs[recs.length - 1];
    assert.equal(parentRec.observedByParent, true, "last record is the parent's");
    assert.deepEqual(parentRec.files_changed, ["src/in.ts"], "child's files_changed survives the merge");
    assert.equal(parentRec.files_changed_source, "git_status_delta");
  });

  it("prefers the parent's non-null delta over the child's record", () => {
    // Valid baseline against the real repo, clean at spawn; one file changes
    // before delivery — the parent delta is authoritative.
    const baseline = join(scratchDir, "base.json");
    writeFileSync(baseline, JSON.stringify({ repoRoot: repoRootFor(projectDir), porcelain: "" }));
    const running = fakeRunning({ id: "merge-2", cwd: projectDir, gitBaselinePath: baseline });
    mkdirSync(join(projectDir, "src"), { recursive: true });
    writeFileSync(join(projectDir, "src", "a.ts"), "new", "utf8");

    appendSubagentResult({
      id: "merge-2",
      ts: Date.now() - 1_000,
      name: running.name,
      task: running.task,
      agent: "worker",
      sessionFile: "/nonexistent/session.jsonl",
      parentSessionId: "parent-sess",
      repoRoot: scratchDir,
      summary: "child self-report",
      exitCode: 0,
      elapsed: 1,
      observedByParent: false,
      files_changed: ["stale/from-child.ts"],
      files_changed_source: "git_status_delta",
    });

    const pi = fakePi();
    __test__.deliverSubagentResult(pi as never, running as never, resultFor(running));

    const parentRec = inboxRecords(inboxPath).filter((r) => r.id === "merge-2").pop()!;
    assert.deepEqual(parentRec.files_changed, ["src/a.ts"], "parent's delta wins when non-null");
    assert.equal(parentRec.files_changed_source, "git_status_delta");
  });

  it("bounds a wedged git on the delivery path and stays fail-soft", () => {
    // A fake `git` that hangs past the delivery bound. Without a timeout the
    // delivery call blocks for the full sleep; bounded, it is killed at the
    // timeout, the delta yields null, and delivery completes fail-soft.
    const fakeBin = mkdtempSync(join(tmpdir(), "fake-git-bin-"));
    const prevPath = process.env.PATH;
    try {
      writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nexec sleep 12\n", "utf8");
      chmodSync(join(fakeBin, "git"), 0o755);
      process.env.PATH = `${fakeBin}:${prevPath}`;

      const baseline = join(scratchDir, "base.json");
      writeFileSync(baseline, JSON.stringify({ repoRoot: repoRootFor(projectDir), porcelain: "" }));
      const running = fakeRunning({ id: "wedge-1", cwd: projectDir, gitBaselinePath: baseline });

      const pi = fakePi();
      const started = Date.now();
      __test__.deliverSubagentResult(pi as never, running as never, resultFor(running));
      const elapsedMs = Date.now() - started;

      assert.ok(elapsedMs < 8_000, `delivery bounded by the git timeout (took ${elapsedMs} ms)`);
      const parentRec = inboxRecords(inboxPath).filter((r) => r.id === "wedge-1").pop()!;
      assert.equal(parentRec.files_changed, undefined, "wedged git degrades to no files_changed");
      assert.equal(pi.sent.length, 1, "result still delivered in memory");
    } finally {
      process.env.PATH = prevPath;
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
