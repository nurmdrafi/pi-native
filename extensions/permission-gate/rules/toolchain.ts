/**
 * Toolchain gate (TC) — mechanical enforcement of docs/agent-hygiene.md
 * "Toolchain": the repo's pinned package manager and Node version are used.
 *
 * 2026-10-13 session audit (38 sessions): `npx`/`npm` in a pnpm repo → 7
 * failed runs (pnpm-field warnings, lockfile drift); Node v24.3.0 against a
 * 22.17.0 pin → 4× `Unsupported engine` + `Cannot find module
 * 'esbuild'/'@next/env'`. Advisory text did not stop either class.
 *
 * | ID  | Check                                              | Fix carried in the reason |
 * |-----|----------------------------------------------------|---------------------------|
 * | TC1 | pnpm repo (packageManager/pnpm-lock) + npm/npx/yarn | pnpm run/exec/dlx        |
 * | TC2 | exact Node pin (.nvmrc/engines) ≠ interpreter       | nvm use <pin> && …        |
 *
 * Inert unless a manifest pins the toolchain: TC1 needs a pnpm marker, TC2
 * an EXACT x.y.z pin (ranges ^ ~ >= and major-only like "24" stay advisory —
 * the harness root pins "24" and must not self-block). Explicit binary paths
 * (…/versions/node/v22.17.0/bin/node) and version-manager commands (nvm/volta/
 * mise/asdf/fnm use, direnv) are honored — the shell switches PATH itself.
 * process.version is the pi interpreter; the bash tool's fresh shell resolves
 * the same default PATH node (audit evidence), so it is the right proxy.
 * PGATE_TOOLCHAIN=0 disables the whole module.
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";

interface RepoManifest {
  pm?: string; // packageManager field
  enginesNode?: string; // engines.node, raw
  nvmrc?: string; // .nvmrc, raw
  pnpmLock: boolean;
}
/** per-root manifest cache, keyed on the mtimes of its three sources */
const cache = new Map<string, { key: string; m: RepoManifest }>();

const mtimeOf = (p: string): number => {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return -1;
  }
};

function readManifest(cwd: string | undefined): RepoManifest {
  const root = cwd ?? process.cwd();
  const pkgP = join(root, "package.json");
  const nvmP = join(root, ".nvmrc");
  const lockP = join(root, "pnpm-lock.yaml");
  const key = `${mtimeOf(pkgP)}:${mtimeOf(nvmP)}:${mtimeOf(lockP)}`;
  const hit = cache.get(root);
  if (hit && hit.key === key) return hit.m;
  const m: RepoManifest = { pnpmLock: mtimeOf(lockP) >= 0 };
  try {
    const pkg = JSON.parse(readFileSync(pkgP, "utf8")) as {
      packageManager?: unknown;
      engines?: { node?: unknown };
    };
    if (typeof pkg.packageManager === "string") m.pm = pkg.packageManager;
    if (typeof pkg.engines?.node === "string") m.enginesNode = pkg.engines.node;
  } catch {
    // no/unreadable package.json — TC1 inert
  }
  try {
    m.nvmrc = readFileSync(nvmP, "utf8");
  } catch {
    // no .nvmrc — TC2 falls back to engines
  }
  cache.set(root, { key, m });
  return m;
}

/** the command manages versions itself — the shell switches PATH before the binary resolves */
const VERSION_MANAGER_RE =
  /\b(?:nvm|volta|mise|asdf|fnm)\s+(?:use|exec|local|global)\b|\bdirenv\b/;

/** exact x.y.z pins only; ranges and major-only pins stay advisory */
function pinnedNode(m: RepoManifest): string | undefined {
  const nvm = (m.nvmrc ?? "").trim();
  if (/^\d+\.\d+\.\d+$/.test(nvm)) return nvm;
  const eng = (m.enginesNode ?? "").trim().replace(/^=/, "");
  if (/^\d+\.\d+\.\d+$/.test(eng)) return eng;
  return undefined;
}

const NPM_FAMILY = /^(?:npm|npx|yarn|yarnpkg)$/;
const NODE_FAMILY = /^(?:node|npm|npx|pnpm|yarn|bun|tsx|ts-node)$/;

/** head binary of a normalized segment, sudo/env tolerant; explicit paths (contain "/") return "" */
function headBinary(seg: string): string {
  let rest = seg;
  if (rest.startsWith("sudo ")) rest = rest.slice(5);
  const head = rest.match(/^\S+/)?.[0] ?? "";
  return head.includes("/") ? "" : head;
}

export function toolchainCheck(
  seg: string,
  cmd: string,
  cwd?: string,
  enabled: { pnpm?: boolean; node?: boolean } = {},
): string | undefined {
  const pnpmOn = enabled.pnpm ?? true;
  const nodeOn = enabled.node ?? true;
  if (!pnpmOn && !nodeOn) return undefined;
  const head = headBinary(seg);
  if (!head) return undefined; // explicit binary path = deliberate pin
  if (VERSION_MANAGER_RE.test(cmd)) return undefined;
  const m = readManifest(cwd);
  if (pnpmOn && (m.pm?.startsWith("pnpm") || m.pnpmLock) && NPM_FAMILY.test(head)) {
    if (!(head === "npx" && /^npx\s+pnpm\b/.test(seg)))
      return `Toolchain (pnpm): '${head}' in a pnpm repo — use 'pnpm run <script>', 'pnpm exec <bin>' or 'pnpm dlx <pkg>'. npm/npx/yarn against a pnpm tree caused 7 failed runs (lockfile/engine drift).`;
  }
  const pin = pinnedNode(m);
  if (nodeOn && pin && process.version !== `v${pin}` && NODE_FAMILY.test(head))
    return `Toolchain (Node): repo pins Node ${pin}, current interpreter is ${process.version.slice(1)} — prefix with 'nvm use ${pin} &&' or call the pinned binary by full path; the mismatch caused Unsupported-engine and module-not-found runs.`;
  return undefined;
}
