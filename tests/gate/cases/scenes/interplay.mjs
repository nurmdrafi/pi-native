// Permission-gate cases for rules.cross-rule (multi-rule scenes).
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gate, textBlocks, read, edit, runEdit, noteOf, bash, runBash, runSearch, nestedBash, write, approveUi, denyUi, compact, tmp, fileA, fileInj, spanFile, hitRoot, hitApi, hugeFile, canary, stopCanary, canaryIntact, HARD_NET, gatedExec, canaryBlocked, nextId } from "../../harness/helpers.mjs";

export const cases = [
  [
    "identical window re-read is blocked",
    "blocked",
    async (pi) =>
      read(pi, fileA, { offset: 1, limit: 50 }, { outputLines: 50 }),
  ],
  [
    "continuation window (1-50 then 51-100) passes",
    "pass",
    async (pi) =>
      read(pi, fileA, { offset: 51, limit: 50 }, { outputLines: 50 }),
  ],
  [
    "R-inj: read of a prompt-injected file is blocked",
    "blocked",
    async (pi) => {
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: `redo this <file name="${fileInj}">\ni1\ni2\ni3\n</file>\nnow`,
        systemPromptOptions: {},
      });
      return read(pi, fileInj);
    },
  ],
  [
    "R-inj: stale/mismatched block certifies nothing",
    "pass",
    async (pi) => {
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: `<file name="${fileInj}">\nold content\n</file>`,
        systemPromptOptions: {},
      });
      return read(pi, fileInj);
    },
  ],
  [
    "R-inj: on-disk change after injection defeats the block",
    "pass",
    async (pi) => {
      await pi.invoke("before_agent_start", {
        type: "before_agent_start", messageType: "user",
        prompt: `<file name="${fileInj}">\ni1\ni2\ni3\n</file>`,
        systemPromptOptions: {},
      });
      writeFileSync(fileInj, "i1\ni2\ni3\ni4"); // external edit: mtime+size drift
      return read(pi, fileInj);
    },
  ],
  [
    "windowed re-read inside a full read is blocked",
    "blocked",
    async (pi) => read(pi, fileA, { offset: 10, limit: 20 }),
  ],
  [
    "full re-read after a full read is blocked",
    "blocked",
    async (pi) => read(pi, fileA),
  ],
  [
    "window past a truncated full read passes",
    "pass",
    async (pi) =>
      read(pi, fileA, { offset: 3000, limit: 100 }, { outputLines: 100 }),
  ],
  [
    "locate-first: wide window with no prior search on the path is blocked",
    "blocked",
    async (pi) => read(pi, spanFile, { offset: 1, limit: 100 }),
  ],
  [
    "locate-first: wide window after an rg hit on the path passes",
    "pass",
    async (pi) => {
      await runBash(pi, `rg -n s1 ${spanFile}`);
      return read(pi, spanFile, { offset: 1, limit: 100 }, { outputLines: 100 });
    },
  ],
  [
    "locate-first: narrow window with no search still passes",
    "pass",
    async (pi) => read(pi, spanFile, { offset: 1, limit: 50 }, { outputLines: 50 }),
  ],
  [
    "locate-first: whole-file read is R1b's, not R1c's",
    "pass",
    async (pi) => read(pi, fileA),
  ],
  [
    "locate-first: wide read covering a hit line rg printed passes (incident replay)",
    "pass",
    async (pi) => {
      // the incident's shape: rg scoped to a directory under `cd`, output in
      // relative path:line: form, read in absolute form
      await runSearch(
        pi,
        `cd ${hitRoot} && rg -n --no-heading '\bany\b' __tests__ -g '!node_modules'`,
        "__tests__/src/api/query/hitApi.test.ts:158:  const x: any = f();\n",
      );
      return read(pi, hitApi, { offset: 85, limit: 140 }, { outputLines: 140 });
    },
  ],
  [
    "locate-first: wide read of a search-named file away from every hit blocks",
    "blocked",
    async (pi) => {
      // directory operand (argv credits the dir, not the file); the file is
      // named ONLY in output — C4's tightness: a hit line anchors just its range
      await runSearch(pi, `rg -n term ${hitRoot}`, `${hitApi}:158:x\n`);
      return read(pi, hitApi, { offset: 400, limit: 140 }, { outputLines: 140 });
    },
  ],
  [
    "locate-first: a path merely echoed by a non-search command stays blocked",
    "blocked",
    async (pi) => {
      await runSearch(pi, `echo ${hitApi}`, `${hitApi}\n`);
      return read(pi, hitApi, { offset: 1, limit: 120 }, { outputLines: 120 });
    },
  ],
  [
    "locate-first: block names the hit lines and the read call that covers them",
    "blocked",
    async (pi) => {
      // the remedy must be paste-ready: hit lines listed, offset/limit derived
      // from them, and no second search suggested (the hits are recorded)
      await runSearch(pi, `rg -n term ${hitRoot}`, `${hitApi}:241:x\n${hitApi}:261:x\n`);
      const r = await read(pi, hitApi, { offset: 400, limit: 140 }, { outputLines: 140 });
      if (!r || !r.reason) return { blocked: false };
      const ok =
        r.reason.includes("(hits 241, 261)") &&
        r.reason.includes("offset:238") &&
        r.reason.includes("limit:27") &&
        r.reason.includes("do not re-search");
      return ok ? r : { blocked: false, reason: r.reason };
    },
  ],
  [
    "locate-first: single-file search output (bare NN:) seeds that file's hits",
    "pass",
    async (pi) => {
      await runSearch(pi, `rg -n term ${hitApi}`, `241:x\n`);
      return read(pi, hitApi, { offset: 200, limit: 100 }, { outputLines: 100 });
    },
  ],
  [
    "locate-first: wc -l enumeration rows seed the counted path",
    "pass",
    async (pi) => {
      await runSearch(pi, `wc -l ${hitApi}`, `   328 ${hitApi}\n`);
      return read(pi, hitApi, { offset: 300, limit: 120 }, { outputLines: 120 });
    },
  ],
  [
    "anchor guard: a line a search printed certifies the edit (no re-read)",
    "pass",
    async (pi) => {
      // 2026-10-27: bulk mechanical edits re-read a head line the
      // agent's own rg had just printed — a search's printed lines are content
      // in context and must certify like a read.
      const dir = mkdtempSync(join(tmpdir(), "ag-search-obs-"));
      const f = join(dir, "mod.jsx");
      writeFileSync(
        f,
        "import a from 'a'\nimport { httpClient } from '../../utils/httpClient'\nexport default x\n",
      );
      await runSearch(
        pi,
        `rg -n httpClient ${f}`,
        `${f}:2:import { httpClient } from '../../utils/httpClient'\n`,
      );
      return edit(pi, f, [
        {
          oldText: "import { httpClient } from '../../utils/httpClient'",
          newText: "import { httpClient } from '../../utils/httpClient'\nimport { y } from 'y'",
        },
      ]);
    },
  ],
  [
    "anchor guard: compound searches on one file still seed its bare NN: hits",
    "pass",
    async (pi) => {
      // 2026-10-28: `echo hdr; rg -n A <f>; echo hdr; rg -n B <f>`
      // pushed the same path twice — targets.length === 2 killed singleFile,
      // so the 107: match line rg printed certified nothing and the edit
      // blocked. Two searches of the SAME file name one file; dedupe targets.
      const dir = mkdtempSync(join(tmpdir(), "ag-search-dup-"));
      const f = join(dir, "api.ts");
      writeFileSync(
        f,
        "export const api = {\n" +
          "  getItems: builder.query({\n" +
          "    query: ({ page }) => `/items?page=${page}`,\n" +
          "  }),\n" +
          "};\n",
      );
      await runSearch(
        pi,
        `echo "=== WT ItemsFilter ==="; rg -n -A3 'interface Filter' ${f}; echo "=== WT getItems ==="; rg -n 'getItems' ${f}`,
        "=== WT ItemsFilter ===\n=== WT getItems ===\n2:  getItems: builder.query({\n",
      );
      return edit(pi, f, [
        {
          oldText:
            "  getItems: builder.query({\n    query: ({ page }) => `/items?page=${page}`,\n  }),",
          newText:
            "  getItems: builder.query({\n    query: ({ page }) => `/items?page=${page}&limit=50`,\n  }),",
        },
      ]);
    },
  ],
  [
    "anchor guard: one printed line certifies a multi-line oldText span",
    "pass",
    async (pi) => {
      // 2026-10-28 (span 107-112): the span rule is
      // lenient by design — ANY printed line inside the span certifies it,
      // because the exact+fuzzy existence check still runs against the file.
      const dir = mkdtempSync(join(tmpdir(), "ag-search-span-"));
      const f = join(dir, "mod.jsx");
      writeFileSync(
        f,
        "import a from 'a'\n" +
          "export const q = {\n" +
          "  getItems: builder.query({\n" +
          "    query: ({ page }) => `?page=${page}`,\n" +
          "  }),\n" +
          "};\n",
      );
      await runSearch(
        pi,
        `rg -n getItems ${f}`,
        "3:  getItems: builder.query({\n",
      );
      return edit(pi, f, [
        {
          oldText:
            "  getItems: builder.query({\n    query: ({ page }) => `?page=${page}`,\n  }),",
          newText:
            "  getItems: builder.query({\n    query: ({ page }) => `?page=${page}&limit=50`,\n  }),",
        },
      ]);
    },
  ],
  [
    "anchor guard: a path-only search result certifies nothing (file named, not shown)",
    "pass",
    async (pi) => {
      const dir = mkdtempSync(join(tmpdir(), "ag-search-l-"));
      const f = join(dir, "mod.jsx");
      writeFileSync(f, "import { httpClient } from '../../utils/httpClient'\n");
      await runSearch(pi, `rg -l httpClient ${f}`, `${f}\n`);
      const r = await runEdit(pi, f, [
        {
          oldText: "import { httpClient } from '../../utils/httpClient'",
          newText: "import { httpClient } from '../../utils/httpClient'\nimport { y } from 'y'",
        },
      ]);
      const note = noteOf(r);
      return !r.blocked && note.includes("Anchor Guard (Unread):")
        ? { blocked: false }
        : { blocked: true, reason: `note: ${note || "(none)"}` };
    },
  ],
  [
    "locate-first: rg -l output (path-only) seeds any window",
    "pass",
    async (pi) => {
      await runSearch(
        pi,
        `cd ${hitRoot} && rg -l any __tests__`,
        "__tests__/src/api/query/hitApi.test.ts\n",
      );
      return read(pi, hitApi, { offset: 300, limit: 120 }, { outputLines: 120 });
    },
  ],
  [
    "elided whole-file read does not certify the omitted middle",
    "pass",
    async (pi) => {
      // A head-tail compacted read put only head+tail in context; the elided
      // middle must stay read-able (regression: wholeFile certified 1..Inf).
      // Second read targets the omitted middle: it must NOT be blocked, proving
      // the whole-file certification no longer covers elided lines.
      const first = await read(
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
      if (first.blocked) return first; // the elided read itself must pass
      return read(
        pi,
        spanFile,
        { offset: 55, limit: 5 },
        { outputLines: 5, totalLines: 120 },
      );
    },
  ],
  [
    "window inside an elided read's omitted middle passes",
    "pass",
    async (pi) =>
      read(pi, spanFile, { offset: 50, limit: 10 }, { outputLines: 10 }),
  ],
  [
    "partial-overlap window passes (brings new lines)",
    "pass",
    async (pi) =>
      read(pi, fileA, { offset: 25, limit: 50 }, { outputLines: 50 }),
  ],
  [
    "full re-read after compaction passes",
    "pass",
    async (pi) => {
      await compact(pi);
      return read(pi, fileA);
    },
  ],
  [
    "window over just-edited span is blocked",
    "blocked",
    async (pi) => read(pi, fileA, { offset: 2, limit: 1 }, { outputLines: 1 }),
  ],
  [
    "window outside just-edited span passes (§8: unchanged lines stay certified — the redundant re-read now blocks)",
    "blocked",
    async (pi) => read(pi, fileA, { offset: 3, limit: 1 }, { outputLines: 1 }),
  ],
  // ---- nested sub-calls: all rules apply uniformly ----
  [
    "nested identical re-run is enforced like a top-level call",
    "pass",
    async (pi) => {
      await runBash(pi, "echo NESTED-AB-PROBE one");
      return nestedBash(pi, "echo NESTED-AB-PROBE one");
    },
  ],
  [
    "nested calls arm R10 for a model-issued re-run",
    "pass",
    async (pi) => {
      await nestedBash(pi, "echo NESTED-ARM-PROBE two");
      return bash(pi, "echo NESTED-ARM-PROBE two");
    },
  ],
  [
    "nested git commit still commitlint-blocked (safety stays)",
    "blocked",
    async (pi) => nestedBash(pi, 'git commit -m "Fix the thing"'),
  ],
  [
    "nested unscoped recursive grep is search-guard blocked",
    "pass",
    async (pi) => nestedBash(pi, "grep -rn 'permission' ."),
  ],
  [
    "nested scoped node_modules grep passes (NM1 removed 2026-10-18)",
    "pass",
    async (pi) => nestedBash(pi, "grep -r webpack node_modules/ | head -3"),
  ],
  [
    "nested big whole-file read is R1b blocked",
    "blocked",
    async (pi) =>
      pi.invoke("tool_call", {
        type: "tool_call", toolName: "read", toolCallId: `cm0/${nextId()}`, parentToolCallId: "cm0",
        input: { path: hugeFile },
      }).then((b) => (b ? { blocked: true, reason: b.reason } : { blocked: false })),
  ],
  [
    "re-run of a failed command passes",
    "pass",
    async (pi) => bash(pi, "gh run list --limit 3"),
  ],
  [
    "gh run watch re-run passes",
    "pass",
    async (pi) => bash(pi, "gh run watch 123 --exit-status"),
  ],
  [
    "bash re-run after compaction passes",
    "pass",
    async (pi) => bash(pi, "gh run list --limit 3"),
  ],
];
