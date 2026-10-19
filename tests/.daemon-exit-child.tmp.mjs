
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
writeFileSync(file, "alpha\nbeta\n");
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
process.stdout.write(JSON.stringify({ pireadVia: rVia, pibashText: String(b.content?.[0]?.text ?? "") }) + "\n");
