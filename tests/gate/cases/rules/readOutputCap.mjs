// Permission-gate cases for rules.readOutputCap.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, read, piread, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- H1b (2026-10-21): reads had no post-cap — a wide read window rode into context whole ----
  [
    "H1b: oversized piread output is capped with spill pointer",
    "pass",
    async (pi) => {
      const id = `rcap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "piread",
        toolCallId: id,
        input: { path: "big.ts", offset: 1, limit: 500 },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piread",
        toolCallId: id,
        input: { path: "big.ts", offset: 1, limit: 500 },
        content: textBlocks(
          Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n"),
        ),
        isError: false,
      });
      const t = r?.content?.[0]?.text ?? "";
      const ok = r && t.startsWith("line 1\n") && t.includes("read capped") && t.includes("pgate-spill");
      return ok
        ? { blocked: false }
        : { blocked: true, reason: `read cap missing: ${JSON.stringify(r).slice(0, 160)}` };
    },
  ],
  [
    "H1b: a read within 300 lines / 8KB passes uncapped",
    "pass",
    async (pi) => {
      const id = `rcap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "piread",
        toolCallId: id,
        input: { path: "small.ts", offset: 1, limit: 100 },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piread",
        toolCallId: id,
        input: { path: "small.ts", offset: 1, limit: 100 },
        content: textBlocks(
          Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
        ),
        isError: false,
      });
      return r === undefined || r === null
        ? { blocked: false }
        : { blocked: true, reason: `small read was capped: ${JSON.stringify(r).slice(0, 120)}` };
    },
  ],
  [
    "H1b: byte flood under the line cap is still capped",
    "pass",
    async (pi) => {
      const id = `rcap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "piread",
        toolCallId: id,
        input: { path: "wide.ts", offset: 1, limit: 50 },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piread",
        toolCallId: id,
        input: { path: "wide.ts", offset: 1, limit: 50 },
        content: textBlocks(
          Array.from({ length: 50 }, () => "x".repeat(500)).join("\n"),
        ),
        isError: false,
      });
      const t = r?.content?.[0]?.text ?? "";
      return t.includes("read capped") && t.length < 25_000
        ? { blocked: false }
        : { blocked: true, reason: `wide-line flood not byte-capped: len=${t.length}` };
    },
  ],
  [
    "H1b: an image read result is never capped",
    "pass",
    async (pi) => {
      const id = `rcap${nextId()}`;
      const input = { path: "pic.png" };
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "read",
        toolCallId: id,
        input,
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "read",
        toolCallId: id,
        input,
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
        ],
        isError: false,
      });
      return r === undefined || r === null
        ? { blocked: false }
        : { blocked: true, reason: "image result was capped" };
    },
  ],
];
