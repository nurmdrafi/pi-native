#!/usr/bin/env node
/** P3 (nativeWriteFirst) — piwrite-first, the write sibling of P1
 * (read→piread) and P2 (bash→pibash): built-in `write` is blocked with a
 * pointer to the native tool while the rule is on. The rule's severity is
 * the switch (the retired PI_NATIVE_* env switches are gone — see
 * tests/gate/cases/rules/nativeReadFirst.mjs / nativeBashFirst.mjs); loading
 * the extension pairs with `error`, and `off` restores the built-in.
 *
 * Two phases, one process each — the gate loads its config once per import:
 *   --child=on   PGATE_NATIVE_WRITE_FIRST=error — the canonical severity
 *                (the calibration fixture keeps the rule "off" so the WB
 *                case corpus keeps firing the built-in name it was authored
 *                against; the env override is the top-precedence switch)
 *   --child=off  PGATE_NATIVE_WRITE_FIRST=0 — the off rung
 * Run: node --test tests/gate/native-write-first.test.mjs  (exit 0 = pass) */
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const self = fileURLToPath(import.meta.url);
const fixture = new URL("./fixtures/rules-calibrated.json", import.meta.url).pathname;

// Preflight (same as harness/helpers.mjs): the gate's bare import
// `@earendil-works/pi-coding-agent` is not in this repo's node_modules —
// symlink it to the global install under the gitignored root node_modules.
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true }); // stale empty dir / broken link must not pass
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}

const arg = process.argv[2];
const phase = arg?.startsWith("--child=") ? arg.slice("--child=".length) : undefined;
if (phase === "on" || phase === "off") {
  await runChild(phase);
} else {
  parent();
}

function parent() {
  let failed = 0;
  for (const phase of ["on", "off"]) {
    const env = { ...process.env, PGATE_CONFIG: fixture };
    // the phase decides, not the host; "on" pins the canonical severity
    // because the fixture keeps nativeWriteFirst "off" for the WB corpus
    env.PGATE_NATIVE_WRITE_FIRST = phase === "on" ? "error" : "0";
    const r = spawnSync(process.execPath, [self, `--child=${phase}`], {
      env,
      encoding: "utf8",
    });
    process.stdout.write(r.stdout ?? "");
    process.stderr.write(r.stderr ?? "");
    if (r.status !== 0) failed++;
  }
  console.log(failed === 0 ? "\n2/2 phases PASS" : `\n${failed}/2 phases FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runChild(phase) {
  delete process.env.PI_SUBAGENT_NAME; // scrub a host subagent marker: confirms must not go fail-closed
  process.env.HOME = mkdtempSync(join(tmpdir(), "pgate-home-")); // keep the decision log off the real home
  const gate = await import("../../extensions/permission-gate/index.ts");

  // stubbed ExtensionAPI (same shape as harness/helpers.mjs makePi)
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
  const dir = mkdtempSync(join(tmpdir(), "pgate-p3-"));
  let failed = 0;
  const check = (name, cond, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
    if (!cond) failed++;
  };

  /** Fire a write-shaped tool_call; on pass, act as the executor + result. */
  async function write(toolName, path, content, execute = true) {
    const toolCallId = `tc${++seqId}`;
    const input = { path, content };
    const block = await pi.invoke("tool_call", { type: "tool_call", toolName, toolCallId, input });
    if (block) return `BLOCKED: ${block.reason}`;
    if (execute) writeFileSync(path, content);
    await pi.invoke("tool_result", {
      type: "tool_result", toolName, toolCallId, input,
      content: textBlocks("ok"), isError: false,
    });
    return "write ok";
  }

  if (phase === "on") {
    // 1. built-in write blocked, reason family Piwrite-first
    const f = join(dir, "blocked-on.ts");
    const r1 = await write("write", f, "const a = 1;\n");
    check(
      "P3 on: built-in write is blocked (piwrite-first)",
      r1.startsWith("BLOCKED: Token Economy (Piwrite-first)"),
      r1,
    );
    // 2. only the built-in name is redirected — the native tool passes
    const g = join(dir, "native-passes.ts");
    const r2 = await write("piwrite", g, "const b = 2;\n", false);
    check("P3 on: the native piwrite tool name is not blocked", r2 === "write ok", r2);
    // 3. the retired registration switch is not consulted — severity is the switch
    const prev = process.env.PI_NATIVE_WRITE;
    process.env.PI_NATIVE_WRITE = "0";
    try {
      const h = join(dir, "retired-switch.ts");
      const r3 = await write("write", h, "const c = 3;\n");
      check(
        "P3 on: blocked regardless of the retired PI_NATIVE_WRITE switch",
        r3.startsWith("BLOCKED: Token Economy (Piwrite-first)"),
        r3,
      );
    } finally {
      if (prev === undefined) delete process.env.PI_NATIVE_WRITE;
      else process.env.PI_NATIVE_WRITE = prev;
    }
  } else {
    // 4. rule off restores the built-in (new file, so WB has nothing to bind)
    const f = join(dir, "off-passes.ts");
    const r4 = await write("write", f, "const d = 4;\n");
    check("P3 off: built-in write passes (off restores the built-in)", r4 === "write ok", r4);
    // 5. the off rung turns off only P3 — WB still guards existing files
    const g = join(dir, "never-read.ts");
    writeFileSync(g, "existing\n");
    const r5 = await write("write", g, "overwritten\n");
    check(
      "P3 off: write binding (WB) still blocks a never-read overwrite",
      r5.startsWith("BLOCKED: Anchor Guard (Unread)"),
      r5,
    );
  }

  process.exit(failed === 0 ? 0 : 1);
}
