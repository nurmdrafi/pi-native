/**
 * files_changed / files_read / diff tracking on subagent results.
 *
 * Children edit files; their results so far carried only prose summaries, so
 * a later spawn in the same wave re-reads the same files to learn what
 * changed. The durable layer now derives context from a spawn-time git
 * baseline (`git status --porcelain=v1 -z --untracked-files=all`) diffed
 * against the end state at result time — identical on the child self-report
 * side and the parent delivery side.
 *
 * The derived list rides the inbox record (optional field — old lines simply
 * lack it). Everything richer (files the child READ via read-ish tool calls,
 * a capped unified diff) goes ONLY into an append-only per-repo history file
 * (`.pi/subagent-history.jsonl`) which, unlike the drain-managed inbox, is
 * never compacted — a later spawn can inject prior-work context without
 * depending on inbox drain timing.
 *
 * The baseline capture must never block the launch path: the baseline PATH is
 * resolved synchronously (so PI_SUBAGENT_BASELINE rides the pane env) while
 * the porcelain capture and file write happen asynchronously; a child that
 * starts before the file lands simply sees no baseline (guard: null).
 */
import "./test-env.ts";

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendSubagentResult,
  buildPriorWorkBlock,
  computeFilesChanged,
  drainSubagentResults,
  extractFilesRead,
  gitDiffForBaseline,
  prepareGitBaseline,
  readRecentResults,
  subagentHistoryPath,
  type InboxRecord,
} from "../../extensions/subagents/inbox.ts";

function makeRecord(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: "rec-1",
    ts: Date.now(),
    name: "worker",
    task: "do things",
    sessionFile: "/tmp/session.jsonl",
    parentSessionId: null,
    observedByParent: false,
    repoRoot: "/tmp/repo",
    summary: "done",
    exitCode: 0,
    elapsed: 3,
    ...overrides,
  };
}

function writeBaselineFile(path: string, repoRoot: string, porcelain: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ repoRoot, porcelain }), "utf8");
  return path;
}

describe("computeFilesChanged", () => {
  const root = join(tmpdir(), "inbox-files-compute");

  it("returns added and modified paths, sorted", () => {
    const baseline = writeBaselineFile(join(root, "b1.json"), root, "");
    const gitFn = () => "?? new.txt\0 M mod.txt\0";
    assert.deepEqual(computeFilesChanged(baseline, gitFn), ["mod.txt", "new.txt"]);
  });

  it("returns paths removed since the baseline", () => {
    const baseline = writeBaselineFile(join(root, "b2.json"), root, "?? gone.txt\0");
    assert.deepEqual(computeFilesChanged(baseline, () => ""), ["gone.txt"]);
  });

  it("drops paths whose status is unchanged since the baseline", () => {
    const porcelain = " M keep.txt\0?? untracked.txt\0";
    const baseline = writeBaselineFile(join(root, "b3.json"), root, porcelain);
    assert.deepEqual(computeFilesChanged(baseline, () => porcelain), []);
  });

  it("returns paths whose status code changed", () => {
    const baseline = writeBaselineFile(join(root, "b4.json"), root, " M same.txt\0");
    assert.deepEqual(computeFilesChanged(baseline, () => "M  same.txt\0"), ["same.txt"]);
  });

  it("treats rename records as plain add/delete pairs (no special casing)", () => {
    const baseline = writeBaselineFile(join(root, "b5.json"), root, "");
    assert.deepEqual(computeFilesChanged(baseline, () => "R  new.txt\0old.txt\0"), ["new.txt", "old.txt"]);
  });

  it("caps the result at 200 sorted paths", () => {
    const baseline = writeBaselineFile(join(root, "b6.json"), root, "");
    const end = Array.from({ length: 250 }, (_, i) => `?? p${String(i).padStart(3, "0")}.txt`).join("\0") + "\0";
    const changed = computeFilesChanged(baseline, () => end);
    assert.ok(changed, "expected a files_changed list");
    assert.equal(changed.length, 200);
    assert.equal(changed[0], "p000.txt");
    assert.equal(changed[199], "p199.txt");
  });

  it("returns null on any failure — including a missing or empty baseline file (child guard)", () => {
    const baseline = writeBaselineFile(join(root, "b7.json"), root, "");
    // Missing baseline file (async write lost the race, or git failed).
    assert.equal(computeFilesChanged(join(root, "missing.json"), () => ""), null);
    // Empty baseline file.
    const empty = join(root, "empty.json");
    writeFileSync(empty, "", "utf8");
    assert.equal(computeFilesChanged(empty, () => ""), null);
    // git failure.
    assert.equal(
      computeFilesChanged(baseline, () => {
        throw new Error("git gone");
      }),
      null,
    );
    // Corrupt baseline JSON.
    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.equal(computeFilesChanged(corrupt, () => ""), null);
    // Baseline missing the porcelain field.
    const noPorcelain = join(root, "noporcelain.json");
    writeFileSync(noPorcelain, JSON.stringify({ repoRoot: root }), "utf8");
    assert.equal(computeFilesChanged(noPorcelain, () => ""), null);
  });
});

describe("prepareGitBaseline (async capture, synchronous path resolution)", () => {
  it("resolves the path synchronously and writes the file without blocking the caller", () => {
    const repo = mkdtempSync(join(tmpdir(), "inbox-files-repo-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "sub"), { recursive: true });
      const dest = join(repo, "out", "child.git-baseline.json");
      let release: ((out: string | null) => void) | null = null;
      const runGit = (_args: string[], cb: (out: string | null) => void) => {
        release = cb;
      };
      const returned = prepareGitBaseline(dest, join(repo, "sub"), runGit);
      assert.equal(returned, dest, "baseline path resolves synchronously for the env var");
      assert.equal(existsSync(dest), false, "file is not written yet — the launch path never blocked on git");
      release!("?? a.txt\0 M b.txt\0");
      assert.equal(existsSync(dest), true);
      const saved = JSON.parse(readFileSync(dest, "utf8"));
      assert.equal(saved.repoRoot, repo);
      assert.equal(saved.porcelain, "?? a.txt\0 M b.txt\0");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns null outside a git repo and writes nothing", () => {
    const plain = mkdtempSync(join(tmpdir(), "inbox-files-plain-"));
    try {
      const dest = join(plain, "out", "child.git-baseline.json");
      assert.equal(prepareGitBaseline(dest, plain, () => {}), null);
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("never writes the file when git fails (the child guard covers the gap)", () => {
    const repo = mkdtempSync(join(tmpdir(), "inbox-files-gitfail-"));
    try {
      mkdirSync(join(repo, ".git"), { recursive: true });
      const dest = join(repo, "child.git-baseline.json");
      const returned = prepareGitBaseline(dest, repo, (_args, cb) => cb(null));
      assert.equal(returned, dest, "path still resolves — the env var is set optimistically");
      assert.equal(existsSync(dest), false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("extractFilesRead", () => {
  it("collects piread/piedit path arguments, deduped and sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-files-sess-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      const entries = [
        { message: { role: "assistant", content: [{ type: "toolCall", name: "piread", arguments: { path: "src/b.ts" } }] } },
        { message: { role: "assistant", content: [{ type: "toolCall", name: "piread", arguments: { path: "src/a.ts" } }] } },
        { message: { role: "assistant", content: [{ type: "toolCall", name: "piedit", arguments: { path: "src/a.ts" } }] } },
        { message: { role: "assistant", content: [{ type: "toolCall", name: "pibash", arguments: { command: "ls src/" } }] } },
        { message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } },
        { message: { role: "user", content: [{ type: "text", text: "go" }] } },
      ];
      writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      assert.deepEqual(extractFilesRead(sessionFile), ["src/a.ts", "src/b.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps at 50 sorted paths and returns null for an unreadable session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-files-sess2-"));
    try {
      const sessionFile = join(dir, "child.jsonl");
      const calls = Array.from({ length: 60 }, (_, i) => ({
        message: { role: "assistant", content: [{ type: "toolCall", name: "piread", arguments: { path: `f${String(i).padStart(2, "0")}.ts` } }] },
      }));
      writeFileSync(sessionFile, calls.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      const read = extractFilesRead(sessionFile);
      assert.ok(read, "expected a files_read list");
      assert.equal(read.length, 50);
      assert.equal(read[0], "f00.ts");
      assert.equal(read[49], "f49.ts");
      assert.equal(extractFilesRead(join(dir, "missing.jsonl")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gitDiffForBaseline", () => {
  const root = join(tmpdir(), "inbox-files-diff");

  it("runs a -U1 no-color diff over the changed paths, capped at 1500 chars", () => {
    const baseline = writeBaselineFile(join(root, "d1.json"), root, "");
    const diff = "diff --git a/x b/x\n" + "+".padEnd(60, "+").repeat(40);
    let seenArgs: string[] | null = null;
    const gitFn = (args: string[]) => {
      seenArgs = args;
      return diff;
    };
    const out = gitDiffForBaseline(baseline, ["a.ts", "b.ts"], gitFn);
    assert.ok(out);
    assert.ok(out.length <= 1500);
    assert.ok(out.startsWith("diff --git"));
    assert.deepEqual(seenArgs, ["-C", root, "diff", "HEAD", "--no-color", "-U1", "--", "a.ts", "b.ts"]);
  });

  it("omits (null) on empty diff, git failure, or missing baseline", () => {
    const baseline = writeBaselineFile(join(root, "d2.json"), root, "");
    assert.equal(gitDiffForBaseline(baseline, ["a.ts"], () => ""), null);
    assert.equal(
      gitDiffForBaseline(baseline, ["a.ts"], () => {
        throw new Error("boom");
      }),
      null,
    );
    assert.equal(gitDiffForBaseline(join(root, "missing.json"), ["a.ts"], () => "x"), null);
    assert.equal(gitDiffForBaseline(baseline, [], () => "x"), null, "no changed paths -> no diff");
  });

  it("includes staged-only changes (diffs against HEAD, not just the worktree)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inbox-files-staged-"));
    try {
      const git = (args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      git(["init", "-q"]);
      git([
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "base",
      ]);
      // Staged-only: the worktree matches the index, so a plain `git diff`
      // (index vs worktree) shows nothing — only `git diff HEAD` sees it.
      writeFileSync(join(dir, "a.ts"), "one\ntwo\n", "utf8");
      git(["add", "a.ts"]);
      const baseline = writeBaselineFile(join(dir, "baseline.json"), dir, "");
      const out = gitDiffForBaseline(baseline, ["a.ts"]);
      assert.ok(out, "staged-only change must appear in the history diff");
      assert.match(out, /\+two/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("history file and drain interplay", () => {
  let repoRoot: string;
  let savedInbox: string | undefined;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "inbox-files-hist-"));
    savedInbox = process.env.PI_SUBAGENT_INBOX;
    delete process.env.PI_SUBAGENT_INBOX;
  });

  afterEach(() => {
    if (savedInbox === undefined) delete process.env.PI_SUBAGENT_INBOX;
    else process.env.PI_SUBAGENT_INBOX = savedInbox;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records without files_changed still drain, and never touch the history file", () => {
    appendSubagentResult(makeRecord({ repoRoot }));
    const surfaced = drainSubagentResults(repoRoot, "bystander-session");
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0].id, "rec-1");
    assert.equal(existsSync(subagentHistoryPath(repoRoot)), false);
  });

  it("appends one compact history line per record carrying files_changed", () => {
    appendSubagentResult(
      makeRecord({
        id: "rec-2",
        repoRoot,
        files_changed: ["src/b.ts", "src/a.ts"],
        files_changed_source: "git_status_delta",
        summary: "line one\nline two\n" + "x".repeat(400),
      }),
    );
    const lines = readFileSync(subagentHistoryPath(repoRoot), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.id, "rec-2");
    assert.equal(rec.name, "worker");
    assert.deepEqual(rec.files_changed, ["src/a.ts", "src/b.ts"]);
    assert.equal(rec.summary.length, 300);
    assert.ok(!rec.summary.includes("\n"), "history summary must be one line");
  });

  it("append-only: bytes another writer landed survive a later append", () => {
    const historyPath = subagentHistoryPath(repoRoot);
    mkdirSync(join(repoRoot, ".pi"), { recursive: true });
    // Writer B (a sibling child self-report) already landed this line — plus
    // the untidy tail a crash mid-append leaves behind.
    const writerB =
      JSON.stringify({ id: "b-1", ts: 1, name: "scout", files_changed: ["b.ts"], summary: "s" }) + "\n\n";
    writeFileSync(historyPath, writerB, "utf8");
    // Writer A (parent delivery of another child) appends its own line.
    appendSubagentResult(makeRecord({ id: "a-1", repoRoot, files_changed: ["a.ts"] }));
    const after = readFileSync(historyPath, "utf8");
    // A read-modify-write appender drops a sibling's line that lands between
    // its read and its write, and truncates all history on a crash mid
    // rewrite; an append-only writer cannot.
    assert.ok(after.startsWith(writerB), "append must not rewrite bytes already on disk");
    assert.deepEqual(
      readRecentResults(repoRoot, 10).map((r) => r.id),
      ["b-1", "a-1"],
    );
  });

  it("rotation keeps every valid record when the tail is a mid-append crash residue", () => {
    const historyPath = subagentHistoryPath(repoRoot);
    mkdirSync(join(repoRoot, ".pi"), { recursive: true });
    const old = Array.from({ length: 1001 }, (_, i) =>
      JSON.stringify({ id: `old-${i}`, ts: i, name: "old", files_changed: ["f"], summary: "s" }),
    );
    // Writer B crashed mid-append: a trailing partial line with no newline.
    writeFileSync(historyPath, old.join("\n") + "\n" + '{"id":"partial-', "utf8");
    appendSubagentResult(makeRecord({ id: "new-1", repoRoot, files_changed: ["f.ts"] }));
    const ids = readRecentResults(repoRoot, 1000).map((r) => r.id);
    assert.equal(ids.length, 500);
    assert.equal(ids[0], "old-502", "oldest kept valid record must survive rotation");
    assert.equal(ids[ids.length - 1], "new-1");
  });

  it("sacrifices a no-newline crash residue so the next record still parses", () => {
    const historyPath = subagentHistoryPath(repoRoot);
    mkdirSync(join(repoRoot, ".pi"), { recursive: true });
    const good =
      JSON.stringify({ id: "good-1", ts: 1, name: "old", files_changed: ["f"], summary: "s" }) + "\n";
    // Crash mid-append: a trailing partial JSON fragment with no newline.
    // Below the rotation threshold nothing ever rewrites this file, so a
    // glued append would cost one permanently lost history record.
    writeFileSync(historyPath, good + '{"id":"partial-', "utf8");
    appendSubagentResult(makeRecord({ id: "new-1", repoRoot, files_changed: ["f.ts"] }));
    const after = readFileSync(historyPath, "utf8");
    assert.ok(after.endsWith("\n"), "the appended record must end with a newline");
    const tail = after.slice(0, -1).split("\n").pop()!;
    assert.equal(JSON.parse(tail).id, "new-1", "the new record must parse off the tail");
    assert.deepEqual(
      readRecentResults(repoRoot, 10).map((r) => r.id),
      ["good-1", "new-1"],
    );
  });

  it("carries files_read and diff in HISTORY ONLY — the inbox record stays lean", () => {
    appendSubagentResult(
      makeRecord({
        id: "rec-3",
        repoRoot,
        files_changed: ["a.ts"],
        files_changed_source: "git_status_delta",
      }),
      { files_read: ["r1.ts", "r2.ts"], diff: "diff --git a/a.ts b/a.ts\n+changed" },
    );
    const rec = JSON.parse(readFileSync(subagentHistoryPath(repoRoot), "utf8").trim());
    assert.deepEqual(rec.files_read, ["r1.ts", "r2.ts"]);
    assert.match(rec.diff, /diff --git a\/a\.ts/);
    const surfaced = drainSubagentResults(repoRoot, "bystander-session");
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0].files_changed?.[0], "a.ts");
    assert.equal("files_read" in surfaced[0], false, "files_read must not bloat the drain-managed inbox");
    assert.equal("diff" in surfaced[0], false, "diff must not bloat the drain-managed inbox");
  });

  it("read-only children (files_read, no file changes) still get a history row", () => {
    appendSubagentResult(
      makeRecord({ id: "scout-1", repoRoot, files_changed: [], files_changed_source: "git_status_delta" }),
      { files_read: ["docs/a.md", "src/b.ts"] },
    );
    const rec = JSON.parse(readFileSync(subagentHistoryPath(repoRoot), "utf8").trim());
    assert.equal(rec.id, "scout-1");
    assert.deepEqual(rec.files_changed, []);
    assert.deepEqual(rec.files_read, ["docs/a.md", "src/b.ts"]);
  });

  it("rotates the history file down to the last 500 records past 1000 lines", () => {
    const historyPath = subagentHistoryPath(repoRoot);
    mkdirSync(join(repoRoot, ".pi"), { recursive: true });
    const old = Array.from({ length: 1001 }, (_, i) =>
      JSON.stringify({ id: `old-${i}`, ts: i, name: "old", files_changed: ["f"], summary: "s" }),
    );
    writeFileSync(historyPath, old.join("\n") + "\n", "utf8");
    appendSubagentResult(makeRecord({ id: "new-1", repoRoot, files_changed: ["f.ts"] }));
    const lines = readFileSync(historyPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 501);
    assert.equal(JSON.parse(lines[0]).id, "old-501");
    assert.equal(JSON.parse(lines[lines.length - 1]).id, "new-1");
  });

  it("readRecentResults returns the bounded tail, deduped by id, skipping corrupt lines", () => {
    const historyPath = subagentHistoryPath(repoRoot);
    mkdirSync(join(repoRoot, ".pi"), { recursive: true });
    const recs = [1, 2, 2, 3].map((n) =>
      JSON.stringify({ id: `r${n}`, ts: n, name: `n${n}`, files_changed: ["f"], summary: `s${n}` }),
    );
    writeFileSync(historyPath, ["{corrupt", ...recs].join("\n") + "\n", "utf8");
    assert.deepEqual(
      readRecentResults(repoRoot, 10).map((r) => r.id),
      ["r1", "r2", "r3"],
    );
    assert.deepEqual(
      readRecentResults(repoRoot, 2).map((r) => r.id),
      ["r2", "r3"],
    );
    rmSync(join(repoRoot, ".pi"), { recursive: true, force: true });
    assert.deepEqual(readRecentResults(repoRoot, 5), []);
  });
});

describe("buildPriorWorkBlock", () => {
  const now = 1_000_000_000_000;
  const rec = (over: Record<string, unknown> = {}) => ({
    id: "x",
    ts: now - 5 * 60_000,
    name: "scout",
    files_changed: ["src/a.ts"],
    files_read: ["src/shared.ts"],
    summary: "scouted",
    ...over,
  });

  it("matches a record when scope overlaps its files_changed OR its files_read", () => {
    const viaRead = rec({ files_changed: ["misc/b.ts"], files_read: ["src/shared.ts"] });
    const viaChanged = rec({ name: "editor", files_changed: ["src/a.ts"], files_read: ["misc/r.ts"] });
    const neither = rec({ name: "other", files_changed: ["misc/c.ts"], files_read: ["misc/r2.ts"] });
    const block = buildPriorWorkBlock([viaRead, viaChanged, neither], ["src"], { now });
    assert.ok(block);
    assert.match(block, /from scout, finished 5 min ago/);
    assert.match(block, /from editor/);
    assert.ok(!block.includes("from other"), "records with no overlap on either field are excluded");
    assert.match(block, /Read in your scope: src\/shared\.ts/, "files_read overlap is noted");
    assert.ok(!block.includes("misc/r.ts"), "non-overlapping read paths are not listed");
  });

  it("lists at most 10 changed paths with a +N overflow note", () => {
    const changed = Array.from({ length: 13 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const block = buildPriorWorkBlock([rec({ files_changed: changed })], ["src"], { now });
    assert.ok(block);
    assert.match(block, /- src\/f09\.ts/);
    assert.ok(!block.includes("src/f10.ts"), "paths beyond the 10-cap must not list");
    assert.match(block, /\+3 more changed files?/);
  });

  it("embeds a diff excerpt capped at 800 chars and a summary capped at 300", () => {
    const block = buildPriorWorkBlock(
      [rec({ diff: "diff --git\n" + "d".repeat(4000), summary: "s".repeat(5000) })],
      ["src"],
      { now },
    );
    assert.ok(block);
    const diffStart = block.indexOf("diff --git");
    assert.ok(diffStart >= 0, "diff excerpt present");
    assert.ok(!block.includes("d".repeat(801)), "diff excerpt never exceeds 800 chars");
    assert.ok(!block.includes("s".repeat(301)), "summary never exceeds 300 chars");
  });

  it("returns null when nothing overlaps either field", () => {
    assert.equal(buildPriorWorkBlock([rec({ files_changed: ["misc/b.ts"], files_read: ["misc/r.ts"] })], ["src"], { now }), null);
  });

  it("keeps at most the 2 most recent records", () => {
    const records = [1, 2, 3].map((n) => rec({ name: `w${n}`, ts: now - n * 60_000, files_changed: ["src"] }));
    const block = buildPriorWorkBlock(records, ["src"], { now });
    assert.ok(block);
    assert.match(block, /from w3/);
    assert.match(block, /from w2/);
    assert.ok(!block.includes("from w1"));
  });

  it("never exceeds the 1200-char block budget", () => {
    const big = rec({
      summary: "y".repeat(5000),
      diff: "z".repeat(4000),
      files_changed: Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`),
    });
    const block = buildPriorWorkBlock([big, big], ["src"], { now });
    assert.ok(block);
    assert.ok(block.length <= 1200, `block was ${block.length} chars`);
  });

  it("carries the do-not-re-read instruction", () => {
    const block = buildPriorWorkBlock([rec()], ["src"], { now });
    assert.ok(block);
    assert.match(
      block,
      /Do not re-read these files to reconstruct this context; verify only what your task requires\./,
    );
  });
});

describe("subagent_result renderer files_changed cap", () => {
  it("renders at most 20 paths plus a +N overflow line", async () => {
    const renderers: Record<string, any> = {};
    const pi = {
      on: () => {},
      registerCommand: () => {},
      registerMessageRenderer: (name: string, renderer: any) => {
        renderers[name] = renderer;
      },
      registerShortcut: () => {},
      registerTool: () => {},
      sendUserMessage: () => {},
      sendMessage: () => {},
      getAllTools: () => [],
      getActiveTools: () => ["subagent"],
      setActiveTools: () => {},
    };
    const subagentsModule = await import("../../extensions/subagents/index.ts");
    (subagentsModule as any).default(pi);
    const renderer = renderers["subagent_result"];
    assert.ok(renderer, "expected subagent_result renderer to be registered");

    const files = Array.from({ length: 25 }, (_, i) => `src/p${String(i + 1).padStart(2, "0")}.ts`);
    const rendered = renderer(
      {
        customType: "subagent_result",
        content: 'Sub-agent "worker" completed (1s).\n\nChanged some files.',
        details: { name: "worker", task: "t", exitCode: 0, elapsed: 1, files_changed: files },
      },
      { expanded: true },
      { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t },
    );
    const output = rendered.render(80).join("\n");
    assert.match(output, /- src\/p01\.ts/);
    assert.match(output, /- src\/p20\.ts/);
    assert.match(output, /\+5 more/);
    assert.ok(!output.includes("src/p21.ts"), "paths beyond the 20-cap must not render");
  });
});
