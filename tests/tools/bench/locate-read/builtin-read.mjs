#!/usr/bin/env node
// Bench arm: the REAL built-in read tool (TypeScript, in-process) — the
// implementation the Rust-native piread replaces. Reads a task list on
// stdin ([{path, target, context}, ...]), applies the same context-memory
// protocol as proto.py (20-line blocks), and prints one JSON result per
// task: {bytes, calls, ms, ok}. Bytes are the model-visible payload
// (content + details), the equivalent of the piread arms' envelope stdout.
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pkgLink = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
if (!existsSync(join(pkgLink, "package.json"))) {
  rmSync(pkgLink, { recursive: true, force: true });
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  mkdirSync(dirname(pkgLink), { recursive: true });
  symlinkSync(join(globalRoot, "@earendil-works", "pi-coding-agent"), pkgLink, "dir");
}
const { createReadTool } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);

const oracle = createReadTool(ROOT);
const CHUNK = 20;

let seq = 0;
async function oneRead(params) {
  const t0 = performance.now();
  try {
    const res = await oracle.execute(`bench${++seq}`, params, undefined, undefined, undefined);
    return {
      ok: true,
      bytes:
        JSON.stringify(res.content ?? []).length +
        JSON.stringify(res.details ?? {}).length,
      ms: performance.now() - t0,
      res,
    };
  } catch (e) {
    return {
      ok: false,
      bytes: JSON.stringify(String(e?.message ?? e)).length,
      ms: performance.now() - t0,
      res: null,
    };
  }
}

function cacheRange(cache, path, from, to) {
  for (let t = Math.max(1, from); t <= to; t += CHUNK)
    cache.set(`${path}:${Math.floor(t / CHUNK)}`, true);
}

const tasks = JSON.parse(
  (await new Promise((r) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => r(s));
  })) || "[]",
);

const cache = new Map();
const out = [];
for (const t of tasks) {
  const key = `${t.path}:${Math.floor(t.target / CHUNK)}`;
  if (cache.has(key)) {
    out.push({ bytes: 0, calls: 0, ms: 0.0, ok: true });
    continue;
  }
  const first = await oneRead({ path: t.path });
  let { bytes, ms, ok } = first;
  let calls = 1;
  const trunc = first.res?.details?.truncation ?? {};
  let visible = typeof trunc.outputLines === "number" ? trunc.outputLines : 0;
  if (!visible && Array.isArray(first.res?.content)) {
    const text = first.res.content.map((b) => b?.text ?? "").join("\n");
    visible = text ? text.split("\n").length : 0;
  }
  if (visible > 0) cacheRange(cache, t.path, 1, visible);
  // a target past the built-in caps' truncation needs one follow-up window
  if (ok && trunc.truncated === true && t.target > visible) {
    const from = Math.max(1, t.target - t.context);
    const r2 = await oneRead({ path: t.path, offset: from, limit: 2 * t.context });
    bytes += r2.bytes;
    ms += r2.ms;
    calls += 1;
    if (r2.ok) cacheRange(cache, t.path, from, from + 2 * t.context - 1);
    ok = ok && r2.ok;
  }
  out.push({ bytes, calls, ms, ok });
}
process.stdout.write(JSON.stringify(out));
