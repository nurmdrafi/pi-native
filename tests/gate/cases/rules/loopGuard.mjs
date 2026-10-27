// Permission-gate cases for rules.loopGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, read, edit, editApplied, bash, runBash } from "../../harness/helpers.mjs";

export const cases = [
  // ---- 1b — LG1 Loop Guard (2026-10-26, week of session evidence) ----
  // Same-target churn, not error streaks, is the observed grind (worst
  // session: task.md x9, index.ts x8 within single user-turns; no session
  // hit 4 consecutive errors). Calibrated: note at the 4th landed same-file
  // mutation; the 7th arms a one-shot block of that path's next mutation;
  // 3 consecutive tool errors note once. All counters reset per user turn.
  [
    "LG1: 4th same-file edit in a turn notes once, non-blocking",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "lg1-note-"));
      const f = join(dir, "f.md");
      writeFileSync(f, "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n");
      await read(pi, f);
      for (let i = 1; i <= 3; i++)
        await editApplied(pi, f, `L${i}`, `L${i}x`);
      const noted = (r) =>
        !!r?.content?.some(
          (c) => c.type === "text" && c.text.includes("Loop Guard (LG1)"),
        );
      // 4th: manual cycle to capture the tool_result handler's return
      const in4 = { path: f, edits: [{ oldText: "L4", newText: "L4x" }] };
      const b4 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "edit", toolCallId: "lg1n4", input: in4,
      });
      if (b4)
        return { blocked: true, reason: `4th edit must pass: ${b4.reason.slice(0, 80)}` };
      writeFileSync(f, readFileSync(f, "utf8").replace("L4", "L4x"));
      const r4 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "edit", toolCallId: "lg1n4", input: in4,
        content: textBlocks("ok"), isError: false,
      });
      if (!noted(r4))
        return { blocked: true, reason: "no LG1 note on the 4th same-file edit" };
      // 5th: fires once per target per turn
      const in5 = { path: f, edits: [{ oldText: "L5", newText: "L5x" }] };
      const b5 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "edit", toolCallId: "lg1n5", input: in5,
      });
      if (b5) return { blocked: true, reason: `5th edit must pass: ${b5.reason.slice(0, 80)}` };
      writeFileSync(f, readFileSync(f, "utf8").replace("L5", "L5x"));
      const r5 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "edit", toolCallId: "lg1n5", input: in5,
        content: textBlocks("ok"), isError: false,
      });
      return noted(r5)
        ? { blocked: true, reason: "LG1 note fired twice for one target" }
        : { blocked: false };
    },
  ],
  [
    "LG1: after 7 landed same-file edits, that path's next edit blocks once",
    "blocked",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "lg1-block-"));
      const f = join(dir, "f.md");
      writeFileSync(f, "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\n");
      await read(pi, f);
      for (let i = 1; i <= 7; i++)
        await editApplied(pi, f, `L${i}`, `L${i}x`);
      const b8 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "edit", toolCallId: "lg1b8",
        input: { path: f, edits: [{ oldText: "L8", newText: "L8x" }] },
      });
      if (!b8) return { blocked: false };
      if (!b8.reason.includes("Loop Guard (LG1)") || !b8.reason.includes("ask the user"))
        return { blocked: false };
      // one-shot: the next call to the same path must pass again
      const b9 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "edit", toolCallId: "lg1b9",
        input: { path: f, edits: [{ oldText: "L9", newText: "L9x" }] },
      });
      return b9
        ? { blocked: false }
        : { blocked: true };
    },
  ],
  [
    "LG1: counters reset on the next user turn",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "lg1-reset-"));
      const f = join(dir, "f.md");
      writeFileSync(f, "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\n");
      await read(pi, f);
      for (let i = 1; i <= 7; i++)
        await editApplied(pi, f, `L${i}`, `L${i}x`);
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user", prompt: "go on",
        systemPromptOptions: {},
      });
      const b = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "edit", toolCallId: "lg1r8",
        input: { path: f, edits: [{ oldText: "L8", newText: "L8x" }] },
      });
      return b
        ? { blocked: true, reason: `reset failed: ${b.reason.slice(0, 80)}` }
        : { blocked: false };
    },
  ],
  [
    "LG1: 3 consecutive bash errors get a one-time note, success resets",
    "pass",
    async (pi) => {
      await runBash(pi, "ls /lg1-nope1", { error: true });
      await runBash(pi, "ls /lg1-nope2", { error: true });
      const noted = (r) =>
        !!r?.content?.some(
          (c) => c.type === "text" && c.text.includes("Loop Guard (LG1)"),
        );
      const b3 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "bash", toolCallId: "lg1e3",
        input: { command: "ls /lg1-nope3" },
      });
      if (b3)
        return { blocked: true, reason: `error streak must not block: ${b3.reason.slice(0, 80)}` };
      const r3 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "bash", toolCallId: "lg1e3",
        input: { command: "ls /lg1-nope3" }, content: textBlocks("boom"), isError: true,
      });
      if (!noted(r3))
        return { blocked: true, reason: "no LG1 note on the 3rd consecutive error" };
      const b4 = await pi.invoke("tool_call", {
        type: "tool_call", toolName: "bash", toolCallId: "lg1e4",
        input: { command: "echo lg1-ok" },
      });
      if (b4) return { blocked: true, reason: `success must pass: ${b4.reason.slice(0, 80)}` };
      const r4 = await pi.invoke("tool_result", {
        type: "tool_result", toolName: "bash", toolCallId: "lg1e4",
        input: { command: "echo lg1-ok" }, content: textBlocks("ok"), isError: false,
      });
      return noted(r4)
        ? { blocked: true, reason: "LG1 error note fired on a success" }
        : { blocked: false };
    },
  ],
];
