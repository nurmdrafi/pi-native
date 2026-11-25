// Permission-gate cases for rules.cross-rule (multi-rule scenes).
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, read, piread, edit, bash, runBash, runSearch, nestedBash, write, approveUi, denyUi, compact, tmp, fileA, fileInj, spanFile, hitRoot, hitApi, hugeFile, canary, stopCanary, canaryIntact, HARD_NET, gatedExec, canaryBlocked, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- S4 (2026-10-15) TOCTOU + symlink/spill lock-ins (spec §5.4–5.5) ----
  [
    "S4 TOCTOU: R1 re-read re-stats — mtime-only touch defeats the block",
    "pass",
    async (pi) => {
      const f = join(tmp, "touch-mtime.ts");
      writeFileSync(f, "m1\nm2\n");
      await read(pi, f, {}, { outputLines: 2, totalLines: 2 });
      await new Promise((r) => setTimeout(r, 10)); // distinct mtime
      writeFileSync(f, "m1\nm2\n"); // same bytes, new mtime — decision-time stat wins
      return read(pi, f, {}, { outputLines: 2, totalLines: 2 });
    },
  ],
  [
    "S4 TOCTOU: approve window is keyed verbatim (rm a ≠ rm b)",
    "blocked",
    async (pi) => {
      const deny = {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => false },
      };
      await bash(pi, "rm -f a.txt", approveUi());
      return bash(pi, "rm -f b.txt", deny); // approving `a` must not bless `b`
    },
  ],
  [
    "S4 symlink: ln -s canary link && rm link is blocked",
    "blocked",
    async (pi) =>
      runBash(pi, "ln -s canary.txt link.txt && rm link.txt", {
        ctx: { hasUI: false },
      }),
  ],
  [
    "S4 spill: hostile toolCallId stays inside pgate-spill (sanitized)",
    "pass",
    async (pi) => {
      const toolCallId = "../../evil";
      const block = await pi.invoke(
        "tool_call",
        { type: "tool_call", toolName: "pibash", toolCallId, input: { command: "seq 1 500" } },
        approveUi(),
      );
      if (block) return { blocked: true, reason: "unexpected block" };
      const huge = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "pibash",
        toolCallId,
        input: { command: "seq 1 500" },
        content: textBlocks(huge),
        isError: false,
      });
      const spillDir = join(tmpdir(), "pgate-spill");
      const inside = existsSync(join(spillDir, ".._.._evil.txt"));
      const escaped = existsSync(join(tmpdir(), "evil.txt"));
      return inside && !escaped
        ? { blocked: false }
        : { blocked: true, reason: `inside=${inside} escaped=${escaped}` };
    },
  ],

  // ---- Phase 6 (audit A9): bash-lane write-binding parity ----
  [
    "A9 TOCTOU: later bash redirect to the same target after drift blocks (Stale)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "a9-bind.txt");
      writeFileSync(f, "l1\nl2\nl3\n");
      await piread(pi, f, { offset: 1, limit: 2 });
      const r1 = await runBash(pi, `echo x > ${f}`); // covered + stat match: allowed, bind recorded
      if (r1.blocked)
        return { blocked: true, reason: `first redirect blocked: ${String(r1.reason).slice(0, 60)}` };
      writeFileSync(f, "drift-l1\ndrift-l2\n"); // external edit: size + mtime drift
      const r2 = await runBash(pi, `echo y > ${f}`);
      return r2.blocked && r2.reason.startsWith("Anchor Guard (Stale)")
        ? r2
        : { blocked: false, reason: `wrong family: ${String(r2.reason).slice(0, 70)}` };
    },
  ],

  // ---- Phase 6 (audit A12b): remembered approval keys on the stat of
  // affected paths — verbatim replay survives, stat drift re-asks ----
  [
    "A12b: remembered destructive approval re-asks when the affected file drifted",
    "blocked",
    async (pi) => {
      let asks = 0;
      const askCtx = {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => (asks++, true) },
      };
      const f = join(tmp, "a12-approval.txt");
      writeFileSync(f, "v1\n");
      const cmd = `git reset --hard HEAD > ${f}`;
      const r1 = await bash(pi, cmd, askCtx); // dialog approves, stat of f recorded
      if (r1.blocked) return { blocked: true, reason: "first send unexpectedly blocked" };
      writeFileSync(f, "v2 with more bytes\n"); // drift between approval and re-send
      const r2 = await bash(pi, cmd, denyUi()); // remembered text matches, stat does not
      return r2.blocked && r2.reason.startsWith("Permission Gate (Destructive)")
        ? r2
        : { blocked: false, reason: `re-send did not re-ask: ${String(r2.reason).slice(0, 70)}` };
    },
  ],
  [
    "A12b: remembered destructive approval replays when the file is unchanged",
    "pass",
    async (pi) => {
      let asks = 0;
      const askCtx = {
        hasUI: true,
        mode: "tui",
        ui: { confirm: async () => (asks++, true) },
      };
      const f = join(tmp, "a12-approval-stable.txt");
      writeFileSync(f, "stable\n");
      const cmd = `git reset --hard HEAD > ${f}`;
      const r1 = await bash(pi, cmd, askCtx);
      if (r1.blocked) return { blocked: true, reason: "first send unexpectedly blocked" };
      const r2 = await bash(pi, cmd, askCtx);
      return !r2.blocked && asks === 1
        ? { blocked: false }
        : { blocked: true, reason: `asks=${asks} r2=${JSON.stringify(r2).slice(0, 80)}` };
    },
  ],

  // ---- Phase 6 (audit A12c): symlink swap mid-flight — the confirmed
  // write's landing path is re-realpathed and errors on mismatch ----
  [
    "A12c: confirmed piwrite whose target realpaths differently after landing errors",
    "blocked",
    async (pi) => {
      const sandbox = mkdtempSync(join(tmpdir(), "pgate-sw-"));
      const session = join(sandbox, "sess");
      mkdirSync(session);
      const outer = join(sandbox, "outer");
      mkdirSync(outer);
      const target = join(outer, "t.md");
      writeFileSync(target, "seed\n");
      await piread(pi, target, { offset: 1, limit: 5 });
      const ctx = {
        hasUI: true,
        mode: "tui",
        cwd: session,
        ui: { confirm: async () => true },
      };
      const toolCallId = `tc${nextId()}`;
      const input = { path: target, content: "new\n" };
      const block = await pi.invoke(
        "tool_call",
        { type: "tool_call", toolName: "piwrite", toolCallId, input },
        ctx,
      ); // outside-session-dir confirm approves; landing path recorded
      if (block) return { blocked: true, reason: `pre-write block: ${block.reason.slice(0, 60)}` };
      const outer2 = join(sandbox, "outer2");
      renameSync(outer, outer2); // symlink swap mid-flight
      symlinkSync(outer2, outer);
      writeFileSync(join(outer2, "t.md"), "new\n"); // the write lands through the swap
      const res = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piwrite",
        toolCallId,
        input,
        content: textBlocks("ok"),
        isError: false,
      });
      const note = (res?.content ?? []).map((c) => c.text).join(" ");
      return res?.isError && note.includes("Symlink drift")
        ? { blocked: true, reason: note }
        : { blocked: false, reason: `res=${String(JSON.stringify(res)).slice(0, 90)}` };
    },
  ],
  [
    "A12c control: confirmed piwrite with a stable realpath lands clean",
    "pass",
    async (pi) => {
      const sandbox = mkdtempSync(join(tmpdir(), "pgate-sw2-"));
      const session = join(sandbox, "sess");
      mkdirSync(session);
      const outer = join(sandbox, "outer");
      mkdirSync(outer);
      const target = join(outer, "t.md");
      writeFileSync(target, "seed\n");
      await piread(pi, target, { offset: 1, limit: 5 });
      const ctx = {
        hasUI: true,
        mode: "tui",
        cwd: session,
        ui: { confirm: async () => true },
      };
      const toolCallId = `tc${nextId()}`;
      const input = { path: target, content: "new\n" };
      const block = await pi.invoke(
        "tool_call",
        { type: "tool_call", toolName: "piwrite", toolCallId, input },
        ctx,
      );
      if (block) return { blocked: true, reason: `pre-write block: ${block.reason.slice(0, 60)}` };
      writeFileSync(target, "new\n"); // lands exactly where approved
      const res = await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piwrite",
        toolCallId,
        input,
        content: textBlocks("ok"),
        isError: false,
      });
      return res?.isError
        ? { blocked: true, reason: `unexpected error: ${String(JSON.stringify(res)).slice(0, 80)}` }
        : { blocked: false };
    },
  ],

];
