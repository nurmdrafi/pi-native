#!/usr/bin/env node
/** WB (writeBindingGuard) + R1 (reReadGuard) — the off rung: with the rule
 * off, its block tier must not fire. The write-binding blocks (Unread/Stale)
 * were unconditional before WB existed, and R1's full-coverage block fired
 * under the read-family wrap without checking its own key; both are keyed
 * now. This file pins the off behavior. Run: node --test tests/gate/
 * write-binding-off.test.mjs  (env set BEFORE the import). */
process.env.PGATE_CONFIG = new URL("./fixtures/rules-calibrated.json", import.meta.url).pathname;
process.env.PGATE_WRITE_BINDING_GUARD = "0";
process.env.PGATE_RE_READ_GUARD = "0";

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
const dir = mkdtempSync(join(tmpdir(), "pgate-wb-off-"));
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
async function write(path, content) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, content };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "write", toolCallId, input });
  if (block) return `BLOCKED: ${block.reason.slice(0, 100)}`;
  writeFileSync(path, content);
  await pi.invoke("tool_result", {
    type: "tool_result", toolName: "write", toolCallId, input,
    content: textBlocks("ok"), isError: false,
  });
  return "write ok";
}

// 1. WB off: overwrite of a never-read existing file passes
const f = join(dir, "never-read.ts");
writeFileSync(f, lineText(60));
const r1 = await write(f, lineText(30));
check("WB off: never-read overwrite passes", r1 === "write ok", r1);

// 2. WB off: external drift between read and write passes (Stale tier off)
const g = join(dir, "drift.ts");
writeFileSync(g, lineText(60));
check("setup: initial read ok", (await piread(g, 1, 10)) === "read ok");
writeFileSync(g, lineText(70)); // external edit: size + mtime drift
const r2 = await write(g, lineText(30));
check("WB off: drifted overwrite passes", r2 === "write ok", r2);

// 3. R1 off: a fully-covered re-read passes (block tier keyed to its own rule)
const h = join(dir, "covered.ts");
writeFileSync(h, lineText(60));
check("setup: window read ok", (await piread(h, 1, 5)) === "read ok");
const r3 = await piread(h, 1, 5);
check("R1 off: fully-covered re-read passes", r3 === "read ok", r3);

console.log(failed === 0 ? `\n3/3 PASS` : `\n${failed}/3 FAILED`);
process.exit(failed === 0 ? 0 : 1);
