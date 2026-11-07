#!/usr/bin/env node
/** WC (writeConfinement) — write-path confinement for the native write
 * tools (2026-11-07 audit, MED): piwrite/piedit resolved targets lexically
 * against the session cwd with no confinement and silent overwrite; only
 * protected-prefix trees confirmed. This suite pins both layers:
 *
 *   resolution layer (extensions/piwrite + extensions/piedit): a RELATIVE
 *     path whose ../ traversal escapes the session cwd is rejected as a
 *     tool error — never a confirm; absolute targets stay the gate's lane.
 *
 *   gate layer (permission-gate): piwrite/piedit targets resolving outside
 *     the session cwd — minus the harness ledger tree ~/.pi/efforts — and
 *     piwrite overwrites of EXISTING files confirm through the H2 ladder;
 *     the built-in write/edit lanes keep their existing verdicts.
 *
 * Two processes: the parent runs the resolution-layer tests (no gate
 * import); the gate layer runs in a spawned child because the gate reads
 * its config once at import (PGATE_CONFIG points at the canonical
 * rules-calibrated fixture, same as the shipped gate cases).
 * Run: node --test tests/extensions/piwrite-confinement.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const self = fileURLToPath(import.meta.url);
const fixture = new URL("../gate/fixtures/rules-calibrated.json", import.meta.url).pathname;

// Preflight (same as tests/gate/native-write-first.test.mjs): the gate's bare
// import `@earendil-works/pi-coding-agent` is not in this repo's node_modules —
// symlink it to the global install under the gitignored root node_modules.
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true }); // stale empty dir / broken link must not pass
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

if (process.argv[2] === "--child=gate") {
  await runGateChild();
}

async function runGateChild() {
  delete process.env.PI_SUBAGENT_NAME; // scrub a host subagent marker: confirms must not go fail-closed
  process.env.HOME = mkdtempSync(join(tmpdir(), "wc-home-")); // decision log off the real home
  const gate = await import("../../extensions/permission-gate/index.ts");

  // stubbed ExtensionAPI (same shape as tests/gate/native-write-first.test.mjs)
  const lists = new Map();
  const pi = {
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
  gate.default(pi);

  let seqId = 0;
  const textBlocks = (s) => [{ type: "text", text: s }];
  const session = mkdtempSync(join(tmpdir(), "wc-sess-"));
  const other = mkdtempSync(join(tmpdir(), "wc-other-"));
  const efforts = join(process.env.HOME, ".pi", "efforts");
  mkdirSync(efforts, { recursive: true });

  let failed = 0;
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
    if (!cond) failed++;
  };

  /** Fire a write-shaped tool_call; on pass, act as the executor + result. */
  async function write(toolName, path, content, ctx, execute = false) {
    const toolCallId = `tc${++seqId}`;
    const input = { path, content };
    const block = await pi.invoke("tool_call", { type: "tool_call", toolName, toolCallId, input }, ctx);
    if (block) return `BLOCKED: ${block.reason}`;
    if (execute) writeFileSync(path, content);
    await pi.invoke(
      "tool_result",
      { type: "tool_result", toolName, toolCallId, input, content: textBlocks("ok"), isError: false },
      ctx,
    );
    return "write ok";
  }

  /** Fire a read tool_call + result (certifies coverage for a later edit). */
  async function read(toolName, path, ctx) {
    const toolCallId = `tc${++seqId}`;
    const input = { path, offset: 1, limit: 10 };
    const block = await pi.invoke("tool_call", { type: "tool_call", toolName, toolCallId, input }, ctx);
    if (block) return `BLOCKED: ${block.reason}`;
    const body = readFileSync(path, "utf8");
    await pi.invoke(
      "tool_result",
      { type: "tool_result", toolName, toolCallId, input, content: textBlocks(body), isError: false },
      ctx,
    );
    return "read ok";
  }

  /** Fire an edit-shaped tool_call. */
  async function edit(toolName, path, edits, ctx) {
    const toolCallId = `tc${++seqId}`;
    const input = { path, edits };
    const block = await pi.invoke("tool_call", { type: "tool_call", toolName, toolCallId, input }, ctx);
    if (block) return `BLOCKED: ${block.reason}`;
    await pi.invoke(
      "tool_result",
      { type: "tool_result", toolName, toolCallId, input, content: textBlocks("ok"), isError: false },
      ctx,
    );
    return "edit ok";
  }

  const inCwd = { cwd: session };

  // g1 — in-cwd NEW file: confinement is silent
  {
    const r = await write("piwrite", join(session, "new.md"), "n", inCwd);
    check("g1 piwrite new in-cwd file passes (no confirm)", r === "write ok", r);
  }

  // g2 — in-cwd EXISTING file: overwrite confirms (WC, ahead of WB)
  {
    const p = join(session, "existing.md");
    writeFileSync(p, "old");
    const r = await write("piwrite", p, "new", inCwd);
    check(
      "g2 piwrite existing in-cwd file confirms (overwrite)",
      r.startsWith("BLOCKED: Permission Gate (Destructive): piwrite") && r.includes("existing file (overwrite)"),
      r,
    );
  }

  // g3 — outside-cwd absolute target: confirms, fail-closed without a UI
  {
    const r = await write("piwrite", join(other, "escape.md"), "x", inCwd);
    check(
      "g3 piwrite outside-cwd absolute target confirms",
      r.startsWith("BLOCKED: Permission Gate (Destructive): piwrite") && r.includes("outside the session directory"),
      r,
    );
  }

  // g4 — outside-cwd target with an approving UI: exactly one confirm, then allowed
  {
    let asks = 0;
    const r = await write("piwrite", join(other, "approved.md"), "x", {
      cwd: session,
      hasUI: true,
      ui: { confirm: async () => (asks++, true) },
    });
    check(
      "g4 piwrite outside-cwd target passes after one UI approval",
      r === "write ok" && asks === 1,
      `${r} (asks=${asks})`,
    );
  }

  // g5 — the AGENTS-mandated ledger tree ~/.pi/efforts is allowlisted
  {
    const r = await write("piwrite", join(efforts, "task.md"), "ledger", inCwd);
    check("g5 piwrite ~/.pi/efforts path is allowlisted (no confirm)", r === "write ok", r);
  }

  // g6 — parity with the stubbed harnesses: no ctx.cwd → nothing to confine against
  {
    const r = await write("piwrite", join(session, "no-ctx.md"), "x", undefined);
    check("g6 piwrite without a session cwd passes (harness parity)", r === "write ok", r);
  }

  // g7 — built-in write lane unchanged: the never-read overwrite stays WB's verdict
  {
    const p = join(session, "builtin.md");
    writeFileSync(p, "old");
    const r = await write("write", p, "new", inCwd);
    check(
      "g7 built-in write never-read overwrite still blocks as WB (Unread)",
      r.startsWith("BLOCKED: Anchor Guard (Unread)"),
      r,
    );
  }

  // g8 — piedit outside-cwd target: confinement confirm
  {
    const p = join(other, "edit-target.md");
    writeFileSync(p, "alpha\nbeta\n");
    const r = await edit(
      "piedit",
      p,
      [{ oldText: "beta", newText: "gamma" }],
      inCwd,
    );
    check(
      "g8 piedit outside-cwd target confirms",
      r.startsWith("BLOCKED: Permission Gate (Destructive): piedit") && r.includes("outside the session directory"),
      r,
    );
  }

  // g9 — piedit in-cwd after a read: no WC confirm (in-cwd edits unchanged)
  {
    const p = join(session, "edit-ok.md");
    writeFileSync(p, "alpha\nbeta\n");
    const rr = await read("piread", p, inCwd);
    const r = rr === "read ok" ? await edit("piedit", p, [{ oldText: "beta", newText: "gamma" }], inCwd) : rr;
    check("g9 piedit in-cwd (read-certified) passes without a confirm", r === "edit ok", r);
  }

  const total = 9;
  console.log(failed === 0 ? `${total}/${total} gate checks PASS` : `${total - failed}/${total} gate checks PASS`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Parent: resolution-layer tests (no gate import — its config read is per
// process, and these cases must not depend on any rule severity)
// ---------------------------------------------------------------------------

const piwriteExtension = (await import("../../extensions/piwrite/index.ts")).default;
const pieditExtension = (await import("../../extensions/piedit/index.ts")).default;

/** Registered tool definitions, captured through a stub ExtensionAPI. */
function captureTool(extension) {
  let def;
  extension({ registerTool: (d) => (def = d) });
  assert.ok(def, "extension must register a tool");
  return def;
}

const piwriteDef = captureTool(piwriteExtension);
const pieditDef = captureTool(pieditExtension);

/** A throwaway "session directory" — the confinement root for one case. */
const sessionDir = () => mkdtempSync(join(tmpdir(), "wc-sess-"));

test("piwrite: relative ../ traversal out of the session cwd is rejected", async () => {
  const cwd = sessionDir();
  await assert.rejects(
    piwriteDef.execute("t1", { path: "../../outside.txt", content: "x" }, undefined, undefined, { cwd }),
    /piwrite: .* escapes the session directory/,
  );
});

test("piwrite: deep ../../ chains targeting system trees are rejected", async () => {
  const cwd = sessionDir();
  await assert.rejects(
    piwriteDef.execute(
      "t2",
      { path: "../../../../../../../../etc/wc-escape-probe", content: "x" },
      undefined,
      undefined,
      { cwd },
    ),
    /piwrite: .* escapes the session directory/,
  );
});

test("piwrite: in-cwd relative paths with .. that stay inside still write", async () => {
  const cwd = sessionDir();
  const res = await piwriteDef.execute(
    "t3",
    { path: "sub/../ok.txt", content: "inside-ok" },
    undefined,
    undefined,
    { cwd },
  );
  assert.equal(res.content[0].text, "Successfully wrote to sub/../ok.txt");
  assert.equal(readFileSync(join(cwd, "ok.txt"), "utf8"), "inside-ok");
});

test("piwrite: absolute outside-cwd targets stay the gate's lane (resolution allows)", async () => {
  const cwd = sessionDir();
  const other = mkdtempSync(join(tmpdir(), "wc-other-"));
  const target = join(other, "gate-confirms.md");
  await piwriteDef.execute("t4", { path: target, content: "abs" }, undefined, undefined, { cwd });
  assert.equal(readFileSync(target, "utf8"), "abs");
});

test("piedit: relative ../ traversal out of the session cwd is rejected", async () => {
  const cwd = sessionDir();
  await assert.rejects(
    pieditDef.execute(
      "t5",
      { path: "../../outside.txt", edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      { cwd },
    ),
    /piedit: .* escapes the session directory/,
  );
});

test("gate layer: WC confinement + unchanged built-in lanes (child phase)", () => {
  const r = spawnSync(process.execPath, [self, "--child=gate"], {
    env: { ...process.env, PGATE_CONFIG: fixture },
    encoding: "utf8",
    timeout: 120_000,
  });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  assert.equal(r.status, 0, `child exited ${r.status}; its FAIL lines are above`);
  assert.ok(!/^\s*FAIL/m.test(r.stdout ?? ""), "no FAIL line may remain");
});
