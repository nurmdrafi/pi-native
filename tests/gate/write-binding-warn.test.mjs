#!/usr/bin/env node
/** WB (writeBindingGuard) at the warn rung — the overwrite-unread note.
 * 2026-11-22 harness-watch misfire (career-ops session, 9 piwrites + 5
 * pireads): at warn the write RUNS and its tool_result certifies spans
 * 1–EOF, so the block-tier remedy ("read it before overwriting") prescribes
 * a read that R1 (reReadGuard, error) then refuses as a duplicate — a
 * guard-vs-guard deadlock. The warn note must teach post-hoc instead: name
 * the overwrite, say the new content is in context, defer the read to the
 * next overwrite. Run: node --test tests/gate/write-binding-warn.test.mjs
 * (env set BEFORE the import). */
process.env.PGATE_CONFIG = new URL("./fixtures/rules-calibrated.json", import.meta.url).pathname;
process.env.PGATE_WRITE_BINDING_GUARD = "warn";
process.env.PGATE_RE_READ_GUARD = "error";

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
const dir = mkdtempSync(join(tmpdir(), "pgate-wb-warn-"));
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!cond) failed++;
};

async function write(path, content) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, content };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "piwrite", toolCallId, input });
  if (block) return { blocked: true, reason: block.reason, note: "" };
  writeFileSync(path, content);
  const res = await pi.invoke("tool_result", {
    type: "tool_result", toolName: "piwrite", toolCallId, input,
    content: textBlocks("Successfully wrote"), isError: false,
  });
  const note = (res?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  return { blocked: false, reason: "", note };
}

async function piread(path, offset, limit) {
  const toolCallId = `tc${++seqId}`;
  const input = { path, offset, limit };
  const block = await pi.invoke("tool_call", { type: "tool_call", toolName: "piread", toolCallId, input });
  if (block) return `BLOCKED: ${block.reason.slice(0, 90)}`;
  await pi.invoke("tool_result", {
    type: "tool_result", toolName: "piread", toolCallId, input,
    content: textBlocks(lineText(limit)),
    details: { truncation: { truncated: false, outputLines: limit, totalLines: 60 } },
    isError: false,
  });
  return "read ok";
}

// 1. warn tier: the overwrite runs and the note teaches post-hoc — it must
// NOT carry the block-tier remedy, because the write's own result certifies
// the whole file and R1 will refuse that read (the deadlock).
const f = join(dir, "never-read.ts");
writeFileSync(f, lineText(60));
const w1 = await write(f, lineText(30));
check("WB warn: overwrite of a never-read file runs", !w1.blocked, w1.reason.slice(0, 70));
check(
  "WB warn: note names the unread overwrite",
  /Anchor Guard/.test(w1.note) && /without a read this session/.test(w1.note),
  w1.note.slice(0, 90),
);
check(
  "WB warn: note does not prescribe the read R1 will refuse",
  !/read it before overwriting/i.test(w1.note),
  w1.note.slice(0, 90),
);

// 2. the refused read, pinned as the reason the note must not ask for it:
// after the warn-tier write, spans 1–EOF are certified, so a piread of the
// file is an R1 duplicate — the block-tier remedy is unsatisfiable here.
const rr = await piread(f, 1, 10);
check("R1: post-write read is a duplicate (spans 1–EOF certified)", rr.startsWith("BLOCKED: Token Economy (Re-read)"), rr);

// 3. the note defers the read to the NEXT overwrite: after reading the file
// (coverage now real), a second overwrite must pass without any WB note.
const readBack = await piread(f, 1, 5).catch(() => "blocked");
// R1 blocks full-window duplicates; offset 1 limit 5 is inside 1–EOF —
// clear coverage first by simulating the only sanctioned path: a fresh file.
const g = join(dir, "second.ts");
writeFileSync(g, lineText(60));
const w2a = await write(g, lineText(30)); // warn-tier overwrite, certifies 1–EOF
const w2b = await write(g, lineText(20)); // covered now — no Unread warn expected
check("WB warn: covered re-overwrite raises no Unread note", !/Unread|without a read this session/.test(w2b.note), w2b.note.slice(0, 90));

console.log(failed === 0 ? `\n5/5 PASS` : `\n${failed}/5 FAILED`);
process.exit(failed === 0 ? 0 : 1);
