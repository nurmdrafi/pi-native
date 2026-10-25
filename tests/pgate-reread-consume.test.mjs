#!/usr/bin/env node
/** R1x (reReadConsume) — Command-Code-style self-expiring re-read guard.
 * With the rule armed (default OFF), the FIRST R1 block spends exactly the
 * certification it cited (the covering span, clipped — not the whole path):
 * an identical resend passes and re-certifies, so the worst case is one
 * wasted turn, never a guessing loop; spans outside the consumed window
 * keep their edit anchors. Motivated 2026-10-25 by a live false block
 * (display-layer elision certifies whole while the bytes were never shown)
 * that §9 does not model. Mirrors research: commandcode.ai read tool ships
 * "unchanged-read dedup that consumes itself on hit".
 * Default behavior is unchanged — R1 keeps blocking duplicates, pinned by
 * the R1 cases in permission-gate.test.mjs.
 * Run: node tests/pgate-reread-consume.test.mjs  (env set BEFORE the import). */
process.env.PGATE_RE_READ_CONSUME = "1";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gate = await import("../extensions/permission-gate/index.ts");

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
const dir = mkdtempSync(join(tmpdir(), "pgate-r1x-"));
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failed++;
};

async function piread(path, offset, limit) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, offset, limit };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "piread", toolCallId, input });
  if (block) return `BLOCKED: ${block.reason.slice(0, 100)}`;
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

// 1. self-expiring: first dup blocks, identical resend passes, re-certifies
const f = join(dir, "consume.ts");
writeFileSync(f, lineText(60));
check("initial read ok", (await piread(f, 1, 60)) === "read ok");
const b1 = await piread(f, 10, 20);
check("first dup read blocks (R1 fires once)", b1.startsWith("BLOCKED: Token Economy (Re-read)"), b1);
const b2 = await piread(f, 10, 20);
check("identical resend passes (record consumed)", b2 === "read ok", b2);
const b3 = await piread(f, 10, 20);
check("resend re-certifies: next dup blocks again", b3.startsWith("BLOCKED: Token Economy (Re-read)"), b3);

// 2. precise consume: the covering span is CLIPPED, neighboring anchors live
const g = join(dir, "precise.ts");
writeFileSync(g, lineText(60));
await piread(g, 1, 60);
const c1 = await piread(g, 10, 20);
check("first dup blocks (setup)", c1.startsWith("BLOCKED: Token Economy (Re-read)"), c1);
const e1 = await edit(g, [{ oldText: "line 40", newText: "LINE40" }]);
check("edit in still-certified region passes (clip, not path wipe)", e1 === "edit ok", e1);
const e2 = await edit(g, [{ oldText: "line 15", newText: "LINE15" }]);
check("edit inside the consumed gap loses its region certification", e2.startsWith("BLOCKED: Anchor Guard"), e2);

console.log(failed === 0 ? `\n5/5 PASS` : `\n${failed}/5 FAILED`);
process.exit(failed === 0 ? 0 : 1);
