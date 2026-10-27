// Regression: a request must never hang when its daemon slot died between the
// write and the response.
//
// Repro of the piread cross-rung hang (flaky in the wild, deterministic here):
// when the process hosting the daemon is torn down, `proc.kill()` destroys the
// stdin pipe. A request that is written after that destruction but whose
// pending entry was not part of the killDaemon sweep sees NO failure signal:
// no 'data', no 'exit' (that handler runs killDaemon on an already-cleared
// map, and is not registered until a tick later), and the write callback
// reports success. The awaited execute() then dangles for the life of the
// host process -> `node --test` exits 13 (unsettled top-level await).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const m = await import(join(ROOT, "extensions/piread/index.ts"));
const pi = { tools: new Map(), registerTool: (d) => pi.tools.set(d.name, d), on: () => () => {} };
process.env.PI_NATIVE_READ = "1";
m.default(pi);
const tool = pi.tools.get("piread");
const reset = m.__resetDaemonForTest;

const dir = mkdtempSync(join(tmpdir(), "piread-hang-"));
const file = join(dir, "f.txt");
writeFileSync(file, "hello\nworld\n");
const realBin = join(ROOT, "bin", "piread");
// A "daemon" that keeps stdin open and never answers: the request is written
// into a live pipe, then the daemon is killed out from under it. It answers
// correctly when invoked WITHOUT --serve, so the one-shot rung (the ladder's
// fallback for a died daemon) resolves immediately instead of stalling on a
// wedged child. The assertion below is about the DAEMON leg not leaking, not
// about how long a mute binary takes to give up.
const mute = join(dir, "mute-bin");
writeFileSync(
  mute,
  [
    "#!/bin/sh",
    'for a in "$@"; do [ "$a" = "--serve" ] && exec sleep 30; done',
    `cat <<'JSON'`,
    `{"ok":true,"content":"from-oneshot\\n","binary":false,"totalBytes":13}`,
    `JSON`,
    "",
  ].join("\n"),
);
chmodSync(mute, 0o755);
const ctx = { cwd: dir };

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};
const settleWithin = (p, ms) =>
  Promise.race([
    p.then((v) => ({ kind: "ok", v }), (e) => ({ kind: "err", e })),
    new Promise((res) => setTimeout(() => res({ kind: "timeout" }), ms)),
  ]);

// 1. Start a daemon on the mute binary: the request goes out, no reply comes.
process.env.PI_READ_BIN = mute;
const inFlight = tool.execute("t", { path: file }, undefined, undefined, ctx);
// 2. The slot dies out from under the in-flight request (this is what a
//    failed/restarted daemon looks like to the extension).
await new Promise((r) => setImmediate(r));
reset();

const raced = await settleWithin(inFlight, 5000);
check(
  "request in flight when its daemon dies settles (never leaks)",
  raced.kind !== "timeout",
  "execute() never settled — pending request leaked (the cross-rung hang)",
);

// 3. The tool must still serve afterwards: no wedged slot, no dead daemon.
process.env.PI_READ_BIN = realBin;
const after = await settleWithin(tool.execute("a", { path: file }, undefined, undefined, ctx), 5000);
check(
  "tool still serves after the died-mid-flight daemon",
  after.kind === "ok" && after.v?.details?.via === "daemon",
  after.kind === "timeout" ? "never settled" : JSON.stringify(after.v?.details ?? String(after.e?.message)),
);

reset();
rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
