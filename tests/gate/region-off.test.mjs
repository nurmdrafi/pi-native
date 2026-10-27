#!/usr/bin/env node
/** AG2 (editRegionGuard) — the Claude-Code-parity rung: with the rule off,
 * an edit needs only that the PATH was read this session (file-level), not
 * that the target region itself is certified. Blind-edit protection (the
 * never-read block) must stay. Mirrors research 2026-10-25: Claude Code's
 * Edit enforces read-file + exact-match + uniqueness, but no region check.
 * Run: node tests/pgate-region-off.test.mjs  (env set BEFORE the import). */
process.env.PGATE_EDIT_REGION_GUARD = "0";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = await import("../../extensions/permission-gate/index.ts");

function makePi() {
  const lists = new Map();
  return {
    on: (event, handler) => {
      const l = lists.get(event) ?? [];
      l.push(handler);
      lists.set(event, l);
      return () => lists.set(event, (lists.get(event) ?? []).filter((h) => h !== handler));
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
const pi = makePi();
gate.default(pi);

let seqId = 0;
const textBlocks = (s) => [{ type: "text", text: s }];
const lineText = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const dir = mkdtempSync(join(tmpdir(), "pgate-ag2-"));
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failed++;
};

async function piread(path, offset, limit) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, offset, limit };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "piread", toolCallId, input });
  if (block) return `BLOCKED: ${block.reason}`;
  await pi.invoke("tool_result", {
    type: "tool_result", toolName: "piread", toolCallId, input,
    content: textBlocks(lineText(limit)),
    details: { truncation: { truncated: false, outputLines: limit, totalLines: 60 } },
    isError: false,
  });
  return "read ok";
}
async function edit(path, edits) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, edits };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "edit", toolCallId, input });
  return block ? `BLOCKED: ${block.reason.slice(0, 100)}` : "edit ok";
}

// 1. file-level mode: path read (lines 1-5 only) + edit far outside the read
const f = join(dir, "region.ts");
writeFileSync(f, lineText(60));
check("partial read ok", (await piread(f, 1, 5)) === "read ok");
const r1 = await edit(f, [{ oldText: "line 30", newText: "LINE30" }]);
check("AG2 off: edit outside the read window passes (file-level)", r1 === "edit ok", r1);

// 2. blind-edit protection survives the rung: never-read file still blocks
const g = join(dir, "blind.ts");
writeFileSync(g, lineText(60));
const r2 = await edit(g, [{ oldText: "line 30", newText: "LINE30" }]);
check("AG2 off: never-read file still blocks", r2.startsWith("BLOCKED: Anchor Guard (Unread)"), r2);

// 3. exact-anchor validation itself still runs (bogus oldText rejected)
const r3 = await edit(f, [{ oldText: "no such line anywhere", newText: "x" }]);
check("AG2 off: not-found anchor still blocks", r3.startsWith("BLOCKED: Anchor Guard"), r3);

console.log(failed === 0 ? `\n3/3 PASS` : `\n${failed}/3 FAILED`);
process.exit(failed === 0 ? 0 : 1);
