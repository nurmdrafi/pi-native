// Vendors the agent skill from github.com/pbakaus/impeccable into skills/impeccable/.
// Upstream layout stays byte-faithful (SKILL.md + reference/ + scripts/); the only
// local diff is the injected disable-model-invocation flag (manual-only harness rule).
// Re-run to update from source: node scripts/sync-impeccable.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM = "pbakaus/impeccable";
const BRANCH = "main";
const SRC_PREFIX = ".agent/skills/impeccable/";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "skills", "impeccable");

export function selectSkillPaths(paths) {
  return paths
    .filter((p) => p.startsWith(SRC_PREFIX) && p !== SRC_PREFIX)
    .map((p) => p.slice(SRC_PREFIX.length))
    .sort();
}

// Upstream fences invoke the CLI via its Claude-Code layout path; the harness
// convention is bare script names (doc-check + skill-relative resolution both
// expect them). Deterministic on every sync.
export function localizeCommandPaths(text) {
  return text.replaceAll(".agent/skills/impeccable/scripts/impeccable", "impeccable");
}

export function injectManualFlag(text) {
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  const end = lines.indexOf("---", 1);
  if (end === -1) return text;
  const fm = lines.slice(0, end + 1);
  if (fm.some((l) => /^disable-model-invocation:/.test(l))) return text;
  const versionIdx = fm.findIndex((l) => /^version:/.test(l));
  const insertAt = versionIdx === -1 ? end : versionIdx + 1;
  fm.splice(insertAt, 0, "disable-model-invocation: true");
  return [...fm, ...lines.slice(end + 1)].join("\n");
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function main() {
  const tree = await fetchText(
    `https://api.github.com/repos/${UPSTREAM}/git/trees/${BRANCH}?recursive=1`
  );
  const paths = JSON.parse(tree).tree
    .filter((e) => e.type === "blob")
    .map((e) => e.path);
  const rels = selectSkillPaths(paths);
  if (!rels.includes("SKILL.md")) throw new Error("upstream skill not found");

  fs.rmSync(target, { recursive: true, force: true });
  for (const rel of rels) {
    const dest = path.join(target, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const raw = await fetchText(
      `https://raw.githubusercontent.com/${UPSTREAM}/${BRANCH}/${SRC_PREFIX}${rel}`
    );
    let content = rel === "SKILL.md" ? injectManualFlag(raw) : raw;
    if (rel === "SKILL.md" || rel.startsWith("reference/"))
      content = localizeCommandPaths(content);
    fs.writeFileSync(dest, content);
  }
  console.log(`synced ${rels.length} files -> skills/impeccable/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
