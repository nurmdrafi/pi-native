// Portability/robustness: each native daemon must run in its OWN process
// group. Today `--serve` inherits the client's group, so any group-wide
// signal — pibash's kill_tree on timeout, a job-control kill, a CI timeout —
// takes the daemon down with the client and the next request has to rebuild
// the connection. This is the "daemon connection issue": the daemon is not
// insulated from the client's process group.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "daemon-pgid-"));
const file = join(dir, "f.txt");
writeFileSync(file, "one\ntwo\n");
chmodSync(file, 0o644);

const pgidOf = (pid) =>
  new Promise((res) => {
    const p = spawn("ps", ["-o", "pgid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("exit", () => res(out.trim()));
  });

const myPgid = await pgidOf(process.pid);

/** Poll until the daemon's pgid leaves the client's group (exec + setpgid
 *  done) or the budget runs out; returns the last observed pgid. The old
 *  fixed 250 ms sleep raced daemon startup under `npm run check` load: a
 *  pre-setpgid child still carries the client's pgid — a false FAIL that
 *  vanished when the file ran standalone. Observed under `npm test`
 *  parallelism: 2+ s pre-isolate is normal, and the tail can pass 5 s, so
 *  the budget is generous; an idle run still settles in the first poll. */
const pgidAfterSettle = async (pid, myPgid, budgetMs = 15_000) => {
  const t0 = Date.now();
  let pgid = "";
  do {
    pgid = await pgidOf(pid);
    if (pgid !== "" && pgid !== myPgid) return pgid;
    await new Promise((r) => setTimeout(r, 100));
  } while (Date.now() - t0 < budgetMs);
  return pgid;
};

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`PASS  ${name}`);
  else { failures++; console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`); }
};

for (const tool of ["piread", "piedit", "pibash"]) {
  const bin = join(ROOT, "bin", tool);
  const proc = spawn(bin, ["--serve"], { stdio: ["pipe", "pipe", "ignore"] });
  proc.stdin.on("error", () => {});
  const pgid = await pgidAfterSettle(proc.pid, myPgid);
  check(
    `${tool} --serve runs in its own process group (pgid ${pgid} != client ${myPgid})`,
    pgid !== "" && pgid !== myPgid,
    "daemon shares the client's process group: a group-wide kill takes the daemon down with it",
  );
  proc.stdin.end();
  proc.kill();
}

rmSync(dir, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
