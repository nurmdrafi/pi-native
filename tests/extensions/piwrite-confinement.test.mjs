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
 *     the session cwd — and
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
  await runGateChild(false);
} else if (process.argv[2] === "--child=gate-wboff") {
  // WB disabled end-to-end: env override beats the fixture — with nothing
  // owning overwrite binding, the WC overwrite confirm must come back
  process.env.PGATE_WRITE_BINDING_GUARD = "off";
  await runGateChild(true);
}

async function runGateChild(wbOff) {
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
  let ran = 0;
  const check = (name, cond, extra = "") => {
    ran++;
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

  /** Fire a bash-kind tool_call (confirm-lane view: no result fired). The
   * native name keeps the P2 pibash-first rule out of the probe. */
  async function bash(command, ctx) {
    const toolCallId = `tc${++seqId}`;
    const block = await pi.invoke(
      "tool_call",
      { type: "tool_call", toolName: "pibash", toolCallId, input: { command, timeout: 30 } },
      ctx,
    );
    return block ? `BLOCKED: ${block.reason}` : "bash ok";
  }

  const inCwd = { cwd: session };

  // g1 — in-cwd NEW file: confinement is silent
  {
    const r = await write("piwrite", join(session, "new.md"), "n", inCwd);
    check("g1 piwrite new in-cwd file passes (no confirm)", r === "write ok", r);
  }

  // g2 — in-cwd EXISTING file, never read: with WB active (fixture: error)
  // the binding owns the overwrite — an Unread block with a re-read fix, no
  // destructive confirm; with WB off the WC overwrite confirm returns
  {
    const p = join(session, "existing.md");
    writeFileSync(p, "old");
    const r = await write("piwrite", p, "new", inCwd);
    check(
      wbOff
        ? "g2 piwrite overwrite confirms while writeBindingGuard is off"
        : "g2 piwrite overwrite hits WB Unread (no confirm) while WB is active",
      wbOff
        ? r.startsWith("BLOCKED: Permission Gate (Destructive): piwrite") && r.includes("existing file (overwrite)")
        : r.startsWith("BLOCKED: Anchor Guard (Unread)"),
      r,
    );
  }

  // g2b — read-certified overwrite: WB active → silent pass (binding
  // satisfied, no dialog); WB off → the WC confirm returns even though the
  // file was read — nothing analytical owns the overwrite then
  {
    const p = join(session, "certified.md");
    writeFileSync(p, "old\n");
    const rr = await read("piread", p, inCwd);
    const r = rr === "read ok" ? await write("piwrite", p, "new", inCwd) : rr;
    check(
      wbOff
        ? "g2b read-certified overwrite still confirms while WB is off"
        : "g2b read-certified overwrite passes with no confirm while WB is active",
      wbOff ? r.startsWith("BLOCKED: Permission Gate (Destructive): piwrite") : r === "write ok",
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

  // g5 — ~/.pi/efforts lost its allowlist (user direction 2026-11-12): it
  // sits outside the session cwd, so it confirms like any other out-of-cwd
  // target — in every mode, yolo included (out-of-cwd is yolo floor)
  {
    const r = await write("piwrite", join(efforts, "task.md"), "ledger", inCwd);
    check(
      "g5 piwrite ~/.pi/efforts target now confirms (out-of-cwd)",
      r.startsWith("BLOCKED: Permission Gate (Destructive): piwrite") && r.includes("outside the session directory"),
      r,
    );
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
      wbOff
        ? "g7 built-in write never-read overwrite passes while WB is off (shipped policy)"
        : "g7 built-in write never-read overwrite still blocks as WB (Unread)",
      wbOff ? r === "write ok" : r.startsWith("BLOCKED: Anchor Guard (Unread)"),
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

  // g10 — yolo + WB configured active (fixture: error): the overwrite
  // confirm must NOT resurrect — it is WB's fallback, not part of the yolo
  // floor (loader.ts YOLO_FLOOR), and WB itself is silenced by the bypass,
  // so nothing may ask or block on an in-cwd overwrite. Skipped in the
  // wboff run: with WB configured off the confirm is the intended owner
  if (!wbOff) {
    const loader = await import("../../extensions/permission-gate/loader.ts");
    loader.setYolo(true);
    try {
      const p = join(session, "yolo.md");
      writeFileSync(p, "old");
      const r = await write("piwrite", p, "new", inCwd);
      check("g10 yolo overwrite passes with no confirm and no WB block", r === "write ok", r);
    } finally {
      loader.setYolo(false);
    }
  }

  // g11 — yolo auto-approves the git-family confirm entries (user
  // direction 2026-11-12) while the non-git destructive floor and the
  // normal-mode confirm stay armed
  {
    const loader = await import("../../extensions/permission-gate/loader.ts");
    const git = "git reset --hard HEAD~1";
    const rmf = "rm -rf /tmp/wc-g11-probe";
    const normal = await bash(git, inCwd);
    check("g11 normal mode: git history ask still confirms", normal.startsWith("BLOCKED: Permission Gate (Destructive)"), normal);
    loader.setYolo(true);
    try {
      const g = await bash(git, inCwd);
      check("g11 yolo: git-family ask is auto-approved", g === "bash ok", g);
      const d = await bash(rmf, inCwd);
      check("g11 yolo: non-git destructive still confirms", d.startsWith("BLOCKED: Permission Gate (Destructive)"), d);
    } finally {
      loader.setYolo(false);
    }
  }

  console.log(failed === 0 ? `${ran}/${ran} gate checks PASS` : `${ran - failed}/${ran} gate checks PASS`);
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

test("gate layer: WC overwrite confirm returns when writeBindingGuard is off (child phase)", () => {
  const r = spawnSync(process.execPath, [self, "--child=gate-wboff"], {
    env: { ...process.env, PGATE_CONFIG: fixture },
    encoding: "utf8",
    timeout: 120_000,
  });
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  assert.equal(r.status, 0, `child exited ${r.status}; its FAIL lines are above`);
  assert.ok(!/^\s*FAIL/m.test(r.stdout ?? ""), "no FAIL line may remain");
});
