// Permission-gate cases for rules.outputCap.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, bash, tmp, fileA, tinyFile, bigFile, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- H1 (2026-10-08): R2 viewing blocks deleted — output capped in tool_result ----
  [
    "standalone cat viewing is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, "cat package.json"),
  ],
  [
    "standalone head viewing is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, "head -40 config.json.example"),
  ],
  [
    "standalone tail viewing is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, "tail -20 CHANGELOG.md"),
  ],
  [
    "tail -f watcher is not viewing",
    "pass",
    async (pi) => bash(pi, "tail -f /tmp/server.log"),
  ],
  [
    "sed -n batching 2+ regions passes",
    "pass",
    async (pi) => bash(pi, "sed -n '1p;5p' notes.md"),
  ],
  [
    "sed s///p substitution-print passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        "sed -n \"s/^export const APP_VERSION = '\\(.*\\)'$/\\1/p\" src/version.js",
      ),
  ],
  // ---- 2026-10-08 extensions audit: distributed sed batch + trivial batched cat ----
  [
    "distributed sed batch (;-joined, 2 regions) passes",
    "pass",
    async (pi) => bash(pi, `sed -n '1,2p' ${fileA}; sed -n '3p' ${fileA}`),
  ],
  [
    "distributed sed batch inside a longer batched command passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        `date -u; sed -n '1,2p' ${fileA}; sed -n '2,3p' ${fileA}; rg -n x ${fileA} | head -3`,
      ),
  ],
  [
    "lone sed region inside a batched command is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, `date -u; sed -n '1,2p' ${fileA}`),
  ],
  [
    "tiny cat inside a batched command passes",
    "pass",
    async (pi) => bash(pi, `date -u; cat ${tinyFile}; ls ${tmp}`),
  ],
  [
    "tiny cat standalone is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, `cat ${tinyFile}`),
  ],
  [
    "big cat inside a batched command is allowed (H1 cap)",
    "pass",
    async (pi) => bash(pi, `date -u; cat ${bigFile}`),
  ],
  // ---- H1 cap unit checks (composed tool_result return value) ----
  [
    "H1: oversized bash output is capped with spill pointer",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      const b = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
      });
      if (b)
        return {
          blocked: true,
          reason: `precondition: cat blocked: ${b.reason.slice(0, 80)}`,
        };
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
        content: textBlocks(
          Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"),
        ),
        isError: false,
      });
      const t = r?.content?.[0]?.text ?? "";
      const ok =
        r &&
        r.content.length === 1 &&
        t.startsWith("l0\n") &&
        t.includes("kept 40/500 lines") &&
        t.includes("pgate-spill");
      return ok
        ? { blocked: false }
        : {
            blocked: true,
            reason: `cap result wrong: ${JSON.stringify(r).slice(0, 160)}`,
          };
    },
  ],
  [
    "H1: >2KB bash output is byte-capped even under the line cap",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat oneline.log" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat oneline.log" },
        content: textBlocks("x".repeat(20000)),
        isError: false,
      });
      const t = r?.content?.[0]?.text ?? "";
      return r && t.length < 20000 && t.includes("[output capped")
        ? { blocked: false }
        : { blocked: true, reason: `byte cap wrong: len=${t.length}` };
    },
  ],
  [
    "H1: small bash output passes through unmodified",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "ls" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "ls" },
        content: textBlocks("ok"),
        isError: false,
      });
      return r === undefined
        ? { blocked: false }
        : {
            blocked: true,
            reason: `small output was modified: ${JSON.stringify(r).slice(0, 100)}`,
          };
    },
  ],
  [
    "H1: structuredContent preserved when capping",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
        content: textBlocks(
          Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n"),
        ),
        structuredContent: { exitCode: 0 },
        isError: false,
      });
      return r && r.structuredContent && r.structuredContent.exitCode === 0
        ? { blocked: false }
        : { blocked: true, reason: "structuredContent dropped by cap" };
    },
  ],
  [
    "H1: failing command output is capped too (tsc/test floods)",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "tsc --noEmit" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "tsc --noEmit" },
        content: textBlocks(
          Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n"),
        ),
        isError: true,
      });
      return r && r.content?.[0]?.text?.includes("kept 40/300")
        ? { blocked: false }
        : { blocked: true, reason: "error output not capped" };
    },
  ],
  [
    "H1: synthesized block results pass through uncapped",
    "pass",
    async (pi) => {
      const bad = 'git commit -m "Fix the thing"';
      const id = `rb${nextId()}`;
      const b1 = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: bad },
      });
      if (!b1) return { blocked: false }; // precondition: commitlint blocks it
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: bad },
        content: textBlocks(b1.reason + "\n" + "x".repeat(9000)),
        isError: true,
      });
      return r === undefined
        ? { blocked: false }
        : { blocked: true, reason: "synthesized block result was modified" };
    },
  ],
  [
    "H1: oversized first line is truncated head+tail",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat oneline.log" },
      });
      const line = `ERR ${"x".repeat(9000)} at src/deep/path.ts:123:45`;
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat oneline.log" },
        content: textBlocks(line),
        isError: true,
      });
      const t = r?.content?.[0]?.text ?? "";
      const ok =
        t.startsWith("ERR ") &&
        t.includes("at src/deep/path.ts:123:45") &&
        t.includes("[line truncated:");
      return ok
        ? { blocked: false }
        : { blocked: true, reason: `first-line cap wrong: ${t.slice(0, 90)}` };
    },
  ],
  [
    "H1: multibyte flood is byte-capped (UTF-8, not UTF-16 units)",
    "pass",
    async (pi) => {
      const id = `cap${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat i18n.log" },
      });
      const r = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat i18n.log" },
        content: textBlocks("আ".repeat(3000)),
        isError: false,
      });
      // 3000 Bengali chars: ~9KB UTF-8 (over cap) but 3KB UTF-16 (sailed through the old check)
      return r && r.content?.[0]?.text?.length < 3000
        ? { blocked: false }
        : { blocked: true, reason: "byte cap missed multibyte flood" };
    },
  ],
  [
    "H1: spill filename sanitizes the toolCallId, file is 0600",
    "pass",
    async (pi) => {
      const id = `a/../z-${nextId()}`;
      await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
      });
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: id,
        input: { command: "cat big.log" },
        content: textBlocks(
          Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n"),
        ),
        isError: false,
      });
      const dir = join(tmpdir(), "pgate-spill");
      const files = readdirSync(dir);
      const want = `a_.._z-${id.split("-").pop()}.txt`;
      const okFile =
        files.includes(want) &&
        (statSync(join(dir, want)).mode & 0o777) === 0o600;
      const noEscape = files.every((f) => !f.includes("/"));
      return okFile && noEscape
        ? { blocked: false }
        : { blocked: true, reason: `spill: ${files.slice(-3).join()}` };
    },
  ],
  // ---- R5 git log caps (deleted 2026-10-08, H1 step 5 — output cap covers) ----
  [
    "uncapped git log is allowed (H1 step 5 cap)",
    "pass",
    async (pi) => bash(pi, "git log"),
  ],
  [
    "git log --oneline -n passes",
    "pass",
    async (pi) => bash(pi, "git log --oneline -n 5"),
  ],
  [
    "git log -<N> short count passes",
    "pass",
    async (pi) => bash(pi, "git log -1 --format=%ci"),
  ],
  // ---- R6 rg -o caps ----
  [
    "uncapped rg -o is allowed (H1 step 3 cap)",
    "pass",
    async (pi) => bash(pi, "rg -o 'pattern' src/"),
  ],
  [
    "capped rg -o passes",
    "pass",
    async (pi) => bash(pi, "rg -o 'pattern' src/ | head -20"),
  ],
  // ---- R7 recursive walks ----
  [
    "ls -R is allowed (H1 step 6 cap)",
    "pass",
    async (pi) => bash(pi, "ls -R src"),
  ],
  ["plain ls passes", "pass", async (pi) => bash(pi, "ls src")],
  // ---- R8 git hook caps ----
  [
    "uncapped git commit is allowed (H1 step 4 cap)",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix: cap output"'),
  ],
  [
    "capped git commit passes",
    "pass",
    async (pi) => bash(pi, 'git commit -m "fix: cap output" 2>&1 | tail -20'),
  ],
  // ---- runner caps ----
  [
    "uncapped npm test is allowed (H1 step 2 cap)",
    "pass",
    async (pi) => bash(pi, "npm test"),
  ],
  [
    "capped npm test passes",
    "pass",
    async (pi) => bash(pi, "npm test 2>&1 | tail -5"),
  ],
  [
    "stdout redirect to a file caps runner output",
    "pass",
    async (pi) =>
      bash(pi, 'npx tsc --noEmit > /tmp/tsc.out 2>&1; echo "TSC=$?"'),
  ],
];
