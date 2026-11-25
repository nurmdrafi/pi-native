// Permission-gate cases for rules.writeBindingGuard (WB): a write to an
// EXISTING file binds like an edit — never-read, stat drift, or hash drift
// since the certified read blocks with a re-read fix. The off/warn rungs
// live in tests/gate/write-binding-off.test.mjs (severity-specific process).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piread, write, bash, runBash, nextId, ROOT } from "../../harness/helpers.mjs";

const lineText = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
const tmpFile = (name) => {
  const f = join(mkdtempSync(join(tmpdir(), "pgate-wb-")), name);
  writeFileSync(f, lineText(60));
  return f;
};

export const cases = [
  [
    'WB: overwrite of a never-read existing file is blocked',
    'blocked',
    async (pi) => write(pi, tmpFile("never-read.ts"), lineText(30)),
  ],
  [
    'WB: overwrite after a read of the file passes',
    'pass',
    async (pi) => {
      const f = tmpFile("read-then-write.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      return write(pi, f, lineText(30));
    },
  ],
  [
    'WB: external drift between read and write blocks the overwrite (Stale)',
    'blocked',
    async (pi) => {
      const f = tmpFile("drift.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      writeFileSync(f, lineText(70)); // external edit: size + mtime drift
      const r = await write(pi, f, lineText(30));
      return r.blocked && r.reason.startsWith('Anchor Guard (Stale)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  // ---- Phase 6 (audit A9): write-binding parity for the bash lane —
  // REDIRECT/TEE targets that are VCS-tracked or session-covered bind like
  // write-tool targets: never-read tracked files block Unread, covered files
  // with drifted stats block Stale. Untracked scratch stays free.
  [
    'WB: bash redirect overwrite of a never-read tracked file is blocked (Unread)',
    'blocked',
    async (pi) => {
      const r = await bash(pi, `echo hi > ${join(ROOT, "package.json")}`);
      return r.blocked && r.reason.startsWith('Anchor Guard (Unread)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    'WB: bash redirect into a tracked file passes after a read',
    'pass',
    async (pi) => {
      await piread(pi, join(ROOT, "package.json"), { offset: 1, limit: 5 });
      return bash(pi, `echo hi > ${join(ROOT, "package.json")}`);
    },
  ],
  [
    'WB: bash tee overwrite of a covered file after external drift blocks (Stale)',
    'blocked',
    async (pi) => {
      const f = tmpFile("tee-drift.ts");
      await piread(pi, f, { offset: 1, limit: 5 });
      writeFileSync(f, lineText(90)); // external edit: size + mtime drift
      const r = await bash(pi, `echo x | tee ${f}`);
      return r.blocked && r.reason.startsWith('Anchor Guard (Stale)')
        ? r
        : { blocked: false, reason: `wrong family: ${String(r.reason).slice(0, 70)}` };
    },
  ],
  [
    'WB: bash redirect into an untracked scratch file passes (no binding)',
    'pass',
    async (pi) => bash(pi, `echo x > ${tmpFile("scratch-free.ts")}`),
  ],
  // ---- Phase 3 (agent-behaviour audit AB-3, 2026-11-18): the 3d79dd5d
  // evasion shape — a subagent's piwrite to a path outside its session dir
  // is denied (WC confinement confirms, subagents fail closed), and the
  // write is rerouted through a pibash heredoc to the SAME path. The bash
  // write lane must honor the same confinement: the reroute blocks, the
  // ungated lane does not exist. The scene-setting piwrite denial is part
  // of the assertion — if confinement stops denying, the case fails loudly.
  // Plain (no-heredoc) variant included: a redirect target is a write
  // whatever feeds it.
  [
    'WB: subagent heredoc write to the path piwrite was denied is blocked (3d79dd5d)',
    'blocked',
    async (pi) => {
      const session = mkdtempSync(join(tmpdir(), "pgate-ab3-session-"));
      const target = join(
        mkdtempSync(join(tmpdir(), "pgate-ab3-target-")),
        "icon-research.ndjson",
      );
      const hadMarker = "PI_SUBAGENT_NAME" in process.env;
      const prevMarker = process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_NAME = "icon-research";
      try {
        const denied = await pi.invoke(
          "tool_call",
          {
            type: "tool_call",
            toolName: "piwrite",
            toolCallId: `tc${nextId()}`,
            input: {
              path: target,
              content: '{"ts":"2026-11-08","src":"3d79dd5d"}',
            },
          },
          { cwd: session },
        );
        if (!denied)
          return {
            blocked: false,
            reason:
              "scene broken: piwrite to the confined path was not denied",
          };
        // approving UI on purpose: the reroute must block even with a
        // dialog that would say yes — subagent lanes fail closed. The await
        // is load-bearing: an un-awaited `return bash(...)` lets the finally
        // env-restore delete PI_SUBAGENT_NAME while the gate handler is still
        // mid-flight (it reads the marker at call time), silently disarming
        // the very guard under test.
        return await bash(
          pi,
          `cat > ${target} <<'EOF'\n{"ts":"2026-11-08","src":"3d79dd5d"}\nEOF`,
          { hasUI: true, mode: "tui", cwd: session, ui: { confirm: async () => true } },
        );
      } finally {
        if (hadMarker) process.env.PI_SUBAGENT_NAME = prevMarker;
        else delete process.env.PI_SUBAGENT_NAME;
      }
    },
  ],
  [
    'WB: subagent plain redirect (no heredoc) to a confined path is blocked',
    'blocked',
    async (pi) => {
      const session = mkdtempSync(join(tmpdir(), "pgate-ab3b-session-"));
      const target = join(
        mkdtempSync(join(tmpdir(), "pgate-ab3b-target-")),
        "icon-research.ndjson",
      );
      const hadMarker = "PI_SUBAGENT_NAME" in process.env;
      const prevMarker = process.env.PI_SUBAGENT_NAME;
      process.env.PI_SUBAGENT_NAME = "icon-research";
      try {
        const denied = await pi.invoke(
          "tool_call",
          {
            type: "tool_call",
            toolName: "piwrite",
            toolCallId: `tc${nextId()}`,
            input: {
              path: target,
              content: '{"ts":"2026-11-08","src":"3d79dd5d"}',
            },
          },
          { cwd: session },
        );
        if (!denied)
          return {
            blocked: false,
            reason:
              "scene broken: piwrite to the confined path was not denied",
          };
        // same load-bearing await as the heredoc case above — the finally
        // must not restore the env before the gate handler reads it.
        return await bash(pi, `cat > ${target}`, {
          hasUI: true,
          mode: "tui",
          cwd: session,
          ui: { confirm: async () => true },
        });
      } finally {
        if (hadMarker) process.env.PI_SUBAGENT_NAME = prevMarker;
        else delete process.env.PI_SUBAGENT_NAME;
      }
    },
  ],
];
