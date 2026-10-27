// Probe preambles for permission-gate cases, keyed by case name.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { freshGate, read, edit, bash, runBash, write, compact, tmp, fileA, skillFile, prevBranch, spanFile, canary, startCanary, getHydT, setHydT } from "./helpers.mjs";

const preambles = {
  "identical window re-read is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA, { offset: 1, limit: 50 }, { outputLines: 50 });
    return pi;
  },
  "continuation window (1-50 then 51-100) passes": async () => {
    const pi = freshGate();
    await read(pi, fileA, { offset: 1, limit: 50 }, { outputLines: 50 });
    return pi;
  },
  "windowed re-read inside a full read is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA, {}, { outputLines: 100, totalLines: 100 });
    return pi;
  },
  "full re-read after a full read is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA, {}, { outputLines: 100, totalLines: 100 });
    return pi;
  },
  "window past a truncated full read passes": async () => {
    const pi = freshGate();
    await read(
      pi,
      fileA,
      {},
      { outputLines: 2000, totalLines: 5000, truncated: true },
    );
    return pi;
  },
  "partial-overlap window passes (brings new lines)": async () => {
    const pi = freshGate();
    await read(pi, fileA, { offset: 1, limit: 50 }, { outputLines: 50 });
    return pi;
  },
  "locate-first: wide window after an rg hit on the path passes": async () => {
    const pi = freshGate();
    await runBash(pi, `rg -n s1 ${spanFile}`);
    return pi;
  },
  "elided whole-file read does not certify the omitted middle": async () => {
    const pi = freshGate();
    await read(
      pi,
      spanFile,
      {},
      {
        outputLines: 40,
        totalLines: 120,
        compaction: {
          strategy: "head-tail",
          originalChars: 4000,
          visibleChars: 1200,
          omittedChars: 2800,
          partial: false,
        },
      },
    );
    return pi;
  },
  "full re-read after compaction passes": async () => {
    const pi = freshGate();
    await read(pi, fileA, {}, { outputLines: 100, totalLines: 100 });
    await compact(pi);
    return pi;
  },
  "window over just-edited span is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA); // S5 M2: certify before the edit
    const r = await edit(pi, fileA, [{ oldText: "b", newText: "x" }]);
    if (r.blocked)
      throw new Error(`preamble edit unexpectedly blocked: ${r.reason}`);
    return pi;
  },
  "window outside just-edited span passes (§8: unchanged lines stay certified — the redundant re-read now blocks)": async () => {
    const pi = freshGate();
    await read(pi, fileA); // S5 M2: certify before the edit
    const r = await edit(pi, fileA, [{ oldText: "b", newText: "x" }]);
    if (r.blocked)
      throw new Error(`preamble edit unexpectedly blocked: ${r.reason}`);
    return pi;
  },
  "full re-read after external on-disk change passes": async () => {
    // stat model (2026-10-06): a bash command's TEXT no longer resets coverage — an
    // actual on-disk change (mtime+size mismatch) does; appendFileSync stands in for
    // any external writer (codegen, another terminal, sed -i)
    const pi = freshGate();
    await read(pi, fileA, {}, { outputLines: 100, totalLines: 100 });
    appendFileSync(fileA, "d\n");
    return pi;
  },
  "any window after an image read is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA, {}, { image: true });
    return pi;
  },
  "relative-path re-read of an absolute-read file is blocked": async () => {
    const pi = freshGate();
    await read(pi, fileA, {}, { outputLines: 3, totalLines: 3 });
    return pi;
  },
  // live tool_result events carry no details.truncation — the fallback must
  // count 5 content lines, not 6 (content + blank + note), so line 6 stays uncovered
  "no-details fallback certifies exactly the content lines": async () => {
    const pi = freshGate();
    await read(
      pi,
      fileA,
      { offset: 1, limit: 5 },
      {
        outputLines: 5,
        noDetails: true,
        note: "1409 more lines in file. Use offset=6 to continue.",
      },
    );
    return pi;
  },
  // ---- R10 preambles ----
  "identical bash re-run (no edit since) is blocked": async () => {
    const pi = freshGate();
    await runBash(pi, "gh run list --limit 3");
    return pi;
  },
  "bash re-run after an intervening edit passes": async () => {
    const pi = freshGate();
    await runBash(pi, 'npx vitest run f.test.tsx 2>&1 | rg "Tests" | head -15');
    await read(pi, fileA); // S5 M2: certify before the edit
    const r = await edit(pi, fileA, [{ oldText: "b", newText: "x" }]);
    if (r.blocked)
      throw new Error(`preamble edit unexpectedly blocked: ${r.reason}`);
    return pi;
  },
  "re-run with a different pipe cap passes": async () => {
    const pi = freshGate();
    await runBash(pi, 'npx vitest run f.test.tsx 2>&1 | rg "Tests" | head -15');
    return pi;
  },
  "whitespace-only variation still blocked": async () => {
    const pi = freshGate();
    await runBash(pi, "gh run list --limit 3");
    return pi;
  },
  "shared nvm preamble does not collide R10 keys": async () => {
    const pi = freshGate();
    await runBash(
      pi,
      "source ~/.nvm/nvm.sh && nvm use 22.17.0 >/dev/null 2>&1 && pnpm vitest run x.test.ts 2>&1 | tail -8",
    );
    return pi;
  },
  "identical compound with watcher word is exempt": async () => {
    const pi = freshGate();
    await runBash(pi, "sleep 1; rm -f /tmp/x");
    return pi;
  },
  "re-run of a failed command passes": async () => {
    const pi = freshGate();
    await runBash(pi, "gh run list --limit 3", { error: true });
    return pi;
  },
  "gh run watch re-run passes": async () => {
    const pi = freshGate();
    await runBash(pi, "gh run watch 123 --exit-status");
    return pi;
  },
  "bash re-run after compaction passes": async () => {
    const pi = freshGate();
    await runBash(pi, "gh run list --limit 3");
    await compact(pi);
    return pi;
  },
  "quoted pattern pipes do not collide R10 bases": async () => {
    const pi = freshGate();
    await runBash(pi, "rg -o '(Alpha|Beta)' data.log | head -5");
    return pi;
  },
  "identical quoted-pattern command still blocked": async () => {
    const pi = freshGate();
    await runBash(pi, "rg -o '(Alpha|Beta)' data.log | head -5");
    return pi;
  },
  "escaped-pipe bases do not collide R10": async () => {
    const pi = freshGate();
    await runBash(pi, "rg -o foo\\|qux data.log | head -5");
    return pi;
  },
  "identical escaped-pipe command still blocked": async () => {
    const pi = freshGate();
    await runBash(pi, "rg -o foo\\|bar data.log | head -5");
    return pi;
  },
  "full SKILL.md re-read same session is blocked": async () => {
    const pi = freshGate();
    await read(pi, skillFile, {}, { outputLines: 30, totalLines: 30 });
    return pi;
  },
  "SKILL.md re-read after compaction passes": async () => {
    const pi = freshGate();
    await read(pi, skillFile, {}, { outputLines: 30, totalLines: 30 });
    await compact(pi);
    return pi;
  },
  "R1 reason reports the covering span, not the outer bounds": async () => {
    const pi = freshGate();
    await read(pi, spanFile, { offset: 1, limit: 50 }, { outputLines: 50 });
    await read(pi, spanFile, { offset: 60, limit: 11 }, { outputLines: 11 });
    return pi;
  },
  "R1 gap between spans still lets the gap window through": async () => {
    const pi = freshGate();
    await read(pi, spanFile, { offset: 1, limit: 50 }, { outputLines: 50 });
    await read(pi, spanFile, { offset: 60, limit: 11 }, { outputLines: 11 });
    return pi;
  },
  "normPath: @-prefixed path keys like the absolute path": async () => {
    const pi = freshGate();
    await read(pi, fileA, { offset: 1, limit: 3 }, { outputLines: 3 });
    return pi;
  },
  "normPath: ~ path expands to the same coverage key": async () => {
    const pi = freshGate();
    writeFileSync(join(tmp, "tilde.ts"), "t1\nt2\n");
    await read(
      pi,
      join(tmp, "tilde.ts"),
      { offset: 1, limit: 2 },
      { outputLines: 2 },
    );
    return pi;
  },
  "normPath: relative path resolves against ctx.cwd": async () => {
    const pi = freshGate();
    await read(pi, fileA, { offset: 1, limit: 3 }, { outputLines: 3 });
    return pi;
  },
  "S5 M3: resumed-session entry without hash passes M3 (R4)": async () => {
    // file written before the replayed read (round, restorable stat) — the
    // hydrated entry carries spans + stat but NO hash (R4: resumed sessions
    // replay entries, not content)
    writeFileSync(join(tmp, "s5-m3-resume.ts"), "a\nb\nc\n");
    setHydT(new Date(Math.floor(Date.now() / 1000) * 1000));
    utimesSync(join(tmp, "s5-m3-resume.ts"), getHydT(), getHydT());
    const pi = freshGate();
    await pi.invoke(
      "session_start",
      { type: "session_start", reason: "resume" },
      {
        sessionManager: {
          getBranch: () =>
            prevBranch([
              { id: "e1", call: "read", callId: "c1", path: join(tmp, "s5-m3-resume.ts"), ts: Date.now() },
              { id: "e2", resultFor: "c1", text: "a\nb\nc\n" },
            ]),
        },
      },
    );
    return pi;
  },
  "item6: external drift between read and edit blocks the edit (M1)": async () => {
    const pi = freshGate();
    writeFileSync(join(tmp, "drift.ts"), "a\nb\nc\nd\n");
    await read(
      pi,
      join(tmp, "drift.ts"),
      { offset: 1, limit: 4 },
      { outputLines: 4 },
    );
    appendFileSync(join(tmp, "drift.ts"), "X\n");
    return pi;
  },
  "item6: fuzzy-matched edit drops the path coverage": async () => {
    const pi = freshGate();
    writeFileSync(join(tmp, "fuzzy.ts"), "a\nb\nc\n");
    await read(
      pi,
      join(tmp, "fuzzy.ts"),
      { offset: 1, limit: 3 },
      { outputLines: 3 },
    );
    return pi;
  },
  "B20: re-run after git -C . pull is legitimate (normalized)": async () => {
    const pi = freshGate();
    await runBash(pi, "npm test 2>&1 | tail -5");
    return pi;
  },
  "B20: re-run after npm ci is legitimate": async () => {
    const pi = freshGate();
    await runBash(pi, "npm test");
    return pi;
  },
  "B20: re-run after touch/mkdir is legitimate": async () => {
    const pi = freshGate();
    await runBash(pi, "npm test");
    return pi;
  },
  "B20: successful destructive push legitimize re-runs": async () => {
    const pi = freshGate();
    await runBash(pi, "npm test");
    return pi;
  },

  // ---- S4 (2026-10-15) live-shell canary preambles: sandbox + fake HOME ----
  "S4 canary self-test: benign approved command executes and produces output": startCanary,
  "S4 canary self-test: guaranteed-block command never executes": startCanary,
  "S4 canary: transparent-prefix rm never executes": startCanary,
  "S4 canary: pipe-to-shell never executes": startCanary,
  "S4 canary: persistence redirect never executes": startCanary,
  "S4 canary: tee into authorized_keys never executes": startCanary,
  "S4 canary: variable command word never executes": startCanary,
  "S4 canary: env-prefixed git reset never executes": startCanary,
  "S4 canary: write tool through symlink into HOME/.ssh never lands": startCanary,
};
export { preambles };
