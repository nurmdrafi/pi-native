// Permission-gate cases for rules.reReadGuard.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { textBlocks, lineText, read, piread, edit, write, tmp, fileA, relA, skillFile, fileC, fileD, fileE, hydrate, spanFile, nextId } from "../../harness/helpers.mjs";

export const cases = [
  // ---- B3/H9 (2026-10-08): true post-edit spans via position-sorted overlay math ----
  [
    "B3: out-of-order edits certify true post-edit lines",
    "pass",
    async (pi) => {
      const f = join(tmp, "b3.ts");
      writeFileSync(
        f,
        Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n") + "\n",
      );
      await read(pi, f, {}, { outputLines: 12, totalLines: 12 }); // S5 M2: certify the file first
      // edit[0] touches line 8-9 (2→1 lines); edit[1] touches line 2 (1→3 lines)
      const r = await edit(pi, f, [
        { oldText: "L8\nL9", newText: "M8" },
        { oldText: "L2", newText: "N2a\nN2b\nN2c" },
      ]);
      if (r.blocked) return { blocked: true, reason: r.reason };
      // true post-edit layout: N2a..N2c = lines 2-4; M8 = line 10
      const re24 = await read(
        pi,
        f,
        { offset: 2, limit: 3 },
        { outputLines: 3 },
      );
      if (!re24.blocked)
        return {
          blocked: true,
          reason: "B3: true post-edit lines 2-4 not certified",
        };
      const re10 = await read(
        pi,
        f,
        { offset: 10, limit: 1 },
        { outputLines: 1 },
      );
      if (!re10.blocked)
        return {
          blocked: true,
          reason: "B3: shifted M8 line not certified at 10",
        };
      return { blocked: false };
    },
  ],
  [
    "B4: re-read below a line-count-changing edit is allowed (§8: the shifted span stays certified — the redundant re-read now blocks)",
    "blocked",
    async (pi) => {
      const f = join(tmp, "b4.ts");
      writeFileSync(
        f,
        Array.from({ length: 30 }, (_, i) => `L${i + 1}`).join("\n") + "\n",
      );
      await read(pi, f, {}, { outputLines: 30, totalLines: 30 }); // certify 1-30
      const r = await edit(pi, f, [{ oldText: "L5", newText: "X\nY\nZ" }]); // +2 lines at line 5
      if (r.blocked) return { blocked: true, reason: r.reason };
      return read(pi, f, { offset: 20, limit: 3 }, { outputLines: 3 }); // shifted content: must allow
    },
  ],
  [
    "full re-read after external on-disk change passes",
    "pass",
    async (pi) => read(pi, fileA),
  ],
  [
    "any window after an image read is blocked",
    "blocked",
    async (pi) => read(pi, fileA, { offset: 5, limit: 5 }, { outputLines: 5, tool: "read" }),
  ],
  [
    "relative-path re-read of an absolute-read file is blocked",
    "blocked",
    async (pi) => read(pi, relA, { offset: 1, limit: 3 }, { outputLines: 3 }),
  ],
  [
    "no-details fallback certifies exactly the content lines",
    "pass",
    async (pi) =>
      read(
        pi,
        fileA,
        { offset: 6, limit: 1 },
        { outputLines: 1, noDetails: true },
      ),
  ],
  // ---- skill re-read (2026-10-06 feedback item — R1 coverage closes it) ----
  [
    "full SKILL.md re-read same session is blocked",
    "blocked",
    async (pi) => read(pi, skillFile, {}, { outputLines: 30, totalLines: 30 }),
  ],
  [
    "SKILL.md re-read after compaction passes",
    "pass",
    async (pi) => read(pi, skillFile, {}, { outputLines: 30, totalLines: 30 }),
  ],
  // ---- R1 resume hydration (2026-10-07: coverage replays from the previous session file) ----
  [
    "resume hydration: prior full read blocks re-read window",
    "blocked",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: fileC },
        { id: "e2", resultFor: "c1", text: "l1\nl2\nl3\n" },
      ]);
      return read(pi, fileC, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  [
    "resume hydration: changed-on-disk file re-read passes",
    "pass",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: fileC },
        { id: "e2", resultFor: "c1", text: "l1\nl2\nl3\n" },
      ]);
      writeFileSync(fileC, "CHANGED\nl2\nl3\nl4\n"); // stat must mismatch the certified snapshot
      return read(pi, fileC, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  [
    "resume hydration: pre-compaction reads stay legitimate",
    "pass",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: fileD },
        { id: "e2", resultFor: "c1", text: "l1\nl2\n" },
        { id: "e3", compactionAfter: "e4" },
        { id: "e4", call: "read", callId: "c2", path: fileC },
        { id: "e5", resultFor: "c2", text: "l1\nl2\nl3\n" },
      ]);
      return read(pi, fileD, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  [
    "resume hydration: prior write certifies the whole file",
    "blocked",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "write", callId: "c1", path: fileE },
        { id: "e2", resultFor: "c1", text: "ok", tool: "write" },
      ]);
      return read(pi, fileE, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  // ---- H6 (2026-10-08): hydration safety — replayed edits clear coverage (B7) ----
  [
    "resume hydration: replayed edit clears coverage (B7/H6)",
    "pass",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: fileC },
        { id: "e2", resultFor: "c1", text: "l1\nl2\nl3\n" },
        { id: "e3", call: "edit", callId: "c2", path: fileC },
        { id: "e4", resultFor: "c2", text: "ok", tool: "edit" },
      ]);
      return read(pi, fileC, { offset: 1, limit: 2 }, { outputLines: 2 }); // must be allowed
    },
  ],
  [
    "resume hydration: re-start with an empty branch drops prior coverage",
    "pass",
    async (pi) => {
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: fileC },
        { id: "e2", resultFor: "c1", text: "l1\nl2\nl3\n" },
      ]);
      await pi.invoke(
        "session_start",
        { type: "session_start", reason: "new" },
        { sessionManager: { getBranch: () => [] } },
      ); // in-process switch to a fresh session
      return read(pi, fileC, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  // ---- item 5 — hydration freshness on reads ----
  [
    "resume hydration: read of a file changed after the replayed read passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "hydrate-ts.ts");
      writeFileSync(f, "l1\nl2\n");
      const past = new Date(Date.now() - 60_000).toISOString();
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: f, ts: past },
        { id: "e2", resultFor: "c1", text: "l1\nl2\n" },
      ]);
      return read(pi, f, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  [
    "resume hydration: read of an unchanged file still blocks",
    "blocked",
    async (pi) => {
      const f = join(tmp, "hydrate-ts2.ts");
      writeFileSync(f, "l1\nl2\n");
      const future = new Date(Date.now() + 60_000).toISOString(); // mtime <= ts+1s → fresh
      await hydrate(pi, [
        { id: "e1", call: "read", callId: "c1", path: f, ts: future },
        { id: "e2", resultFor: "c1", text: "l1\nl2\n" },
      ]);
      return read(pi, f, { offset: 1, limit: 2 }, { outputLines: 2 });
    },
  ],
  // ---- item 6 — pre-edit stat + fuzzy anchors drop stale coverage ----
  [
    "item6: external drift between read and edit blocks the edit (M1)",
    "pass",
    async (pi) => {
      const f = join(tmp, "drift.ts");
      // S5 M1: drift before the edit call now blocks at tool_call (family 1);
      // the blocked edit never certifies — and the stale span must not block the re-read
      const e = await edit(pi, f, [{ oldText: "a", newText: "z" }]);
      if (!e.blocked || !e.reason.startsWith("Anchor Guard (Stale):"))
        return { blocked: false, reason: `family: ${e.reason ?? "(pass)"}` };
      return read(pi, f, { offset: 3, limit: 1 }, { outputLines: 1 });
    },
  ],
  [
    "item6: fuzzy-matched edit drops the path coverage",
    "pass",
    async (pi) => {
      const f = join(tmp, "fuzzy.ts");
      writeFileSync(f, "a\nb\nc\n");
      await read(pi, f, { offset: 1, limit: 3 }, { outputLines: 3 });
      // trailing space on the b line: exact miss, fuzzy hit (trailing-ws normalization)
      const e = await edit(pi, f, [{ oldText: "a\nb \nc", newText: "q" }]);
      if (e.blocked)
        return { blocked: true, reason: "fuzzy edit blocked: " + e.reason };
      return read(pi, f, { offset: 1, limit: 1 }, { outputLines: 1 }); // coverage dropped → allowed
    },
  ],
  // ---- item 11 — reason reports the covering span ----
  [
    "R1 reason reports the covering span, not the outer bounds",
    "blocked",
    async (pi) => {
      await read(pi, spanFile, { offset: 1, limit: 50 }, { outputLines: 50 }); // span 1-50
      await read(pi, spanFile, { offset: 60, limit: 11 }, { outputLines: 11 }); // span 60-70 (gap 51-59)
      const r = await read(
        pi,
        spanFile,
        { offset: 10, limit: 5 },
        { outputLines: 5 },
      );
      return r.blocked &&
        r.reason.includes("1–50") &&
        !r.reason.includes("1–70")
        ? r
        : { blocked: false, reason: r.reason };
    },
  ],
  [
    "R1 gap between spans still lets the gap window through",
    "pass",
    async (pi) =>
      read(pi, spanFile, { offset: 53, limit: 3 }, { outputLines: 3 }),
  ],
  // ---- backlog §9 (2026-10-25): elided reads certify only rendered runs ----
  [
    "R1 §9: an elided read leaves the omitted middle uncertified — re-read allowed",
    "pass",
    async (pi) => {
      const f = join(tmp, "r1s9.ts");
      writeFileSync(f, lineText(300));
      const head = Array.from({ length: 21 }, (_, i) => `line ${225 + i}`);
      const tail = Array.from({ length: 21 }, (_, i) => `line ${270 + i}`);
      const text = [
        ...head,
        "",
        "[... omitted 1942 chars / 24 lines ...]",
        "",
        ...tail,
      ].join("\n");
      const toolCallId = `tc${nextId()}`;
      const input = { path: f, offset: 225, limit: 66 };
      const block = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "piread",
        toolCallId,
        input,
      });
      if (block) return { blocked: true, reason: block.reason };
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piread",
        toolCallId,
        input,
        content: textBlocks(text),
        details: {
          truncation: { truncated: false, outputLines: 66, totalLines: 300 },
          compaction: {
            strategy: "head-tail",
            originalChars: 3600,
            visibleChars: 1100,
            omittedChars: 1942,
            partial: false,
          },
        },
        isError: false,
      });
      // the omitted middle (246–269) was never rendered — must stay readable
      return read(pi, f, { offset: 246, limit: 24 }, { outputLines: 24 });
    },
  ],
  [
    "R1 §9: an elided read still certifies the rendered head",
    "blocked",
    async (pi) => {
      const f = join(tmp, "r1s9-head.ts");
      writeFileSync(f, lineText(300));
      const head = Array.from({ length: 21 }, (_, i) => `line ${225 + i}`);
      const tail = Array.from({ length: 21 }, (_, i) => `line ${270 + i}`);
      const text = [
        ...head,
        "",
        "[... omitted 1942 chars / 24 lines ...]",
        "",
        ...tail,
      ].join("\n");
      const toolCallId = `tc${nextId()}`;
      const input = { path: f, offset: 225, limit: 66 };
      const block = await pi.invoke("tool_call", {
        type: "tool_call",
        toolName: "piread",
        toolCallId,
        input,
      });
      if (block) return { blocked: true, reason: block.reason };
      await pi.invoke("tool_result", {
        type: "tool_result",
        toolName: "piread",
        toolCallId,
        input,
        content: textBlocks(text),
        details: {
          truncation: { truncated: false, outputLines: 66, totalLines: 300 },
          compaction: {
            strategy: "head-tail",
            originalChars: 3600,
            visibleChars: 1100,
            omittedChars: 1942,
            partial: false,
          },
        },
        isError: false,
      });
      // the rendered head (225–245) IS in context — a re-read stays blocked
      return read(pi, f, { offset: 228, limit: 3 }, { outputLines: 3 });
    },
  ],
];
