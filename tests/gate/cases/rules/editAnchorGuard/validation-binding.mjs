// Permission-gate cases for rules.editAnchorGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, rc, lineText, read, edit, editApplied, editsApplied, bash, runBash, write, approveUi, compact, tmp, fileA, fileB, elidedReadC3, nextId, getHydT, setHydT } from "../../../harness/helpers.mjs";

export const cases = [
  // ---- S5 (2026-10-16) edit-validation hardening (spec §9) ----
  // Step 1: hash plumbing in read-coverage — pure units, no behavior change
  [
    "S5 hash: hashText is deterministic sha256-16 of content",
    "pass",
    async () => {
      const a = rc.hashText("hello\nworld\n");
      const b = rc.hashText("hello\nworld\n");
      const c = rc.hashText("hello\nworld!");
      return a === b && a !== c && a === "4a1e67f2fe1d1cc7"
        ? { blocked: false }
        : { blocked: true, reason: `hashText: ${a} / ${b} / ${c}` };
    },
  ],
  [
    "S5 hash: hashFile returns undefined on ENOENT",
    "pass",
    async () => {
      const h = await rc.hashFile(join(tmp, "no-such-file-s5"));
      return h === undefined
        ? { blocked: false }
        : { blocked: true, reason: `ENOENT hashed to ${h}` };
    },
  ],
  [
    "S5 hash: hashFile matches hashText at the 1 MiB cap, undefined above",
    "pass",
    async () => {
      const MIB = 1024 * 1024;
      const atCap = join(tmp, "s5-cap.bin");
      writeFileSync(atCap, "a".repeat(MIB));
      const overCap = join(tmp, "s5-over.bin");
      writeFileSync(overCap, "a".repeat(MIB + 1));
      const hAt = await rc.hashFile(atCap);
      const hOver = await rc.hashFile(overCap);
      const expect = rc.hashText("a".repeat(MIB));
      return hAt === expect && hOver === undefined
        ? { blocked: false }
        : { blocked: true, reason: `cap boundary: at=${hAt} over=${hOver} expect=${expect}` };
    },
  ],
  [
    "S5 hash: certify stores hash (and stat) on the coverage entry",
    "pass",
    async () => {
      const cov = new Map();
      rc.certify(cov, "/s5/x", { start: 1, end: 5 }, "read", { mtimeMs: 1, size: 2 }, "deadbeefdeadbeef");
      const e = cov.get("/s5/x");
      return e && e.hash === "deadbeefdeadbeef" && e.stat && e.stat.mtimeMs === 1 && e.stat.size === 2
        ? { blocked: false }
        : { blocked: true, reason: `entry: ${JSON.stringify(e)}` };
    },
  ],
  [
    "S5 hash: certify without hash leaves entry hash unset",
    "pass",
    async () => {
      const cov = new Map();
      rc.certify(cov, "/s5/y", { start: 1, end: 5 }, "read");
      const e = cov.get("/s5/y");
      return e && e.hash === undefined
        ? { blocked: false }
        : { blocked: true, reason: `entry: ${JSON.stringify(e)}` };
    },
  ],

  // Step 2 (family 1): M1 stale-bind for edit — spec §5.1
  [
    "S5 M1: external write since last read blocks the edit (Stale)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m1-stale.ts");
      writeFileSync(f, "alpha\nbeta\ngamma\n");
      await read(pi, f);
      writeFileSync(f, "alpha\nbeta\ngamma\nepsilon\n"); // external writer: content + stat change
      const r = await edit(pi, f, [{ oldText: "gamma", newText: "GAMMA" }]);
      return r.blocked && r.reason.startsWith("Anchor Guard (Stale):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M1: targeted re-read clears the stale block",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m1-reread.ts");
      writeFileSync(f, "a\nb\nc\n");
      await read(pi, f);
      writeFileSync(f, "a\nb\nc\nd\n");
      const b1 = await edit(pi, f, [{ oldText: "c", newText: "C" }]);
      if (!b1.blocked) return { blocked: false, reason: "precondition: first edit not blocked" };
      await read(pi, f); // fresh stat certified
      return edit(pi, f, [{ oldText: "c", newText: "C" }]);
    },
  ],
  [
    "S5 M1: mutating bash (sed -i) makes a subsequent edit stale",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m1-sed.ts");
      writeFileSync(f, "alpha\nbeta\n");
      await read(pi, f);
      // runBash replays gate events only — the external writer must actually execute
      // `-i.bak` is the BSD+GNU portable form: BSD sed needs a suffix, GNU reads `-i ''` as script+file
      execSync(`sed -i.bak 's/^beta/BBB/' ${f}`);
      await runBash(pi, `sed -i.bak 's/^beta/BBB/' ${f}`);
      const r = await edit(pi, f, [{ oldText: "alpha", newText: "ALPHA" }]);
      return r.blocked && r.reason.startsWith("Anchor Guard (Stale):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M1: back-to-back own edits in the certified region still pass",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m1-own.ts");
      writeFileSync(f, "alpha\nbeta\n");
      await read(pi, f);
      // edit 1 certifies its post-edit span (lines 1–2) — edit 2 anchors inside it
      const e1 = await edit(pi, f, [{ oldText: "alpha\nbeta", newText: "ALPHA\nbeta" }]);
      if (e1.blocked) return e1;
      return edit(pi, f, [{ oldText: "beta", newText: "BETA" }]); // post-op stat re-certified by edit 1
    },
  ],

  // Step 3 (family 5): M3 hash chain for edit — spec §5.3. NOTE: the plan's
  // literal "read → same-stat change → blocked" contradicts spec §7 R2
  // (read-side hashing rejected); the spec wins — that sequence stays
  // stat-only and is locked in below as the documented residual.
  [
    "S5 M3: plain read stays stat-only — same-stat drift passes (R2)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m3-r2.ts");
      const T = new Date(Math.floor(Date.now() / 1000) * 1000);
      writeFileSync(f, "a\nb\nc\n");
      utimesSync(f, T, T); // round stat: exactly restorable
      await read(pi, f); // certifies stat only — no hash stored on reads
      writeFileSync(f, "a\nb\nx\n"); // same size, silent change
      utimesSync(f, T, T); // stat identical → M1 passes; no hash to compare
      return edit(pi, f, [{ oldText: "a", newText: "z" }]);
    },
  ],
  [
    "S5 M3: same-stat drift after own edit is blocked by the hash chain",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m3-chain.ts");
      const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
      writeFileSync(f, "a\nb\nc\n");
      utimesSync(f, T0, T0);
      await read(pi, f);
      const T1 = new Date(T0.getTime() + 60_000);
      // own edit: applies to disk, result stores the post-op hash (stat pinned to T1)
      const e1 = await editApplied(pi, f, "a", "z", T1);
      if (e1.blocked) return e1;
      writeFileSync(f, "z\nb\nx\n"); // same-size silent change
      utimesSync(f, T1, T1); // stat identical to the post-edit snapshot
      const r = await edit(pi, f, [{ oldText: "z", newText: "Z" }]);
      return r.blocked && r.reason.includes("without mtime/size change")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M3: re-read after a hash block is allowed and clears it",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m3-recover.ts");
      const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
      writeFileSync(f, "a\nb\nc\n");
      utimesSync(f, T0, T0);
      await read(pi, f);
      const T1 = new Date(T0.getTime() + 60_000);
      const e1 = await editApplied(pi, f, "a", "z", T1);
      if (e1.blocked) return e1;
      writeFileSync(f, "z\nb\nx\n");
      utimesSync(f, T1, T1);
      const b2 = await edit(pi, f, [{ oldText: "z", newText: "Z" }]);
      if (!b2.blocked) return { blocked: false, reason: "precondition: hash block missing" };
      // the corrective re-read must NOT be R1-blocked as a dup-read (the hash
      // proved the certified spans wrong — coverage was dropped on block)
      const rr = await read(pi, f);
      if (rr.blocked) return rr;
      return edit(pi, f, [{ oldText: "z", newText: "Z" }]);
    },
  ],
  [
    "S5 M3: >1 MiB file skips the hash chain (cap lock-in)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m3-big.bin");
      const head = "UNIQUEHEAD\n";
      writeFileSync(f, head + "x".repeat(1024 * 1024 + 2 - head.length));
      const T = new Date(Math.floor(Date.now() / 1000) * 1000);
      utimesSync(f, T, T);
      await read(pi, f, { offset: 1, limit: 5 }, { outputLines: 5 }); // windowed: R1b-safe
      const T2 = new Date(T.getTime() + 60_000);
      // own edit: result-side hashFile is over the cap → entry stays hash-less
      const e1 = await editApplied(pi, f, "UNIQUEHEAD", "UNIQUEHEAD2", T2);
      if (e1.blocked) return e1;
      // same-stat silent change in the unread tail — stat-only: must pass
      const body = readFileSync(f, "utf8");
      writeFileSync(f, body.slice(0, -1) + "y");
      utimesSync(f, T2, T2);
      return edit(pi, f, [{ oldText: "UNIQUEHEAD2", newText: "UNIQUEHEAD3" }]);
    },
  ],
  [
    "S5 M3: CRLF files do not false-block (hash normalization lock-in)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m3-crlf.ts");
      writeFileSync(f, "a\r\nb\r\n");
      await read(pi, f, { offset: 1, limit: 2 }, { outputLines: 2 });
      // own edit spanning both lines (post-span 1–2 keeps line 2 certified for
      // M2); result stores hashFile(content) — must hash the SAME normalized
      // view anchor-guard compares with (toLF + BOM strip), or every later
      // edit on a CRLF file false-blocks as same-stat drift
      const e1 = await edit(pi, f, [{ oldText: "a\nb", newText: "z\nb" }]);
      if (e1.blocked) return e1;
      return edit(pi, f, [{ oldText: "b", newText: "y" }]); // no drift: must pass
    },
  ],
  [
    "S5 M3: resumed-session entry without hash passes M3 (R4)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m3-resume.ts");
      // file + hydration ran in the preamble: entry has stat + spans, no hash
      writeFileSync(f, "a\nb\nx\n"); // same-size silent change
      utimesSync(f, getHydT(), getHydT()); // stat identical — content unknowable: fail open (R4)
      return edit(pi, f, [{ oldText: "a", newText: "z" }]);
    },
  ],

  // Step 4 (family 3): M2 region-read requirement for edit — spec §5.2
  [
    "S5 M2: never-read path with a valid anchor is blocked (Unread)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m2-unread.ts");
      writeFileSync(f, "alpha\nbeta\ngamma\n"); // anchor exists & is unique — but never read
      const r = await edit(pi, f, [{ oldText: "beta", newText: "BETA" }]);
      return r.blocked && r.reason.startsWith("Anchor Guard (Unread):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M2: never-read block names the anchor's line range",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m2-range.ts");
      writeFileSync(f, "l1\nl2\nl3\nl4\nl5\n");
      const r = await edit(pi, f, [{ oldText: "l4", newText: "x" }]);
      return r.blocked && r.reason.includes("lines 4–4")
        ? r
        : { blocked: false, reason: `range missing: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M2: targeted read covering the anchor lets the edit pass",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m2-cover.ts");
      writeFileSync(f, Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
      await read(pi, f, { offset: 40, limit: 10 }, { outputLines: 10 }); // certifies 40–49
      return edit(pi, f, [{ oldText: "l45", newText: "x" }]);
    },
  ],
  [
    "S5 M2: read window missing the anchor still blocks (naming its range)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m2-miss.ts");
      writeFileSync(f, Array.from({ length: 60 }, (_, i) => `l${i + 1}`).join("\n") + "\n");
      await read(pi, f, { offset: 1, limit: 10 }, { outputLines: 10 }); // certifies 1–10 only
      const r = await edit(pi, f, [{ oldText: "l50", newText: "x" }]);
      return r.blocked && r.reason.startsWith("Anchor Guard (Unread):") && r.reason.includes("lines 50")
        ? r
        : { blocked: false, reason: `family/range: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M2: mixed anchors — the uncovered one is named by index and range",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m2-mixed.ts");
      // zero-padded names: every oldText must stay unique (m2 would match m20..)
      writeFileSync(f, Array.from({ length: 60 }, (_, i) => `m${String(i + 1).padStart(2, "0")}`).join("\n") + "\n");
      await read(pi, f, { offset: 1, limit: 5 }, { outputLines: 5 }); // 1–5
      const r = await edit(pi, f, [
        { oldText: "m02", newText: "x" }, // covered
        { oldText: "m40", newText: "y" }, // not covered
      ]);
      return r.blocked && r.reason.includes("edits[1]") && r.reason.includes("lines 40")
        ? r
        : { blocked: false, reason: `idx/range: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M2: ENOENT path passes through to the tool",
    "pass",
    async (pi) =>
      edit(pi, join(tmp, "s5-m2-enoent.ts"), [{ oldText: "x", newText: "y" }]),
  ],
  [
    "S5 M2: fuzzy anchor passes binding with any coverage (R3)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m2-fuzzy.ts");
      writeFileSync(f, "aaa\nbbb \nccc\n"); // trailing space on line 2
      await read(pi, f, { offset: 1, limit: 1 }, { outputLines: 1 }); // line 1 only — anchor region NOT covered
      // oldText normalizes onto lines 1–3 (fuzzy) — region proof impossible in
      // normalized space; any certified coverage suffices (spec R3)
      return edit(pi, f, [{ oldText: "aaa\nbbb\nccc", newText: "q" }]);
    },
  ],
  [
    "S5 M2: post-compaction edit is blocked until re-read",
    "blocked",
    async (pi) => {
      const f = join(tmp, "s5-m2-compact.ts");
      writeFileSync(f, "alpha\nbeta\n");
      await read(pi, f);
      compact(pi); // compaction replaced the content — nothing is in context anymore
      const r = await edit(pi, f, [{ oldText: "alpha", newText: "ALPHA" }]);
      return r.blocked && r.reason.startsWith("Anchor Guard (Unread):")
        ? r
        : { blocked: false, reason: `family: ${r.reason ?? "(pass)"}` };
    },
  ],
  [
    "S5 M2: region below a prior edit's first line needs a re-read (B4)",
    "pass",
    async (pi) => {
      const f = join(tmp, "s5-m2-b4.ts");
      writeFileSync(f, "aaa\nbbb\n");
      await read(pi, f);
      const e1 = await edit(pi, f, [{ oldText: "aaa", newText: "AAA" }]);
      if (e1.blocked) return e1;
      // B4 truncation dropped lines ≥1 at edit 1 — line 2 is no longer certified
      const e2 = await edit(pi, f, [{ oldText: "bbb", newText: "BBB" }]);
      if (!e2.blocked || !e2.reason.startsWith("Anchor Guard (Unread):"))
        return { blocked: false, reason: `expected Unread: ${e2.reason ?? "(pass)"}` };
      await read(pi, f, { offset: 2, limit: 1 }, { outputLines: 1 }); // targeted re-read
      return edit(pi, f, [{ oldText: "bbb", newText: "BBB" }]);
    },
  ],

  // Step 5 (families 2+4): binding for the write tool — spec §5.1–§5.3.
  // A blind full overwrite silently reverts external changes — the worst
  // failure class — so writes to EXISTING files bind like edits.
];
