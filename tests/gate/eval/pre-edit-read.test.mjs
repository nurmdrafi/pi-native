/** Pre-edit-read canary tests (2026-11-19): the eval that measures whether
 * edit/write calls are preceded by a read of the target in the same session
 * (the behavior AG/WB enforce at the gate). Core parsing is pure; the CLI
 * wraps it over the sessions tree.
 * Run: node --test tests/gate/eval/pre-edit-read.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { measureSession } from "./pre-edit-read.mjs";

const call = (id, name, args) =>
  JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
const ok = (id) =>
  JSON.stringify({ message: { role: "toolResult", toolCallId: id, toolName: "x", isError: false, content: [{ type: "text", text: "out" }] } });

test("measureSession: edit/write count as pre-read only when the target was read earlier", () => {
  const s = [
    call("r1", "piread", { path: "/w/a.ts", offset: 1, limit: 20 }), ok("r1"),
    call("e1", "piedit", { path: "/w/a.ts", edits: [] }), ok("e1"),
    call("e2", "piedit", { path: "/w/b.ts", edits: [] }), ok("e2"),
    call("w1", "piwrite", { path: "/w/a.ts", content: "x" }), ok("w1"),
    call("w2", "piwrite", { path: "/w/new.ts", content: "x" }), ok("w2"),
  ].join("\n");
  const m = measureSession(s);
  assert.equal(m.editWriteCalls, 4);
  // a.ts read then edited: pre-read. b.ts edited unread: not. a.ts overwritten after
  // read: pre-read. new.ts is a new file — piwrite to an unread path that did not
  // exist before cannot be pre-read and is not counted against the rate.
  assert.equal(m.preRead, 2);
  assert.equal(m.newFileWrites, 1);
});

test("measureSession: reads after the edit do not count; relative and absolute paths normalize", () => {
  const s = [
    call("e1", "piedit", { path: "src/a.ts", edits: [] }), ok("e1"),
    call("r1", "read", { path: "src/a.ts" }), ok("r1"),
    call("r2", "piread", { path: "src/b.ts" }), ok("r2"),
    call("e2", "edit", { path: "src/b.ts", edits: [] }), ok("e2"),
  ].join("\n");
  const m = measureSession(s);
  assert.equal(m.editWriteCalls, 2);
  assert.equal(m.preRead, 1);
});

test("measureSession: counts Anchor Guard Unread blocks and read-after-block recovery", () => {
  const block = (id, text) =>
    JSON.stringify({ message: { role: "toolResult", toolCallId: id, toolName: "piedit", isError: true, content: [{ type: "text", text }] } });
  const s = [
    call("e1", "piedit", { path: "/w/c.ts", edits: [] }),
    block("e1", "Anchor Guard (Unread): '/w/c.ts' not read this session — read it first"),
    call("r1", "piread", { path: "/w/c.ts" }), ok("r1"),
    call("e2", "piedit", { path: "/w/d.ts", edits: [] }),
    block("e2", "Anchor Guard (Unread): '/w/d.ts' not read this session — read it first"),
    call("e3", "piedit", { path: "/w/d.ts", edits: [] }),
    block("e3", "Anchor Guard (Unread): '/w/d.ts' not read this session"),
  ].join("\n");
  const m = measureSession(s);
  assert.equal(m.unreadBlocks, 3);
  assert.equal(m.recoveredByRead, 1);
});
