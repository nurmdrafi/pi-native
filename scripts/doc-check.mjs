#!/usr/bin/env node
// doc-check — repo doc-consistency validator, four families:
//   md-commands         mdcmdcheck v2 core carried over verbatim: validates shell
//                       commands in markdown fenced blocks (syntax, binary exists,
//                       script paths, flags in help; mac-only/optional-toolchain/
//                       artifact//tmp classes info-only).
//   skills-inventory    README skills table rows ↔ skills/*/SKILL.md dirs.
//   extensions-inventory README Extensions section ↔ extensions/* dirs with .ts.
//   env-vars            PI_* vars in code ↔ README.md + extensions READMEs.
// Everything is derived from the repo — no expected counts or inventories live
// here. Adding a skill = one README table row; adding an env var = document it
// or allowlist it below. This script never changes for either.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, accessSync, constants } from 'node:fs';
import { join, dirname, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// repo root = 1 level up from scripts/doc-check.mjs — portable, no absolute paths
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// env-vars family: internal-only plumbing, classified (never required in docs).
// Audit is part of adding any new PI_* var: document user-facing knobs in
// README.md / extensions READMEs; allowlist only parent↔child or machine-local
// plumbing, with a one-line reason per entry.
const ENV_VAR_ALLOWLIST = new Map([
  ['PI_SUBAGENT_ID', 'internal — subagent identity, set by parent orchestrator, read by subagent-done.ts'],
  ['PI_SUBAGENT_NAME', 'internal — subagent display name, parent → child'],
  ['PI_SUBAGENT_AGENT', 'internal — agent profile for resume, parent → child'],
  ['PI_SUBAGENT_ALLOWED', 'internal — spawn recursion budget, parent → child'],
  ['PI_SUBAGENT_AUTO_EXIT', 'internal — auto-exit flag, parent → child'],
  ['PI_SUBAGENT_SESSION', 'internal — session lineage, parent → child'],
  ['PI_SUBAGENT_ACTIVITY_FILE', 'internal — activity recorder path, parent → child'],
  ['PI_SUBAGENT_SURFACE', 'internal — surface id, parent → child'],
  ['PI_CLAUDE_SENTINEL', 'internal — sentinel path passed to plugin/hooks/on-stop.sh'],
  ['PI_DENY_TOOLS', 'internal — set by pi core for sandboxed spawns; read-only here'],
  ['PI_SESSIONS_DIR', 'skill-local — session-audit override, not part of the harness contract'],
  // Read by the Rust crates (custom-tools/*/src), which this scan does not cover:
  // its inputs are extensions/**/*.ts, scripts/*.mjs, skills/*/scripts/**.
  ['PI_READ_COMPRESS', 'native — custom-tools/piread/src/compress.rs, piread head-tail compaction switch'],
  ['PI_READ_LINE_CAP', 'native — custom-tools/piread/src/pipeline.rs (forwarded by extensions/piread)'],
  ['PI_BASH_SHELL', 'native — custom-tools/pibash/src/runner.rs, shell override for the native bash tool'],
]);

// walk root for .md files, skipping non-doc trees (node_modules, .git, external clones)
function walkMds(root) {
  const mds = [];
  (function walk(d) {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === '.git' || (d === root && e === 'git')) continue; // git/ = external clones, not our docs
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md')) mds.push(p);
    }
  })(root);
  return mds;
}
// recursive file list under dir (all regular files)
function walkFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  (function walk(d) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  })(dir);
  return out;
}
// markdown table row → trimmed cells (null when not a table row)
const tableCells = (line) => {
  if (!line.trim().startsWith('|')) return null;
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
};

// ---------- family 1: md-commands (mdcmdcheck v2, carried over) ----------
export function checkMdCommands(root) {
  const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'console', 'zsh']);
  const BUILTINS = new Set(['echo','cd','printf','export','set','unset','source','alias','local','return','exit','read','test','[','eval','true','false','pwd','shift','command','type','wait','trap','umask','pushd','popd','dirs','hash','let','declare','readonly','getopts','shopt','ulimit','jobs','fg','bg','kill','times','break','continue','then','else','fi','do','done','if','while','for','until','case','esac','function','in','select','time','coproc','exec']);
  const INTERPRETERS = new Set(['node','npm','npx','python','python3','bash','sh','env','deno','bun']); // flags belong to scripts/subcommands we can't introspect
  const MAC_ONLY = new Set(['pbcopy','pbpaste','osascript','launchctl','security','codesign','mdfind','open','defaults','brew','say','caffeinate','networksetup','screencapture','textutil','pluid','xcodebuild','swift','sw_vers','softwareupdate','pmset','system_profiler','diskutil','hdiutil','installer','port']);
  const SOURCED = new Set(['nvm']); // shell functions from init scripts — never visible to command -v
  // Toolchains/clients this harness documents but does not require on every machine
  // (e.g. the optional Rust toolchain). Absent binaries are info-only, like
  // MAC_ONLY.
  const OPTIONAL_TOOLCHAINS = new Set(['cargo', 'rustc', 'rustup', 'rustfmt', 'perf', 'valgrind', 'hyperfine', 'llvm-profdata', 'llvm-bolt', 'inferno-collapse-perf', 'inferno-flamegraph', 'loom']);
  // Docs that legitimately example foreign build artifacts (e.g. `./target/release/app`) —
  // reference/ docs are on-demand material, not harness runbooks.
  const isReferenceDoc = (md) => /\/references\//.test(md.slice(root.length + 1));

  // bare script name → resolve against skills/*/scripts/ (sibling-skill references)
  const harnessScript = (tok) => existsSync(join(root, 'skills')) && readdirSync(join(root, 'skills')).some((s) => existsSync(join(root, 'skills', s, 'scripts', tok)));

  const mds = walkMds(root);
  // In-process `command -v`: walk $PATH (plus the exec bit) instead of forking
  // `bash -c` once per token. That fork dominated the 34 s runtime
  // (docs/backlog.md item 2, fix 3) and cached results keep it flat.
  const binCache = new Map();
  const hasBin = (tok) => {
    if (binCache.has(tok)) return binCache.get(tok);
    let ok = false;
    if (tok.includes('/')) ok = existsSync(tok);
    else {
      for (const dir of (process.env.PATH || '').split(delimiter)) {
        if (!dir) continue;
        try { if (statSync(join(dir, tok)).isFile()) { accessSync(join(dir, tok), constants.X_OK); ok = true; break; } }
        catch { /* not here, or not executable */ }
      }
    }
    binCache.set(tok, ok);
    return ok;
  };
  const syntaxFail = [], binFail = [], macOnlyRefs = [], scriptMissing = [], flagFail = [], onDemandRefs = [], optionalToolchainRefs = [], artifactRefs = [], unresolvedProbes = [];
  const helpCache = new Map();
  const helpFlags = (key) => {
    if (helpCache.has(key)) return helpCache.get(key);
    const [bin, sub] = key.split(' ');
    const args = sub ? [sub, '--help'] : ['--help'];
    const probe = (timeout) => {
      try {
        const o = execFileSync(bin, args, { encoding: 'utf8', timeout }) + '';
        return o.trim() ? o : null;
      } catch (e) {
        const o = (e.stdout || '') + '';
        return o.trim() ? o : null;
      }
    };
    // A probe that never produced output is NOT "this command has no flags".
    // Folding a timeout/ENOENT into an empty flag set made `npm run doc:check`
    // report `FLAG NOT IN HELP` for flags that are in --help (docs/backlog.md
    // item 2). Retry once with a larger budget, then return null (unresolved)
    // so the caller reports a probe failure, never a missing flag.
    let out = probe(15000);
    if (out === null) out = probe(45000);
    if (out === null) return null; // unresolved — never cached, never a missing flag
    out = out.replace(/.\x08/g, ''); // strip man-page overstrike (bold X\bX, 15K bytes on git subcommand help) so --flag extraction sees real flags
    const flags = new Set();
    for (const m of out.matchAll(/--?[a-zA-Z][a-zA-Z0-9-]*/g)) flags.add(m[0]);
    helpCache.set(key, flags);
    return flags;
  };

  // quote-aware split on |, ||, &&, ; — never inside ' or "
  const segSplit = (line) => {
    const segs = ['']; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { segs[segs.length-1] += c; if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; segs[segs.length-1] += c; continue; }
      if (c === '|' && line[i+1] === '|') { segs.push(''); i++; continue; }
      if (c === '&' && line[i+1] === '&') { segs.push(''); i++; continue; }
      if (c === '|' || c === ';') { segs.push(''); continue; }
      segs[segs.length-1] += c;
    }
    return segs;
  };
  // Leading VAR=value assignments: shell allows quoted values with spaces and $(…)
  // substitutions. Strip them with quote/paren depth counting so `RUSTFLAGS="-C
  // target-cpu=native" cargo …` and `PGO_DIR=/tmp/pgo-$(date +%s)` resolve to the real
  // head token. Returns null when a substitution is unterminated.
  const stripAssignments = (t) => {
    while (true) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(t);
      if (!m) return t;
      let i = m[0].length, q = null, depth = 0;
      for (; i < t.length; i++) {
        const c = t[i];
        if (q) { if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && depth > 0) depth--;
        else if (/\s/.test(c) && depth === 0) break;
      }
      if (depth > 0) return null;
      t = t.slice(i).replace(/^\s+/, '');
    }
  };
  const headTok = (seg) => {
    let t = seg.trim().replace(/^[$#>]\s+/, '');
    if (!t || t.startsWith('#')) return null;
    t = stripAssignments(t) ?? '';
    if (!t) return null;
    t = t.replace(/^(sudo|command|nohup)\s+/, '');
    const tok = t.split(/\s+/)[0];
    if (!tok) return null;
    // `}` closes a brace group (`cmd || { …; }`), `{` opens one, `(` starts a
    // subshell — all shell syntax, never a command name. `}` was missing from
    // this class, so `… ; }` reported a binary named "}".
    if (/^[-{(<>} "#`$%&*]/.test(tok) || /^[a-z_]+=\S*$/.test(tok)) return null;
    if (BUILTINS.has(tok)) return null;
    return tok.replace(/[;'"]+$/,'');
  };
  const subCmd = (seg, tok) => {
    let t = seg.trim().replace(/^[$#>]\s+/, '');
    t = stripAssignments(t) ?? '';
    const parts = t.split(/\s+/);
    if (parts[0] !== tok) return null;
    const s = parts[1] || '';
    return /^[a-z][a-z0-9-]*$/.test(s) && !s.startsWith('-') ? s : null;
  };

  const blockRe = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
  const binSeen = new Set(), flagByKey = new Map();
  for (const md of mds) {
    const text = readFileSync(md, 'utf8');
    let m;
    while ((m = blockRe.exec(text)) !== null) {
      const [, lang, body] = m;
      if (!SHELL_LANGS.has(lang)) continue;
      // <placeholder> tokens (e.g. `<skill-dir>`) are doc convention, not redirects — quote them for bash -n (documented waiver)
      const syntaxInput = body.replace(/<([a-zA-Z][^<>\n]*)>/g, '"<$1>"');
      try { execFileSync('bash', ['-n'], { input: syntaxInput, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch { syntaxFail.push(`${md.replace(root+'/','')} :: ${body.split('\n').find(l=>l.trim())?.slice(0,60)}`); }
      // join backslash continuations, drop comments
      const joined = body.split('\n').reduce((a, l) => {
        const clean = l.replace(/(^|\s)#.*$/, '$1').trimEnd();
        if (!clean.trim()) return a;
        if (clean.endsWith('\\')) { a.carried += clean.slice(0,-1) + ' '; return a; }
        a.lines.push(a.carried + clean); a.carried = ''; return a;
      }, { lines: [], carried: '' });
      if (joined.carried) joined.lines.push(joined.carried);
      for (const line of joined.lines) {
        for (const seg of segSplit(line)) {
          const tok = headTok(seg);
          if (!tok) continue;
          const rel = `${md.replace(root+'/','')}: ${tok}`;
          if (/^(\.\/|\.\.\/|scripts\/|bin\/)/.test(tok) || tok.endsWith('.sh')) {
            // candidates: md's dir, repo root, and skill root (nearest dir with SKILL.md —
            // references/ docs legitimately point at skill-root scripts/)
            let skillRoot = dirname(md); let c2 = skillRoot;
            while (c2 !== root && !existsSync(join(c2, 'SKILL.md'))) { c2 = dirname(c2); }
            if (existsSync(join(c2, 'SKILL.md'))) skillRoot = c2;
            const cands = [resolve(dirname(md), tok), resolve(root, tok), resolve(skillRoot, tok)];
            if (!cands.some(c => existsSync(c)) && !harnessScript(tok)) {
              if (/\/target\//.test(tok) || (isReferenceDoc(md) && tok.startsWith('./'))) artifactRefs.push(`${rel}  <<< ${line.slice(0,70)}`);
              else scriptMissing.push(`${rel}  <<< ${line.slice(0,70)}`);
            }
            continue;
          }
          if (tok.startsWith('~/')) {
            // home-relative harness shim (e.g. ~/.pi/agent/bin/pidoc) — expand before probe
            if (existsSync(join(homedir(), tok.slice(2)))) binSeen.add(tok);
            else binFail.push(`${rel}  <<< ${line.slice(0,70)}`);
            continue;
          }
          if (SOURCED.has(tok)) { binSeen.add(tok); continue; }
          if (/^\/tmp\//.test(tok)) { onDemandRefs.push(`${rel}  <<< ${line.slice(0,70)}`); continue; } // downloaded on demand — absence is not a doc bug
          if (MAC_ONLY.has(tok)) { macOnlyRefs.push(`${rel}  <<< ${line.slice(0,70)}`); continue; }
          if (OPTIONAL_TOOLCHAINS.has(tok)) { optionalToolchainRefs.push(`${rel}  <<< ${line.slice(0,70)}`); continue; }
          if (!hasBin(tok)) { binFail.push(`${rel}  <<< ${line.slice(0,70)}`); continue; }
          binSeen.add(tok);
          if (INTERPRETERS.has(tok)) continue;
          const sub = subCmd(seg, tok);
          const key = sub ? `${tok} ${sub}` : tok;
          const flags = (seg.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) || []);
          if (!flags.length) continue;
          if (!flagByKey.has(key)) flagByKey.set(key, new Set());
          flags.forEach(f => flagByKey.get(key).add(f));
        }
      }
    }
  }
  const KNOWN = /^(rg|grep|egrep|fgrep|find|xargs|jq|sed|cut|sort|uniq|wc|head|tail|ast-grep|git|npm|npx|node|tvly|pi|fd|awk|tr|chmod|ls|cat|curl|sh|bash|command|skillcheck\.sh)\s/;
  const inlineRe = /`([^`\n]+)`/g;
  // Inline prose uses `|` as an alternation more often than a pipeline (`git commit|push|…`);
  // split on `|` only when spaced, so a prose list is not read as bare commands.
  const inlineSegSplit = (line) => {
    const segs = ['']; let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { segs[segs.length-1] += c; if (c === q) q = null; continue; }
      if (c === "'" || c === '"') { q = c; segs[segs.length-1] += c; continue; }
      if (c === ';' || (c === '&' && line[i+1] === '&') || (c === '|' && line[i+1] === '|')) { segs.push(''); if (c !== ';') i++; continue; }
      if (c === '|' && /\s/.test(line[i-1] || '') && /\s/.test(line[i+1] || '')) { segs.push(''); continue; }
      segs[segs.length-1] += c;
    }
    return segs;
  };
  // Curated false positives: reviewed commands whose flags `--help` omits (curl prints the
  // full option list only under `--help all`; a prose table names `git reset --hard`).
  const FLAG_WAIVERS = new Set(['git --hard', 'git reset --hard', 'curl --proto', 'curl --tlsv1']);
  for (const md of mds) {
    const relMd = md.slice(root.length + 1);
    // history, not declarations: CHANGELOG, HANDOFF files, generated handoff/ docs — quoting past
    // commands in prose is their job; binaries may not exist on this machine. audit-reports are
    // dated machine-local records of past runs, same rationale.
    if (relMd === 'CHANGELOG.md' || /^HANDOFF-[^/]*\.md$/.test(relMd) || relMd.startsWith('handoff/') || relMd.startsWith('audit-reports/')) continue;
    const text = readFileSync(md, 'utf8');
    let im;
    while ((im = inlineRe.exec(text)) !== null) {
      let line = im[1].trim();
      if (!KNOWN.test(line + ' ')) continue;
      if (line.includes('…') || line.includes('...')) line = line.split(/…|\.\.\./)[0];
      for (const seg of inlineSegSplit(line)) {
        const tok = headTok(seg);
        if (!tok) continue;
        if (SOURCED.has(tok)) { binSeen.add(tok); continue; }
        if (OPTIONAL_TOOLCHAINS.has(tok)) { optionalToolchainRefs.push(`${md.replace(root+'/','')}: INLINE: ${tok}  <<< ${line.slice(0,70)}`); continue; }
        if (!hasBin(tok)) {
          if (harnessScript(tok)) { binSeen.add(tok); continue; }
          binFail.push(`${md.replace(root+'/','')}: INLINE: ${tok}  <<< ${line.slice(0,70)}`); continue;
        }
        binSeen.add(tok);
        if (INTERPRETERS.has(tok) || MAC_ONLY.has(tok)) continue;
        const sub = subCmd(seg, tok);
        const key = sub ? `${tok} ${sub}` : tok;
        const flags = (seg.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) || []);
        if (!flags.length) continue;
        if (!flagByKey.has(key)) flagByKey.set(key, new Set());
        flags.forEach(f => flagByKey.get(key).add(f));
      }
    }
  }
  for (const [key, flags] of flagByKey) {
    const help = helpFlags(key);
    if (help === null) { unresolvedProbes.push(key); continue; } // never assert a flag against a probe that never ran
    for (const f of flags) {
      if (f === '--help') continue; // universal flag; git man pages don't list it — documenting help commands is legit prose
      if (FLAG_WAIVERS.has(`${key} ${f}`)) continue;
      if (!help.has(f)) flagFail.push(`${key} ${f}`);
    }
  }

  const findings = [
    ...syntaxFail.map((x) => `SYNTAX FAIL: ${x}`),
    ...binFail.map((x) => `BINARY NOT FOUND: ${x}`),
    ...scriptMissing.map((x) => `RELATIVE SCRIPT MISSING: ${x}`),
    ...flagFail.map((x) => `FLAG NOT IN HELP: ${x}`),
    ...unresolvedProbes.map((x) => `HELP PROBE UNRESOLVED: ${x} (retry; its flags were not verified)`),
  ];
  return {
    name: 'md-commands',
    label: 'MD-COMMANDS',
    status: findings.length ? 'FAIL' : 'PASS',
    findings,
    stats: { mdScanned: mds.length, binariesOk: [...binSeen].sort() },
    // info-only classes — printed for review, never exit-relevant
    info: [
      ['OPTIONAL TOOLCHAIN REFS', optionalToolchainRefs],
      ['BUILD/EXAMPLE ARTIFACT REFS', artifactRefs],
      ['MAC-ONLY REFS', macOnlyRefs],
      ['ON-DEMAND /tmp REFS', onDemandRefs],
    ].filter(([, a]) => a.length),
  };
}

// ---------- family 2: skills-inventory ----------
// README skills table (header `| Skill | … | Invocation |`) ↔ skills/*/SKILL.md dirs.
export function checkSkillsInventory(root) {
  const findings = [];
  const skillsDir = join(root, 'skills');
  const derived = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter((e) => statSync(join(skillsDir, e)).isDirectory() && existsSync(join(skillsDir, e, 'SKILL.md')))
    : [];
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    return { name: 'skills-inventory', label: 'SKILLS INVENTORY', status: 'FAIL', findings: ['README.md not found — skills table cannot be verified'] };
  }
  const lines = readFileSync(readmePath, 'utf8').split('\n');
  // locate the skills table: header row whose first cell is "Skill" and last is "Invocation"
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = tableCells(lines[i]);
    if (cells && /^Skill$/i.test(cells[0]) && /^Invocation$/i.test(cells[cells.length - 1])) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return { name: 'skills-inventory', label: 'SKILLS INVENTORY', status: 'FAIL', findings: ['skills table not found in README.md — expected a header row like `| Skill | … | Invocation |`'] };
  }
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    if (/^[-: |]+$/.test(lines[i].trim())) continue; // separator row
    const cells = tableCells(lines[i]);
    if (cells && cells.length >= 2) rows.push({ name: cells[0].replace(/`/g, ''), invocation: cells[cells.length - 1].replace(/`/g, ''), line: i + 1 });
  }
  const byName = new Map();
  for (const r of rows) {
    if (byName.has(r.name)) findings.push(`README.md:${r.line}: duplicate skills table row '${r.name}' (first at line ${byName.get(r.name).line})`);
    else byName.set(r.name, r);
  }
  for (const dir of derived) {
    if (!byName.has(dir)) findings.push(`skills/${dir}/ has SKILL.md but README.md skills table has no row for '${dir}'`);
  }
  for (const [name, r] of byName) {
    if (!derived.includes(name)) findings.push(`README.md:${r.line}: skills table row '${name}' has no skills/${name}/SKILL.md`);
    else if (r.invocation !== `/skill:${name}`) findings.push(`README.md:${r.line}: row '${name}' invocation '${r.invocation}' ≠ '/skill:${name}'`);
  }
  return { name: 'skills-inventory', label: 'SKILLS INVENTORY', status: findings.length ? 'FAIL' : 'PASS', findings };
}

// ---------- family 3: extensions-inventory ----------
// README Extensions section ↔ extensions/* dirs containing at least one .ts file.
// Top-level files (e.g. extensions/handoff.ts) are not extension units — dir rule only.
export function checkExtensionsInventory(root) {
  const findings = [];
  const extDir = join(root, 'extensions');
  const derived = existsSync(extDir)
    ? readdirSync(extDir).filter((e) => statSync(join(extDir, e)).isDirectory() && walkFiles(join(extDir, e)).some((f) => f.endsWith('.ts')))
    : [];
  const readmePath = join(root, 'README.md');
  if (!existsSync(readmePath)) {
    return { name: 'extensions-inventory', label: 'EXTENSIONS INVENTORY', status: 'FAIL', findings: ['README.md not found — Extensions section cannot be verified'] };
  }
  const lines = readFileSync(readmePath, 'utf8').split('\n');
  // extract the `## Extensions` section (to the next same-level heading)
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Extensions\s*$/.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) {
    return { name: 'extensions-inventory', label: 'EXTENSIONS INVENTORY', status: 'FAIL', findings: ['`## Extensions` section not found in README.md — extension inventory cannot be verified'] };
  }
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  // claims = backticked `name/` tokens (single segment + trailing slash) in the section.
  // `extensions/` itself names the section subject, not a unit; `handoff.ts` (no slash) is a file.
  const claimed = new Map();
  for (let i = start; i < end; i++) {
    for (const m of lines[i].matchAll(/`([a-z0-9][a-z0-9-]*)\/`/g)) {
      if (m[1] === 'extensions') continue;
      if (!claimed.has(m[1])) claimed.set(m[1], i + 1);
    }
  }
  for (const dir of derived) {
    if (!claimed.has(dir)) findings.push(`extensions/${dir}/ contains TypeScript but the README Extensions section never mentions \`${dir}/\``);
  }
  for (const [name, line] of claimed) {
    if (!derived.includes(name)) findings.push(`README.md:${line}: Extensions section mentions \`${name}/\` but extensions/${name}/ has no .ts files`);
  }
  return { name: 'extensions-inventory', label: 'EXTENSIONS INVENTORY', status: findings.length ? 'FAIL' : 'PASS', findings };
}

// ---------- family 4: env-vars ----------
// PI_* vars used in code must be documented (README.md + extensions READMEs) or
// allowlisted; every PI_* var named in those docs must exist in the scanned code.
// Lookbehind avoids matching the PI_ tail of names like ZAI_API_KEY.
const ENV_VAR_RE = /(?<![A-Z0-9_])PI_[A-Z0-9_]+/g;
export function checkEnvVars(root) {
  const findings = [];
  // code side: extensions/**/*.ts, scripts/*.mjs, skills/*/scripts/**
  const codeFiles = [];
  for (const f of walkFiles(join(root, 'extensions'))) if (f.endsWith('.ts')) codeFiles.push(f);
  if (existsSync(join(root, 'scripts'))) {
    for (const e of readdirSync(join(root, 'scripts'))) if (e.endsWith('.mjs')) codeFiles.push(join(root, 'scripts', e));
  }
  if (existsSync(join(root, 'skills'))) {
    for (const e of readdirSync(join(root, 'skills'))) codeFiles.push(...walkFiles(join(root, 'skills', e, 'scripts')));
  }
  const inCode = new Map(); // var → first relpath
  for (const f of codeFiles) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(ENV_VAR_RE)) {
      if (!inCode.has(m[0])) inCode.set(m[0], f.slice(root.length + 1));
    }
  }
  // doc side: README.md + extensions/README.md + extensions/*/README.md
  const docFiles = [join(root, 'README.md'), join(root, 'extensions', 'README.md')];
  if (existsSync(join(root, 'extensions'))) {
    for (const e of readdirSync(join(root, 'extensions'))) {
      const p = join(root, 'extensions', e, 'README.md');
      if (existsSync(p)) docFiles.push(p);
    }
  }
  const inDocs = new Map(); // var → first relpath
  for (const f of docFiles) {
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(ENV_VAR_RE)) {
      if (!inDocs.has(m[0])) inDocs.set(m[0], f.slice(root.length + 1));
    }
  }
  const docSet = 'README.md / extensions READMEs';
  for (const [v, loc] of inCode) {
    if (inDocs.has(v)) continue;
    if (ENV_VAR_ALLOWLIST.has(v)) continue;
    findings.push(`${v} used in ${loc} but not documented in ${docSet} (and not allowlisted — document it or classify it in ENV_VAR_ALLOWLIST)`);
  }
  for (const [v, loc] of inDocs) {
    if (inCode.has(v)) continue;
    findings.push(`${v} documented in ${loc} but not found in scanned code (extensions/**/*.ts, scripts/*.mjs, skills/*/scripts/**)`);
  }
  return { name: 'env-vars', label: 'ENV-VARS', status: findings.length ? 'FAIL' : 'PASS', findings };
}

// ---------- aggregation ----------
export function runDocCheck(root) {
  const families = [checkMdCommands(root), checkSkillsInventory(root), checkExtensionsInventory(root), checkEnvVars(root)];
  return { families, failed: families.some((f) => f.status === 'FAIL') };
}

export function renderHuman({ families, failed }) {
  const out = [];
  for (const f of families) {
    out.push(`${f.label} (${f.status})`);
    if (f.stats) out.push(`  md files scanned: ${f.stats.mdScanned}`, `  binaries OK: ${f.stats.binariesOk.join(' ') || '(none)'}`);
    if (f.info) {
      for (const [label, items] of f.info) {
        out.push(`  ${label} (info, ${items.length}):`);
        items.forEach((x) => out.push(`    ${x}`));
      }
    }
    f.findings.forEach((x) => out.push(`  ${x}`));
    out.push('');
  }
  const failedCount = families.filter((f) => f.status === 'FAIL').length;
  const total = families.reduce((a, f) => a + f.findings.length, 0);
  out.push(failed ? `summary: ${failedCount}/${families.length} families failed, ${total} finding(s)` : `summary: all ${families.length} families passed`);
  return out.join('\n');
}

export function toJson({ families }) {
  return { families: families.map(({ name, status, findings }) => ({ name, status, findings })) };
}

function main() {
  const json = process.argv.includes('--json');
  const result = runDocCheck(ROOT);
  if (json) {
    console.log(JSON.stringify(toJson(result), null, 2));
  } else {
    console.log(renderHuman(result));
  }
  process.exit(result.failed ? 1 : 0);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main();
