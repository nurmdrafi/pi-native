#!/usr/bin/env node
/**
 * Durable per-repo read ledger (piread outcomes).
 *
 * Incident corollary: reaped subagents lose their read work — nothing
 * recorded which spans were rendered, so a successor re-reads from zero.
 * Every piread result appends one record — path, requested window,
 * compaction omissions, file stat/hash, session id, timestamp — to
 * `<repo-root>/.pi/read-ledger.jsonl`. Index only: it never certifies
 * spans for a session that did not render them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendReadRecord,
  readLedgerPath,
  rotateReadLedger,
  setRotationBytesForTest,
} from "../../extensions/piread/ledger.ts";

function repoFixture() {
  const dir = mkdtempSync(join(tmpdir(), "read-ledger-"));
  mkdirSync(join(dir, ".git"), { recursive: true });
  const src = join(dir, "src", "app.ts");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(src, "line one\nline two\nline three\n", "utf8");
  return { dir, src };
}

test("appends one record per read with omissions, stat, and session id", () => {
  const { dir, src } = repoFixture();
  try {
    appendReadRecord({
      cwd: join(dir, "src"),
      sessionId: "sess-1",
      file: src,
      params: { path: "app.ts", offset: 1, limit: 3 },
      envelope: {
        ok: true,
        content: "line one\n…\nline three\n",
        totalBytes: 30,
        compaction: {
          strategy: "head-tail",
          originalChars: 40,
          visibleChars: 24,
          omittedChars: 16,
          omissions: [{ startLine: 2, endLine: 2, chars: 9, lines: 1 }],
          partial: false,
        },
      },
    });
    const raw = readFileSync(readLedgerPath(dir), "utf8").trim();
    const rec = JSON.parse(raw);
    assert.equal(rec.sessionId, "sess-1");
    assert.equal(rec.path, src);
    assert.deepEqual(rec.omissions, [{ startLine: 2, endLine: 2 }]);
    assert.equal(typeof rec.stat.size, "number");
    assert.equal(typeof rec.stat.mtimeMs, "number");
    assert.equal(typeof rec.sha256, "string");
    assert.ok(rec.ts > 0);
    assert.equal(rec.kind, "piread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records a plain read without compaction", () => {
  const { dir, src } = repoFixture();
  try {
    appendReadRecord({
      cwd: dir,
      sessionId: "sess-2",
      file: src,
      params: { path: "src/app.ts" },
      envelope: { ok: true, content: "line one\n", totalBytes: 30, compaction: null },
    });
    const rec = JSON.parse(readFileSync(readLedgerPath(dir), "utf8").trim());
    assert.equal(rec.omissions, null);
    assert.deepEqual(rec.requested, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger is per-repo (nested cwd writes at the repo root)", () => {
  const { dir, src } = repoFixture();
  try {
    appendReadRecord({
      cwd: join(dir, "src"),
      sessionId: "s",
      file: src,
      params: { path: "app.ts" },
      envelope: { ok: true, content: "x", compaction: null },
    });
    assert.equal(existsSync(readLedgerPath(dir)), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation shifts archives and drops the oldest beyond three", () => {
  const dir = mkdtempSync(join(tmpdir(), "read-ledger-rot-"));
  try {
    setRotationBytesForTest(64);
    const path = join(dir, "ledger.jsonl");
    writeFileSync(path, "x".repeat(80), "utf8");
    rotateReadLedger(path);
    assert.equal(existsSync(`${path}.1`), true);
    for (let i = 0; i < 5; i++) {
      writeFileSync(path, "y".repeat(80), "utf8");
      rotateReadLedger(path);
    }
    assert.equal(existsSync(`${path}.3`), true, "keeps three archives");
    assert.equal(existsSync(`${path}.4`), false, "drops the fourth");
  } finally {
    setRotationBytesForTest(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records a fused read with complement omissions from locate windows", () => {
  const { dir, src } = repoFixture();
  try {
    appendReadRecord({
      cwd: dir,
      sessionId: "sess-fused",
      file: src,
      params: { path: "app.ts", hits: "two" },
      envelope: {
        ok: true,
        content: "1:line one\n2:line two",
        truncation: null,
        binary: false,
        totalBytes: 30,
        compaction: null,
        locate: { needle: "two", hits: [2], hitsTotal: 1, windows: [[1, 2]], totalLines: 3 },
      },
    });
    const rec = JSON.parse(readFileSync(readLedgerPath(dir), "utf8").trim());
    assert.equal(rec.requested.hits, "two", "records the selector");
    // printed 1-2 of 3 lines: the unread tail is the only omission
    assert.deepEqual(rec.omissions, [{ startLine: 3, endLine: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records a fused miss as fully omitted (nothing rendered)", () => {
  const { dir, src } = repoFixture();
  try {
    appendReadRecord({
      cwd: dir,
      sessionId: "sess-miss",
      file: src,
      params: { path: "app.ts", hits: "zzz" },
      envelope: {
        ok: true,
        content: "[no lines matching 'zzz' in app.ts (3 lines, 30 bytes)]",
        truncation: null,
        binary: false,
        totalBytes: 30,
        compaction: null,
        locate: { needle: "zzz", hits: [], hitsTotal: 0, windows: [], totalLines: 3 },
      },
    });
    const rec = JSON.parse(readFileSync(readLedgerPath(dir), "utf8").trim());
    assert.deepEqual(rec.omissions, [{ startLine: 1, endLine: 3 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
