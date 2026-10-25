// Validates skill directories against the Agent Skills spec.
// Usage: node validate-skill.mjs <skill-dir> [<skill-dir> ...]
// Exit 0 = all pass, 1 = any failure.
import fs from "node:fs";
import path from "node:path";

function parseSkill(skillDir) {
  const file = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(file)) return { errors: ["missing SKILL.md"], name: null, desc: null, lines: 0 };

  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");

  // Find frontmatter boundaries
  let fmStart = -1, fmEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      if (fmStart === -1) fmStart = i + 1;
      else { fmEnd = i; break; }
    }
  }
  if (fmStart === -1 || fmEnd === -1)
    return { errors: ["no YAML frontmatter"], name: null, desc: null, lines: lines.length };

  // Parse frontmatter: extract top-level keys and their value blocks
  const fmLines = lines.slice(fmStart, fmEnd);
  const fields = {};
  let curKey = null;
  let curVal = [];
  for (const line of fmLines) {
    const topKey = line.match(/^([A-Za-z_-]+)\s*:\s*(.*)/);
    if (topKey && !line.startsWith(" ") && !line.startsWith("\t")) {
      // Save previous key
      if (curKey) fields[curKey] = curVal.join("\n");
      curKey = topKey[1];
      curVal = topKey[2] ? [topKey[2].trim()] : [];
    } else if (curKey) {
      curVal.push(line);
    }
  }
  if (curKey) fields[curKey] = curVal.join("\n");

  // Unfold YAML folded block (> or >-) into single string
  function unfold(raw) {
    const trimmed = raw.trim();
    // If it starts with > (folded) or | (literal), collapse
    if (/^>[-+]?\s*$/.test(trimmed)) {
      const content = raw.replace(/^>[-+]?\s*\n?/, "").trim();
      // Folded: newlines become spaces, blank lines become actual newlines
      return content.replace(/\n\s*\n/g, "\n").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    }
    if (/^\|[-+]?\s*$/.test(trimmed)) {
      return raw.replace(/^\|[-+]?\s*\n?/, "").trim();
    }
    return trimmed.replace(/\s+/g, " ").trim();
  }

  const name = fields.name ? unfold(fields.name) : null;
  const desc = fields.description ? unfold(fields.description) : null;

  const errors = [];

  // Name checks
  if (!name) errors.push("name missing");
  else {
    if (name.length > 64) errors.push(`name "${name}" is ${name.length} chars > 64`);
    if (!/^[a-z0-9-]+$/.test(name)) errors.push(`name "${name}" has invalid chars (only a-z 0-9 -)`);
    if (/^-|-$/.test(name)) errors.push(`name "${name}" starts/ends with hyphen`);
    if (name.includes("--")) errors.push(`name "${name}" has consecutive hyphens`);
    if (/<\/?[a-zA-Z][^>]*>/.test(name)) errors.push(`name "${name}" contains XML tags`);
    if (/anthropic|claude/i.test(name)) errors.push(`name "${name}" contains reserved word (anthropic/claude)`);
    const dirName = path.basename(skillDir);
    if (name !== dirName) errors.push(`name "${name}" != directory "${dirName}"`);
  }

  // Description checks
  if (!desc) errors.push("description missing (skill won't load)");
  else {
    if (desc.length > 1024) errors.push(`description is ${desc.length} chars > 1024`);
    if (/<\/?[a-zA-Z][^>]*>/.test(desc)) errors.push("description contains XML tags");
    const words = desc.split(/\s+/).length;
    if (words < 10) errors.push(`description too vague (${words} words) — specify what + when + keywords`);
  }

  // Body size
  const totalLines = lines.length;
  if (totalLines > 500) errors.push(`${totalLines} lines > 500-line guideline — split into references/`);

  // Directory layout (harness convention per agentskills.io)
  const ALLOWED = new Set(["SKILL.md", "scripts", "references", "assets",
    "package.json", "package-lock.json", "node_modules", ".gitignore",
    "reference"]); // "reference" (singular): vendored upstream skills only (e.g. impeccable)
  for (const e of fs.readdirSync(skillDir)) {
    if (!ALLOWED.has(e)) errors.push(`nonstandard top-level entry "${e}" — executables → scripts/, docs → references/, static data → assets/`);
  }

  return { errors, name, desc, lines: totalLines };
}

// Main
let failed = false;
const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: node validate-skill.mjs <skill-dir> [<skill-dir> ...]");
  process.exit(1);
}

for (const dir of dirs) {
  const r = parseSkill(dir);
  const label = path.basename(dir);
  if (r.errors.length) {
    console.log(`${label}: FAIL — ${r.errors.join("; ")}`);
    failed = true;
  } else {
    console.log(`${label}: PASS (desc ${r.desc.length} chars, ${r.lines} lines)`);
  }
}
process.exit(failed ? 1 : 0);
