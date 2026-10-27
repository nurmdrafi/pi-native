#!/usr/bin/env node
/** pidoc — deterministic harness setup check (macOS + Linux; degrades, never crashes, elsewhere).
 *
 * Usage: node scripts/pidoc.mjs [--fix] [--json]
 * Exit 0 = all pass (warnings allowed); exit 1 = any FAIL.
 * Safe fixes (pidx rebuild) apply with --fix; installs never run here —
 * the skill body carries the ask-first install commands.
 */
import { existsSync, accessSync, constants, statSync, readdirSync, cpSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// repo root = scripts/ dir up three levels — clone-location-agnostic
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const AGENT = join(SCRIPTS, '..', '..', '..');
const FIX = process.argv.includes('--fix');
const JSON_OUT = process.argv.includes('--json');

const rows = [];
const row = (status, check, detail, fixHint) => rows.push({ status, check, detail, fixHint: fixHint ?? null });
const executable = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };
// POSIX shell: /bin/sh on macOS+Linux, but never on Windows — fall back to PATH order
// there so the health check stays runnable on any host.
const SHELL = process.platform !== 'win32' && existsSync('/bin/sh') ? '/bin/sh' : null;
const which = (bin) => {
  if (!SHELL) {
    const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
    for (const dir of (process.env.PATH || '').split(delimiter)) {
      for (const ext of exts) if (dir && executable(join(dir, bin + (process.platform === 'win32' ? ext.toLowerCase() : '')))) return join(dir, bin);
    }
    return null;
  }
  const r = spawnSync(SHELL, ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

// 1. node pin vs .nvmrc (major-only pin matches any minor/patch)
try {
  const pin = readFirst(join(AGENT, '.nvmrc'));
  const have = process.versions.node;
  const ok = pin.includes('.') ? pin.replace(/^v/, '') === have : pin.replace(/^v/, '') === have.split('.')[0];
  row(ok ? 'PASS' : 'WARN', 'node-pin', `.nvmrc=${pin} running=v${have}${ok ? '' : ` — prefix pinned binaries with 'nvm use ${pin} &&' when mismatched`}`);
} catch { row('WARN', 'node-pin', '.nvmrc unreadable'); }

// 2. rust toolchain (pidx build dep; runtime binary works without it)
const cargo = which('cargo') ?? (existsSync(join(homedir(), '.cargo', 'bin', 'cargo')) ? join(homedir(), '.cargo', 'bin', 'cargo') : null);
row(cargo ? 'PASS' : 'WARN', 'cargo', cargo ?? 'not found — pidx cannot rebuild; session-audit falls back to Node parser');

// 3. pidx binary + freshness vs crate sources
const pidxBin = join(AGENT, 'bin', 'pidx');
const crateDir = join(AGENT, 'rust-tools', 'pidx');
const workspaceDir = join(AGENT, 'rust-tools');
if (!existsSync(pidxBin)) {
  row('FAIL', 'pidx', `missing ${pidxBin}${cargo ? ' — fixable with --fix' : ' — needs cargo (see cargo row)'}`);
  if (FIX && cargo) rebuildPidx(row);
} else if (!executable(pidxBin)) {
  row('FAIL', 'pidx', 'not executable — chmod +x bin/pidx');
} else if (!existsSync(join(crateDir, 'Cargo.toml'))) {
  row('WARN', 'pidx', 'crate missing — binary works, cannot rebuild');
} else {
  const srcNewest = Math.max(
    ...readdirSync(join(crateDir, 'src')).map((f) => statSync(join(crateDir, 'src', f)).mtimeMs),
    statSync(join(crateDir, 'Cargo.toml')).mtimeMs,
  );
  const binMs = statSync(pidxBin).mtimeMs;
  if (binMs < srcNewest) {
    row('WARN', 'pidx', `stale binary (older than crate sources)${cargo ? ' — fixable with --fix' : ''}`);
    if (FIX && cargo) rebuildPidx(row);
  } else {
    const v = spawnSync(pidxBin, ['--help'], { encoding: 'utf8' });
    row(v.status === 0 ? 'PASS' : 'FAIL', 'pidx', 'fresh, runs');
  }
}

// 4. helper CLIs
for (const [bin, why] of [['rg', 'search'], ['gh', 'issues'], ['jq', 'payload piping']]) {
  const p = which(bin);
  row(p ? 'PASS' : 'WARN', bin, p ?? `not on PATH (${why}) — install via package manager, ask user first`);
}
const fd = which('fd') ?? join(AGENT, 'bin', 'fd');
row(existsSync(fd) ? 'PASS' : 'WARN', 'fd', existsSync(fd) ? fd : 'not found (find alternative)');

// 4b. rg must be the agent build with PCRE2 (rg -P; SS2 rg-first default)
const rgBin = which('rg');
if (!rgBin) {
  row('WARN', 'rg-pcre2', 'rg not on PATH — see rg row above');
} else {
  const pcre = spawnSync(rgBin, ['-P', 'a(?=b)'], { input: 'ab\n', encoding: 'utf8' });
  const pinned = rgBin === join(AGENT, 'bin', 'rg');
  row(pinned && pcre.status === 0 ? 'PASS' : 'WARN', 'rg-pcre2',
    pinned && pcre.status === 0 ? `${rgBin} — PCRE2 ok`
      : `${rgBin} ${pinned ? 'lacks PCRE2' : 'is not the agent build'} — rebuild: cargo install ripgrep --features pcre2 --root ~/.pi/agent`);
}

// 4c. piread native read tool (AGENTS.md tooling default; read is fallback)
const pireadBin = join(AGENT, 'bin', 'piread');
if (!existsSync(pireadBin)) {
  row('WARN', 'piread', 'missing — read stays built-in (build via scripts/bootstrap.sh)');
} else {
  const pr = spawnSync(pireadBin, ['--path', join(AGENT, 'AGENTS.md'), '--limit', '1'], { encoding: 'utf8' });
  row(pr.status === 0 && pr.stdout.includes('"ok":true') ? 'PASS' : 'FAIL', 'piread',
    pr.status === 0 ? `${pireadBin} — ok:true` : `exit ${pr.status} — rebuild via scripts/bootstrap.sh`);
}

// 4d. terminal PATH pin: any shell rc prepending agent bin so fresh shells match
// (zsh: ~/.zshenv, bash: ~/.bashrc — macOS and Linux alike)
let pinFile = null;
for (const rc of ['.zshenv', '.zshrc', '.bashrc', '.profile']) {
  try {
    if (existsSync(join(homedir(), rc)) && readFileSyncText(join(homedir(), rc)).includes('.pi/agent/bin')) {
      pinFile = rc;
      break;
    }
  } catch {}
}
row(pinFile ? 'PASS' : 'WARN', 'shell-path',
  pinFile ? `~/${pinFile} prepends agent bin — fresh terminals resolve pinned tools`
    : 'add to your shell rc (zsh: ~/.zshenv, bash: ~/.bashrc): export PATH="$HOME/.pi/agent/bin:$PATH"');

// 5. gate + settings + extensions
row(existsSync(join(AGENT, 'extensions', 'permission-gate', 'index.ts')) ? 'PASS' : 'FAIL', 'gate', 'permission-gate present');
try {
  const s = JSON.parse(readFileSyncText(join(AGENT, 'settings.json')));
  const missing = (s.extensions ?? []).filter((e) => !e.startsWith('-')).filter((e) => !existsSync(join(AGENT, 'extensions', e)));
  row(missing.length ? 'FAIL' : 'PASS', 'settings', missing.length ? `extension dirs missing: ${missing.join(', ')}` : 'parses, extensions resolve');
} catch (e) { row('FAIL', 'settings', `unreadable: ${e.message}`); }

// 6. git hooks
row(existsSync(join(AGENT, '.husky')) && readdirSync(join(AGENT, '.husky')).some((f) => !f.startsWith('.')) ? 'PASS' : 'WARN', 'hooks', 'husky hooks present');

// 7. writable state dirs
for (const d of ['sessions', join('.cache', '')]) {
  const p = join(AGENT, d.replace(/\/$/, ''));
  if (!existsSync(p)) { row('WARN', `dir:${d}`, 'missing — created on first use'); continue; }
  try { accessSync(p, constants.W_OK); row('PASS', `dir:${d.replace(/\/$/, '')}`, 'writable'); }
  catch { row('FAIL', `dir:${d.replace(/\/$/, '')}`, 'not writable'); }
}

// 8. session-audit end-to-end probe (run --max 1 into a throwaway workdir —
// exercises discover+parse+rules+write, incl. the pidx fast path when present)
{
  const tmp = mkdtempSync(join(tmpdir(), 'pidoc-'));
  try {
    const r = spawnSync(process.execPath,
      [join(AGENT, 'skills', 'session-audit', 'scripts', 'audit.mjs'), 'run', '--max', '1'],
      { encoding: 'utf8', env: { ...process.env, AUDIT_WORKDIR: tmp } });
    row(r.status === 0 && r.stdout.includes('audit:') ? 'PASS' : 'FAIL', 'audit',
      r.status === 0 ? 'runner digests a session end-to-end' : `runner failed: ${(r.stderr || r.stdout || '').trim().slice(0, 120)}`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function rebuildPidx(row) {
  try {
    execFileSync(cargo, ['build', '--release', '-p', 'pidx'], { cwd: workspaceDir, stdio: 'pipe' });
    const built = join(workspaceDir, 'target', 'release', 'pidx');
    cpSync(built, pidxBin);
    const v = spawnSync(pidxBin, ['--help'], { encoding: 'utf8' });
    row(v.status === 0 ? 'PASS' : 'FAIL', 'pidx', v.status === 0 ? 'rebuilt + installed' : 'rebuilt but --help failed');
  } catch (e) {
    row('FAIL', 'pidx', `rebuild failed: ${String(e.message).slice(0, 120)}`);
  }
}

function readFirst(p) { return readFileSync(p, 'utf8').split('\n')[0].trim(); }
function readFileSyncText(p) { return readFileSync(p, 'utf8'); }

// ---- output
const order = { FAIL: 0, WARN: 1, PASS: 2 };
const last = new Map(rows.map((r) => [r.check, r])); // fix reruns keep final state only
const finalRows = [...last.values()];
finalRows.sort((a, b) => order[a.status] - order[b.status]);
if (JSON_OUT) { console.log(JSON.stringify(finalRows, null, 1)); }
else {
  for (const r of finalRows) console.log(`${r.status.padEnd(5)}  ${r.check.padEnd(10)}  ${r.detail}${r.fixHint ? `  [fix: ${r.fixHint}]` : ''}`);
  const n = (s) => finalRows.filter((r) => r.status === s).length;
  console.log(`\npidoc: ${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail${FIX ? ' (fix mode)' : ' (run with --fix to apply safe fixes)'}`);
}
process.exit(finalRows.some((r) => r.status === 'FAIL') ? 1 : 0);
