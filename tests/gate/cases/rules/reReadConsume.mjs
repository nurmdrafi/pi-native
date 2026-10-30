// Permission-gate cases for rules.reReadConsume.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, lineText, rawRead, noteOf, read, piread, edit, runEdit, bash, compact } from "../../harness/helpers.mjs";

export const cases = [
  // ---- R1x (2026-10-26 session audit): partial-overlap re-read note ----
  // 144 reads/wk re-fetched ≥50% already-rendered lines that R1 (full
  // coverage only) let through; the note is non-blocking at the shipped
  // warn severity — it corrects ledgering, it does not gate the read.
  [
    "R1x: >=50% overlap re-read appends a non-blocking note",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "r1x-a-"));
      const f = join(dir, "f.md");
      writeFileSync(f, lineText(100) + "\n");
      await rawRead(pi, "r1xa1", f, { offset: 10, limit: 40 }, 40);
      const { block, res } = await rawRead(pi, "r1xa2", f, { offset: 30, limit: 40 }, 40);
      if (block)
        return { blocked: true, reason: `warn tier must not block: ${block.reason.slice(0, 80)}` };
      const note = noteOf(res);
      if (!note.includes("Token Economy (Re-read)") || !note.includes("50%"))
        return { blocked: true, reason: `expected overlap note, got: ${note.slice(0, 80)}` };
      return { blocked: false };
    },
  ],
  [
    "R1x: <50% overlap re-read stays silent",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "r1x-b-"));
      const f = join(dir, "f.md");
      writeFileSync(f, lineText(100) + "\n");
      await rawRead(pi, "r1xb1", f, { offset: 10, limit: 40 }, 40);
      // 45–84 overlaps 10–49 by 5 of 40 lines (12.5%) — below the bar
      const { block, res } = await rawRead(pi, "r1xb2", f, { offset: 45, limit: 40 }, 40);
      if (block) return { blocked: true, reason: block.reason.slice(0, 80) };
      if (noteOf(res).includes("Token Economy (Re-read)"))
        return { blocked: true, reason: "12.5% overlap must not note" };
      return { blocked: false };
    },
  ],
  [
    "R1x: stat-stale coverage never notes",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "r1x-c-"));
      const f = join(dir, "f.md");
      writeFileSync(f, lineText(100) + "\n");
      await rawRead(pi, "r1xc1", f, { offset: 10, limit: 40 }, 40);
      writeFileSync(f, lineText(100) + "\nexternal edit\n"); // size+mtime drift
      const { block, res } = await rawRead(pi, "r1xc2", f, { offset: 30, limit: 40 }, 40);
      if (block) return { blocked: true, reason: block.reason.slice(0, 80) };
      if (noteOf(res).includes("Token Economy (Re-read)"))
        return { blocked: true, reason: "stale stat must skip the note" };
      return { blocked: false };
    },
  ],
  [
    "R1x: same-batch duplicate window notes the second result only",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "r1x-d-"));
      const f = join(dir, "f.md");
      writeFileSync(f, lineText(100) + "\n");
      // both calls fire before any result — the batch-slip shape
      const in1 = { path: f, offset: 10, limit: 40 };
      const in2 = { path: f, offset: 22, limit: 40 }; // 28/40 = 70% overlap
      const b1 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "piread", toolCallId: "r1xd1", input: in1,
      });
      const b2 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "piread", toolCallId: "r1xd2", input: in2,
      });
      if (b1 || b2)
        return { blocked: true, reason: `warn tier must not block: ${(b1 ?? b2)?.reason.slice(0, 70)}` };
      const r1 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "piread", toolCallId: "r1xd1", input: in1,
        content: textBlocks(lineText(40)),
        details: { truncation: { truncated: false, outputLines: 40, totalLines: 100 } },
        isError: false,
      });
      const r2 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "piread", toolCallId: "r1xd2", input: in2,
        content: textBlocks(lineText(40)),
        details: { truncation: { truncated: false, outputLines: 40, totalLines: 100 } },
        isError: false,
      });
      if (noteOf(r1).includes("Token Economy (Re-read)"))
        return { blocked: true, reason: "first result must stay clean" };
      if (!noteOf(r2).includes("Token Economy (Re-read)"))
        return { blocked: true, reason: "second result must carry the note" };
      return { blocked: false };
    },
  ],
  [
    "AG: 2nd anchor miss on a file in a turn appends loop-break hint",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "ag-miss-"));
      const f = join(dir, "f.md");
      writeFileSync(f, "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n");
      await read(pi, f);
      const miss = (bad) => runEdit(pi, f, [{ oldText: bad, newText: "x" }]);
      const m1 = await miss("NOPE-ONE");
      if (m1.blocked) return { blocked: true, reason: "first miss must not block" };
      if (noteOf(m1).includes("miss 2"))
        return { blocked: true, reason: "first miss must not carry the hint" };
      const m2 = await miss("NOPE-TWO");
      if (m2.blocked) return { blocked: true, reason: "second miss must not block" };
      if (!noteOf(m2).includes("miss 2 on this file this turn"))
        return { blocked: true, reason: `second miss must carry the hint: ${noteOf(m2).slice(0, 90) || "(none)"}` };
      // per-user-turn reset: a new turn starts the count over
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: "next turn", systemPromptOptions: {},
      });
      const m3 = await miss("NOPE-THREE");
      return !m3.blocked && !noteOf(m3).includes("miss 2 on this file this turn")
        ? { blocked: false }
        : { blocked: true, reason: `count must reset per user turn: ${noteOf(m3).slice(0, 60) || "(none)"}` };
    },
  ],
  [
    "cadence: nudge is non-blocking, appended once to a tool_result",
    "pass",
    async (pi) => {
      for (let i = 0; i < 200; i++)
        await pi.invoke("before_agent_start", {
          type: "before_agent_start", messageType: "user",
          prompt: `msg ${i}`,
          systemPromptOptions: {},
        });
      const b = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "pibash",
        toolCallId: "cad1",
        input: { command: "echo hi" },
      });
      if (b)
        return {
          blocked: true,
          reason: `nudge must not block: ${b.reason.slice(0, 80)}`,
        };
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "pibash",
        toolCallId: "cad1",
        input: { command: "echo hi" },
        content: textBlocks("ok"),
        isError: false,
      });
      if (
        !r ||
        !r.content?.some(
          (c) => c.type === "text" && c.text.includes("Cadence:"),
        )
      )
        return { blocked: true, reason: "nudge missing from tool_result" };
      const b2 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "pibash",
        toolCallId: "cad2",
        input: { command: "echo again" },
      });
      if (b2) return { blocked: true, reason: "second call blocked" };
      const r2 = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "pibash",
        toolCallId: "cad2",
        input: { command: "echo again" },
        content: textBlocks("ok"),
        isError: false,
      });
      return r2 === undefined
        ? { blocked: false }
        : { blocked: true, reason: "nudge fired twice" };
    },
  ],
  [
    "cadence: resets after session_compact",
    "pass",
    async (pi) => {
      for (let i = 0; i < 200; i++)
        await pi.invoke("before_agent_start", {
          type: "before_agent_start", messageType: "user",
          prompt: `m${i}`,
          systemPromptOptions: {},
        });
      await compact(pi);
      const b = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "pibash",
        toolCallId: "cad3",
        input: { command: "echo hi" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "pibash",
        toolCallId: "cad3",
        input: { command: "echo hi" },
        content: textBlocks("ok"),
        isError: false,
      });
      return !b && r === undefined
        ? { blocked: false }
        : { blocked: true, reason: "cadence did not reset on compaction" };
    },
  ],
];
