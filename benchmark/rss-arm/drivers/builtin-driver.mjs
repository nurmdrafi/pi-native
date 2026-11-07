#!/usr/bin/env node
// benchmark/rss-arm/drivers/builtin-driver.mjs — built-in side of the RSS
// arm. Spawned (under /usr/bin/time -v) once per measured run by bench.mjs
// with a single JSON argv: {op, distTools, cwd, ...params}. It performs the
// workload in-process using the real pi built-in tool module when drivable
// (probe first, untimed), else an exact node-core replica of the built-in's
// fs/spawn calls. Prints exactly one NDJSON line to stdout:
//   {"ok":true,"label":"node-builtin"|"node-core-equivalent","op":...}
//   {"ok":false,"error":...}  (exit 1)
// Plain node ESM, no dependencies.

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

async function loadTool(distTools, file, factoryName) {
  const src = path.join(distTools, file);
  const mod = await import(pathToFileURL(src).href);
  const factory = mod[factoryName];
  if (typeof factory !== "function") throw new Error(`${factoryName} not exported by ${file}`);
  const def = factory(process.cwd(), undefined);
  const execute = def && def.execute;
  if (typeof execute !== "function") throw new Error(`${file} definition has no execute()`);
  return execute;
}

async function execBuiltin(execute, args, cwd) {
  // bash's execute reads ctx.sessionManager.getSessionId()/getSessionFile()
  // when session env exposure is on — minimal stub keeps the real module drivable.
  const ctx = {
    cwd,
    sessionManager: { getSessionId: () => "rss-bench", getSessionFile: () => null },
  };
  return execute("rss-bench", args, undefined, undefined, ctx);
}

async function opReadWindow(p) {
  const { path: file, offset, limit, expect } = p;
  const replica = async () => {
    const text = await readFile(file, "utf8"); // built-in reads the whole file…
    const allLines = text.split("\n"); // …and splits every line
    const window = allLines.slice(offset - 1, offset - 1 + limit).join("\n");
    if (!window.includes(expect)) throw new Error("replica window mismatch");
  };
  try {
    const execute = await loadTool(p.distTools, "read.js", "createReadToolDefinition");
    const res = await execBuiltin(execute, { path: file, offset, limit }, p.cwd);
    if (!JSON.stringify(res).includes(expect)) throw new Error("builtin window mismatch");
    return "node-builtin";
  } catch {
    await replica();
    return "node-core-equivalent";
  }
}

async function opBashSeq(p) {
  const { last } = p;
  const command = `seq 1 ${last}`;
  const replica = async () => {
    const out = await new Promise((resolve, reject) => {
      const ch = spawn("seq", ["1", String(last)]);
      let s = "";
      ch.stdout.on("data", (d) => (s += d));
      ch.on("error", reject);
      ch.on("close", (code) => (code === 0 ? resolve(s) : reject(new Error(`seq exit ${code}`))));
    });
    if (!out.endsWith(`${last}\n`)) throw new Error("replica seq output mismatch");
  };
  try {
    const execute = await loadTool(p.distTools, "bash.js", "createBashToolDefinition");
    const res = await execBuiltin(execute, { command }, p.cwd);
    const s = JSON.stringify(res);
    if (!s.includes(`"exit_code":0`) || !s.includes(`${last}`)) throw new Error("builtin seq mismatch");
    return "node-builtin";
  } catch {
    await replica();
    return "node-core-equivalent";
  }
}

async function opWriteBig(p) {
  const { path: file, contentPath, bytes } = p;
  const content = await readFile(contentPath, "utf8"); // mirrors the built-in receiving content in-process
  if (content.length !== bytes) throw new Error(`content length ${content.length} != ${bytes}`);
  const verify = async () => {
    const st = await stat(file);
    if (st.size !== bytes) throw new Error(`written size ${st.size} != ${bytes}`);
  };
  const replica = async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    await verify();
  };
  try {
    const execute = await loadTool(p.distTools, "write.js", "createWriteToolDefinition");
    const res = await execBuiltin(execute, { path: file, content }, p.cwd);
    if (!JSON.stringify(res).includes("wrote")) throw new Error("builtin write did not report success");
    await verify();
    return "node-builtin";
  } catch {
    await replica();
    return "node-core-equivalent";
  }
}

async function main() {
  const p = JSON.parse(process.argv[2]);
  const ops = { "read-window": opReadWindow, "bash-seq": opBashSeq, "write-big": opWriteBig };
  const fn = ops[p.op];
  if (!fn) throw new Error(`unknown op ${p.op}`);
  const label = await fn(p);
  process.stdout.write(JSON.stringify({ ok: true, label, op: p.op }) + "\n");
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e).slice(0, 200) }) + "\n");
  process.exit(1);
});
