#!/usr/bin/env node
// One-off evidence probe (2026-11-07): what does the built-in read oracle
// return for the throughput payload's no-window 32 MiB read? Not a bench —
// prints the response shape so arm-work equality can be judged from data.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { createReadTool } = await import(
  join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")
);
const oracle = createReadTool(process.cwd());
const line = Buffer.from(`${"l".repeat(63)}\n`, "utf8"); // same payload as --throughput
const payload = Buffer.concat(Array.from({ length: (32 * 1024 * 1024) / line.length }, () => line));
const dir = mkdtempSync(join(tmpdir(), "piread-tpprobe-"));
const path = join(dir, "full-read-32mib.txt");
writeFileSync(path, payload);
const t0 = performance.now();
const res = await oracle.execute("tp-probe", { path });
const ms = Number((performance.now() - t0).toFixed(1));
const text = Array.isArray(res.content) ? (res.content.find((b) => b.type === "text")?.text ?? "") : "";
const t = res.details?.truncation ?? null;
console.log(
  JSON.stringify({
    ms,
    payloadBytes: payload.length,
    keys: Object.keys(res),
    textChars: text.length,
    textBytes: Buffer.byteLength(text, "utf8"),
    truncation: t && {
      truncated: t.truncated,
      truncatedBy: t.truncatedBy,
      outputLines: t.outputLines,
      outputBytes: t.outputBytes,
      totalLines: t.totalLines,
      totalBytes: t.totalBytes,
      maxLines: t.maxLines,
      maxBytes: t.maxBytes,
    },
    tail: text.slice(-120),
  }),
);
rmSync(dir, { recursive: true, force: true });
