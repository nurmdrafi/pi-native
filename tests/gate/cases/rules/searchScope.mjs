// Permission-gate cases for rules.searchScope.
// Split out of tests/permission-gate.test.mjs; attribution is by section,
// so a new case belongs in the module of the rule it primarily asserts.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { read, bash, approveUi, tmp } from "../../harness/helpers.mjs";

export const cases = [
  // ---- TC/SS/PB/NM (2026-10-13 audit): toolchain pins + search scope ----
  // fixtures carry their own manifests; the harness root (.nvmrc "24", no
  // pnpm marker) stays TC-inert so the legacy default-cwd cases are unaffected
  [
    "TC1: npm blocked in a pnpm repo (packageManager)",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-pnpm1");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", packageManager: "pnpm@9.15.0" }),
      );
      const r = await bash(pi, "npm install lodash", {
        ...approveUi(),
        cwd: repo,
      });
      return r.blocked && !r.reason.startsWith("Toolchain (pnpm)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "TC1: yarn blocked in a pnpm repo (pnpm-lock)",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-pnpm2");
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "pnpm-lock.yaml"), "\n");
      const r = await bash(pi, "yarn install", { ...approveUi(), cwd: repo });
      return r.blocked && !r.reason.startsWith("Toolchain (pnpm)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "TC1: npx pnpm and pnpm itself pass in a pnpm repo",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-pnpm3");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", packageManager: "pnpm@9.15.0" }),
      );
      const ctx = { ...approveUi(), cwd: repo };
      const a = await bash(pi, "npx pnpm dlx typescript", ctx);
      if (a.blocked) return a;
      return bash(pi, "pnpm run check-types", ctx);
    },
  ],
  [
    "TC2: exact Node pin mismatch blocks node-family binaries",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-node1");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", engines: { node: "99.9.9" } }),
      );
      const r = await bash(pi, "pnpm run check-types", {
        ...approveUi(),
        cwd: repo,
      });
      return r.blocked && !r.reason.startsWith("Toolchain (Node)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "TC2: nvm use in the same command bypasses the pin check",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-node2");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", engines: { node: "99.9.9" } }),
      );
      return bash(
        pi,
        "source ~/.nvm/nvm.sh && nvm use 99.9.9 >/dev/null 2>&1 && pnpm run check-types",
        { ...approveUi(), cwd: repo },
      );
    },
  ],
  [
    "TC2: explicit pinned binary path passes",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-node3");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", engines: { node: "99.9.9" } }),
      );
      return bash(pi, "/x/.nvm/versions/node/v99.9.9/bin/node -v", {
        ...approveUi(),
        cwd: repo,
      });
    },
  ],
  [
    "TC2: range engines pins stay advisory",
    "pass",
    async (pi) => {
      const repo = join(tmp, "tc-node4");
      mkdirSync(repo, { recursive: true });
      writeFileSync(
        join(repo, "package.json"),
        JSON.stringify({ name: "r", engines: { node: "^22.0.0" } }),
      );
      return bash(pi, "node -v", { ...approveUi(), cwd: repo });
    },
  ],
  [
    "PB1: grep -P is advisory (warn) on darwin — detection pinned in search-guard units",
    "pass",
    async (pi) => bash(pi, "grep -Prn 'foo\\.bar' src/", approveUi()),
  ],
  [
    "SS1: unscoped recursive grep blocked",
    "pass",
    async (pi) => {
      const r = await bash(
        pi,
        "grep -rn 'allNotifications consumers' .",
        approveUi(),
      );
      return r.blocked && !r.reason.startsWith("Search (Scope)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS2: path-scoped grep still blocked (rg-first)",
    "pass",
    async (pi) => {
      const r = await bash(pi, "grep -rn 'x' src/", approveUi());
      return r.blocked && !r.reason.startsWith("Search (rg-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS2: --include-scoped grep still blocked (rg-first)",
    "pass",
    async (pi) => {
      const r = await bash(
        pi,
        "grep -rn --include='*.ts' 'x' .",
        approveUi(),
      );
      return r.blocked && !r.reason.startsWith("Search (rg-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS2: non-recursive grep still blocked (rg-first)",
    "pass",
    async (pi) => {
      const r = await bash(pi, "grep -n 'x' package.json", approveUi());
      return r.blocked && !r.reason.startsWith("Search (rg-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS2: mid-pipe grep blocked",
    "pass",
    async (pi) => {
      const r = await bash(pi, "ls | grep -i json", approveUi());
      return r.blocked && !r.reason.startsWith("Search (rg-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS2: scoped rg passes",
    "pass",
    async (pi) => bash(pi, "rg 'x' src/", approveUi()),
  ],
  [
    "SS3: bare find blocked (fd-first)",
    "pass",
    async (pi) => {
      const r = await bash(pi, "find src -name '*.ts'", approveUi());
      return r.blocked && !r.reason.startsWith("Search (fd-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS3: fd passes",
    "pass",
    async (pi) => bash(pi, "fd -e ts . src/", approveUi()),
  ],
  [
    "SS3: find into node_modules → fd reason (NM1 removed 2026-10-18)",
    "pass",
    async (pi) => {
      const r = await bash(pi, "find node_modules -name vite.ts", approveUi());
      return r.blocked && !r.reason.startsWith("Search (fd-first)")
        ? { blocked: false, reason: `wrong family: ${r.reason.slice(0, 60)}` }
        : r;
    },
  ],
  [
    "SS1: unscoped rg passes (gitignore-aware by design)",
    "pass",
    async (pi) => bash(pi, "rg 'pattern'", approveUi()),
  ],
  [
    "NM1 removed (2026-10-18): scoped grep into node_modules passes",
    "pass",
    async (pi) => bash(pi, "grep -rn 'x' node_modules/vite-tsconfig-paths/", approveUi()),
  ],
  [
    "NM1 removed (2026-10-18): cat into node_modules passes",
    "pass",
    async (pi) => bash(pi, "cat node_modules/.pnpm/foo/index.js", approveUi()),
  ],
  [
    "node_modules: grep into @earendil-works pi docs allowed",
    "pass",
    async (pi) =>
      bash(
        pi,
        "grep -n 'compaction' node_modules/@earendil-works/pi-coding-agent/docs/compaction.md",
        approveUi(),
      ),
  ],
  [
    "node_modules: read tool into @earendil-works allowed",
    "pass",
    async (pi) =>
      read(
        pi,
        join(tmp, "node_modules", "@earendil-works", "pi-coding-agent", "README.md"),
        { offset: 1, limit: 5 },
        { outputLines: 5 },
        approveUi(),
      ),
  ],
  [
    "NM1 removed (2026-10-18): grep with absolute node_modules dir passes",
    "pass",
    async (pi) =>
      bash(
        pi,
        "grep -rn 'lodash' /abs/path/node_modules --include='*.json' | head -5",
        approveUi(),
      ),
  ],
  [
    "node_modules: ls passes (presence check)",
    "pass",
    async (pi) => bash(pi, "ls node_modules", approveUi()),
  ],
  [
    "NM1 removed (2026-10-18): read tool into node_modules passes",
    "pass",
    async (pi) => {
      const f = join(tmp, "node_modules", "x", "index.js");
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, "module.exports = 1;\n");
      return read(pi, f, { offset: 1, limit: 5 }, { outputLines: 5 });
    },
  ],

];
