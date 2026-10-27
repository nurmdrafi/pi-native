// Permission-gate cases for rules.phaseNudge.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, read, edit, editApplied, bash } from "../../harness/helpers.mjs";

export const cases = [
  // ---- PH1 phase label (2026-10-27): descriptive only, one note per turn ----
  [
    "PH1: a verify failure after an edit notes the phase once and never blocks",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "ph1-"));
      const f = join(dir, "p.md");
      writeFileSync(f, "P1\nP2\n");
      await read(pi, f);
      const e = await editApplied(pi, f, "P1", "P1x");
      if (e.blocked) return { blocked: true, reason: `edit blocked: ${e.reason?.slice(0, 60)}` };
      const noted = (r) =>
        !!r?.content?.some((c) => c.type === "text" && c.text.includes("Phase (PH1)"));
      const failVerify = async (id, cmd) => {
        const input = { command: cmd };
        const b = await pi.invoke("tool_call", {
          type: "tool_call", toolName: "bash", toolCallId: id, input,
        });
        if (b) return { blocked: true };
        return {
          blocked: false,
          r: await pi.invoke("tool_result", {
            type: "tool_result", toolName: "bash", toolCallId: id, input,
            content: textBlocks("boom"), isError: true,
          }),
        };
      };
      const a = await failVerify("ph1a", "npm test");
      if (a.blocked) return { blocked: true, reason: "phase note must not block" };
      if (!noted(a.r)) return { blocked: true, reason: "no PH1 note after edit -> failed verify" };
      const b2 = await failVerify("ph1b", "npm test -- --watch=false");
      if (noted(b2.r)) return { blocked: true, reason: "PH1 noted twice in one turn" };
      return { blocked: false };
    },
  ],
  [
    "PH1: a new user turn re-arms the phase note",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "ph1b-"));
      const f = join(dir, "q.md");
      writeFileSync(f, "Q1\nQ2\nQ3\n");
      await read(pi, f);
      const cycle = async (tag, old) => {
        await pi.invoke("before_agent_start", {
          type: "before_agent_start", messageType: "user", prompt: `turn ${tag}`,
          systemPromptOptions: {},
        });
        const e = await editApplied(pi, f, old, `${old}x`);
        if (e.blocked) return { blocked: true };
        const input = { command: "cargo test" };
        const b = await pi.invoke("tool_call", {
          type: "tool_call", toolName: "bash", toolCallId: `ph1-${tag}`, input,
        });
        if (b) return { blocked: true };
        const r = await pi.invoke("tool_result", {
          type: "tool_result", toolName: "bash", toolCallId: `ph1-${tag}`, input,
          content: textBlocks("boom"), isError: true,
        });
        return {
          blocked: false,
          noted: !!r?.content?.some(
            (c) => c.type === "text" && c.text.includes("Phase (PH1)"),
          ),
        };
      };
      const t1 = await cycle("one", "Q1");
      if (t1.blocked || !t1.noted)
        return { blocked: true, reason: "PH1 note missing in the first turn" };
      const t2 = await cycle("two", "Q3");
      if (t2.blocked || !t2.noted)
        return { blocked: true, reason: "PH1 note did not re-arm on the next turn" };
      return { blocked: false };
    },
  ],
];
