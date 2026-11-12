#!/usr/bin/env node
/** R1c self-serve refusal (2026-11-12 churn audit: 554 locate-first refusals
 * across 119 sessions): a wide window on a never-searched path must be
 * blocked with a READY-TO-RUN rg command built from the refused path — and
 * that exact command, replayed through the gate's own crediting chain
 * (splitSegments → normalizeSegment → searchedPathsFrom), must credit the
 * refused path so the follow-up read passes with no second refusal.
 * Run: node --test tests/gate/locate-selfserve.test.mjs  (exit 0 = all pass) */
process.env.PGATE_CONFIG = new URL(
  "./fixtures/rules-calibrated.json",
  import.meta.url,
).pathname;

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = await import("../../extensions/permission-gate/index.ts");
const { searchedPathsFrom } = await import(
  "../../extensions/permission-gate/rules/search-guard.ts"
);
const { normPath } = await import(
  "../../extensions/permission-gate/rules/read-coverage.ts"
);
const { normalizeSegment, splitSegments } = await import(
  "../../extensions/permission-gate/rules/destructive.ts"
);

function makePi() {
  const lists = new Map();
  return {
    on: (event, handler) => {
      const l = lists.get(event) ?? [];
      l.push(handler);
      lists.set(event, l);
      return () =>
        lists.set(event, (lists.get(event) ?? []).filter((h) => h !== handler));
    },
    invoke: async (event, ev, ctx) => {
      let result;
      for (const h of lists.get(event) ?? []) {
        const r = await h(ev, ctx);
        if (r !== undefined) result = r;
      }
      return result;
    },
  };
}
const lineText = (n) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

const root = mkdtempSync(join(tmpdir(), "pgate-r1c-selfserve-"));
mkdirSync(join(root, "docs/guide"), { recursive: true });
const relFile = "docs/guide/api.md";
const absFile = join(root, relFile);
writeFileSync(absFile, lineText(300));
const spacedRel = "docs/with space.md";
writeFileSync(join(root, spacedRel), lineText(300));

test("R1c refusal embeds a ready-to-run rg command that self-credits the refused path", async () => {
  const pi = makePi();
  gate.default(pi);
  const input = { path: relFile, offset: 1, limit: 150 };
  const block = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "piread", toolCallId: "tc1", input },
    { cwd: root },
  );
  assert.ok(block?.block, `wide read should still block (got: ${block})`);
  assert.match(block.reason, /Locate-first:/);
  const m = block.reason.match(/rg -n -F '([^']+)' ([^`\s]+)/);
  assert.ok(m, `refusal must carry an rg -n -F command, got: ${block.reason}`);
  assert.equal(m[1], "api.md", "pattern is the file's basename");
  assert.equal(m[2], relFile, "target is the path as typed");

  // replay the emitted command through the gate's own crediting chain —
  // the same normalization searchedPathsFrom sees on a real bash tool_call
  const segs = splitSegments(m[0]).map(normalizeSegment);
  const credited = searchedPathsFrom(segs, root, normPath, existsSync);
  assert.ok(
    credited.includes(normPath(relFile, root)),
    `credit function must name the refused path, got: ${credited}`,
  );

  // live replay: firing the suggested command as a bash call credits the
  // path, and the SAME wide read then passes — no second refusal
  const bashBlock = await pi.invoke(
    "tool_call",
    {
      type: "tool_call",
      toolName: "pibash",
      toolCallId: "tc2",
      input: { command: m[0] },
    },
    { cwd: root },
  );
  assert.equal(bashBlock, undefined, "suggested command must itself run");
  const pass = await pi.invoke(
    "tool_call",
    { type: "tool_call", toolName: "piread", toolCallId: "tc3", input },
    { cwd: root },
  );
  assert.equal(pass, undefined, "same wide read must pass after the search");
});

test("R1c refusal keeps generic wording when the path is not a safe single token", async () => {
  const pi = makePi();
  gate.default(pi);
  const block = await pi.invoke(
    "tool_call",
    {
      type: "tool_call",
      toolName: "piread",
      toolCallId: "tc1",
      input: { path: spacedRel, offset: 1, limit: 150 },
    },
    { cwd: root },
  );
  assert.ok(block?.block, `wide read should still block (got: ${block})`);
  assert.match(block.reason, /Locate-first:/);
  assert.doesNotMatch(
    block.reason,
    /rg -n -F 'docs\/with space\.md'/,
    "no quotable-literal command for a path a single token cannot carry",
  );
});
