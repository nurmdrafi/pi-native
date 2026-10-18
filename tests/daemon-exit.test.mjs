// Regression: a host process that used a native daemon must be able to EXIT.
//
// The daemons are deliberately unref'd so an idle one never pins the host's
// event loop. `refWhilePending` refs `proc` + stdin + stdout while a request is
// in flight, so the settle path must undo all three — unref'ing only the pipes
// leaves the ChildProcess handle referenced and the host hangs forever after
// its last statement (no output, no exit; `model-visible-baseline.mjs` hung
// exactly this way).
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = join(ROOT, "tests", ".daemon-exit-child.tmp.mjs");

writeFileSync(
  CHILD,
  `
process.env.PI_NATIVE_READ = "1";
const { mkdtempSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const ROOT = process.argv[2];
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

function loadExt(name) {
  const pi = { tools: new Map(), registerTool: (d) => pi.tools.set(d.name, d), on: () => () => {} };
  return { pi };
}

const dir = mkdtempSync(join(tmpdir(), "daemon-exit-"));
const file = join(dir, "f.txt");
writeFileSync(file, "alpha\\nbeta\\n");
const ctx = { cwd: dir };

// 1. piread: drive the daemon rung (real binary) so proc is ref'd then settled.
const piread = (await import(join(ROOT, "extensions/piread/index.ts"))).default;
const piR = loadExt("piread");
piread(piR.pi);
const r = await piR.pi.tools.get("piread").execute("t1", { path: file }, undefined, undefined, ctx);
const rVia = r.details?.via;

// 2. piedit: same rung shape.
const piedit = (await import(join(ROOT, "extensions/piedit/index.ts"))).default;
const piE = loadExt("piedit");
piedit(piE.pi);

// 3. pibash: daemon rung.
const pibash = (await import(join(ROOT, "extensions/pibash/index.ts"))).default;
const piB = loadExt("pibash");
pibash(piB.pi);
const b = await piB.pi.tools.get("pibash").execute("t2", { command: "echo hi" }, undefined, undefined, ctx);

// Print, then simply stop: the process must exit by itself.
process.stdout.write(JSON.stringify({ pireadVia: rVia, pibashText: String(b.content?.[0]?.text ?? "") }) + "\\n");
`,
);

const res = spawnSync(process.execPath, [CHILD, ROOT], {
  encoding: "utf8",
  timeout: 20000,
  cwd: ROOT,
});

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};

check(
  "host exits after using the native daemons (not pinned by a ref'd child)",
  res.error?.code !== "ETIMEDOUT" && res.status === 0,
  res.error?.code === "ETIMEDOUT"
    ? "host never exited: a daemon ChildProcess handle is still ref'd (exit-path refcount leak)"
    : `exit status ${String(res.status)}\n${(res.stderr ?? "").slice(-400)}`,
);

let via = {};
try { via = JSON.parse((res.stdout ?? "").trim().split("\n").pop() ?? "{}"); } catch {}
check(
  "piread served through the native daemon rung",
  via.pireadVia === "daemon",
  `via=${String(via.pireadVia)}`,
);
check(
  "pibash ran the command through the daemon",
  typeof via.pibashText === "string" && via.pibashText.includes("hi"),
  `text=${String(via.pibashText).slice(0, 80)}`,
);

process.exit(failures === 0 ? 0 : 1);
