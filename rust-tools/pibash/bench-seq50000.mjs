#!/usr/bin/env node
// Micro-bench for the seq 50000-class regression (backlog §1).
// Usage: node bench-seq50000.mjs [pibash-path] [rounds] [per-round]
// The binary path defaults to this package's release build, derived from this
// script's location — never an absolute user path.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = process.argv[2] ?? path.resolve(here, "../target/release/pibash");
const rounds = Number(process.argv[3] ?? 8);
const per = Number(process.argv[4] ?? 20);
const command = process.argv[5] ?? "seq 50000";

const probe = spawnSync(bin, ["--command", command], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.error(`bench: cannot run ${bin} --command '${command}' — workload missing?`);
  process.exit(1);
}

const times = [];
for (let r = 0; r < rounds; r++) {
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < per; j++) {
    spawnSync(bin, ["--command", command], { stdio: "ignore" });
  }
  const t1 = process.hrtime.bigint();
  times.push(Number(t1 - t0) / 1e6 / per);
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor((times.length - 1) / 2)];
const ms = (v) => v.toFixed(2);
console.log(
  `rounds=${rounds}x${per} min=${ms(times[0])}ms p50=${ms(p50)}ms max=${ms(times[times.length - 1])}ms (per invocation)`,
);
