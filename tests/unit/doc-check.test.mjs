// doc-check family tests — node:test, fixture trees under os.tmpdir().
// The JS implementation (scripts/doc-check.mjs) was replaced by the Rust
// `docheck` binary; these tests spawn that binary (default
// ~/.pi/agent/bin/docheck, override with DOCHECK_BIN) so they pin the shipped
// artifact end-to-end: CLI, JSON shape, human rendering, exit code.
// The drift gate for the real repo is `npm run doc:check` itself; these tests
// pin the checker's behavior on controlled fixtures (plus one real-repo smoke).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkTree, rmTree, makeReadme } from '../fixtures/doc-check/helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const BIN = process.env.DOCHECK_BIN ?? join(homedir(), '.pi', 'agent', 'bin', 'docheck');

// run the binary against a fixture root; `--json` output is parsed for you
function run(root, ...extra) {
  const r = spawnSync(BIN, [root, ...extra], { encoding: 'utf8', timeout: 120000 });
  assert.equal(r.error, undefined, `spawn ${BIN} failed — is the binary installed? (${r.error})`);
  return { human: r.stdout, status: r.status, json: extra.includes('--json') ? JSON.parse(r.stdout) : null };
}

function family(root, name) {
  const { json } = run(root, '--json');
  const f = json.families.find((x) => x.name === name);
  assert.ok(f, `family ${name} missing in ${JSON.stringify(json.families.map((x) => x.name))}`);
  return f;
}

// ---------- step 1: builder sanity ----------

test('mkTree builds the expected tree', () => {
  const dir = mkTree({
    skills: [{ name: 'alpha', scripts: [{ path: 'run.mjs', content: 'console.log(1)\n' }] }, 'beta'],
    extensions: [{ name: 'gatey', readme: '# gatey\n' }],
    extFiles: [{ path: 'handoff.ts', content: '// top-level file, not a unit\n' }],
    scripts: [{ name: 'helper.mjs', content: '// helper\n' }],
    readme: makeReadme({ skills: ['alpha', 'beta'], extensions: ['gatey'] }),
    extReadme: '# extensions\n',
  });
  try {
    for (const rel of [
      'skills/alpha/scripts/run.mjs',
      'skills/beta/SKILL.md',
      'extensions/gatey/index.ts',
      'extensions/gatey/README.md',
      'extensions/handoff.ts',
      'scripts/helper.mjs',
      'README.md',
      'extensions/README.md',
    ]) assert.ok(existsSync(join(dir, rel)), `missing ${rel}`);
  } finally {
    rmTree(dir);
  }
});

// ---------- step 2: skills-inventory ----------
test('skills-inventory: consistent fixture passes', () => {
  const dir = mkTree({ skills: ['alpha', 'beta'], readme: makeReadme({ skills: ['alpha', 'beta'] }) });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'PASS');
    assert.deepEqual(f.findings, []);
  } finally { rmTree(dir); }
});

test('skills-inventory: dir without table row fails', () => {
  const dir = mkTree({ skills: ['alpha', 'beta'], readme: makeReadme({ skills: ['alpha'] }) });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes("skills/beta/ has SKILL.md") && x.includes("'beta'")), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('skills-inventory: row without dir fails', () => {
  const dir = mkTree({ skills: ['alpha'], readme: makeReadme({ skills: ['alpha', 'ghost'] }) });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes("row 'ghost' has no skills/ghost/SKILL.md")), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('skills-inventory: invocation mismatch fails', () => {
  const dir = mkTree({
    skills: ['alpha'],
    readme: makeReadme({ skills: [{ name: 'alpha', inv: '/skill:wrong' }] }),
  });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('alpha') && x.includes('/skill:wrong')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('skills-inventory: duplicate rows fail', () => {
  const dir = mkTree({
    skills: ['alpha'],
    readme: makeReadme({ skills: ['alpha', 'alpha'] }),
  });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes("duplicate skills table row 'alpha'")), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('skills-inventory: missing table fails explicitly, no crash', () => {
  const dir = mkTree({ skills: ['alpha'], readme: '# no table here\n' });
  try {
    const f = family(dir, 'skills-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('skills table not found in README.md')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

// ---------- step 3: extensions-inventory ----------
test('extensions-inventory: consistent fixture passes; top-level .ts file ignored', () => {
  const dir = mkTree({
    extensions: ['gatey', 'subbers'],
    extFiles: [{ path: 'handoff.ts', content: '// top-level file, not an extension unit\n' }],
    readme: makeReadme({ extensions: ['gatey', 'subbers'] }),
  });
  try {
    const f = family(dir, 'extensions-inventory');
    assert.equal(f.status, 'PASS');
    assert.deepEqual(f.findings, []);
  } finally { rmTree(dir); }
});

test('extensions-inventory: dir without README mention fails', () => {
  const dir = mkTree({ extensions: ['gatey', 'subbers'], readme: makeReadme({ extensions: ['gatey'] }) });
  try {
    const f = family(dir, 'extensions-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('extensions/subbers/ contains TypeScript') && x.includes('`subbers/`')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('extensions-inventory: mention without dir fails', () => {
  const dir = mkTree({ extensions: ['gatey'], readme: makeReadme({ extensions: ['gatey', 'phantom'] }) });
  try {
    const f = family(dir, 'extensions-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('`phantom/`') && x.includes('has no .ts files')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('extensions-inventory: missing section fails explicitly', () => {
  const dir = mkTree({ extensions: ['gatey'], readme: '# no extensions section\n' });
  try {
    const f = family(dir, 'extensions-inventory');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('`## Extensions` section not found')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

// ---------- step 4: env-vars ----------
test('env-vars: allowlisted var passes undocumented', () => {
  const dir = mkTree({
    extensions: [{ name: 'subbers', ts: 'const id = process.env.PI_SUBAGENT_ID;\n' }],
    readme: '# fixture\n',
  });
  try {
    const f = family(dir, 'env-vars');
    assert.equal(f.status, 'PASS', f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('env-vars: non-allowlisted undocumented var fails', () => {
  const dir = mkTree({
    extensions: [{ name: 'subbers', ts: 'const v = process.env.PI_TURBO_MODE;\n' }],
    readme: '# fixture\n',
  });
  try {
    const f = family(dir, 'env-vars');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('PI_TURBO_MODE') && x.includes('extensions/subbers/index.ts') && x.includes('not documented')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('env-vars: documented var without code fails', () => {
  const dir = mkTree({
    extensions: [{ name: 'subbers', ts: '// none\n' }],
    readme: '# fixture\n\nSet `PI_GHOST_KNOB=1` to enable.\n',
  });
  try {
    const f = family(dir, 'env-vars');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('PI_GHOST_KNOB') && x.includes('documented in README.md') && x.includes('not found in scanned code')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('env-vars: var in scripts/*.mjs is scanned', () => {
  const dir = mkTree({
    extensions: [{ name: 'subbers', ts: '// none\n' }],
    scripts: [{ name: 'helper.mjs', content: 'const v = process.env.PI_HELPER_KNOB;\n' }],
    readme: '# fixture\n',
  });
  try {
    const f = family(dir, 'env-vars');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.includes('PI_HELPER_KNOB') && x.includes('scripts/helper.mjs')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('env-vars: documented + used var passes; extension-local README counts as docs', () => {
  const dir = mkTree({
    extensions: [{ name: 'subbers', ts: 'const v = process.env.PI_LOCAL_KNOB;\n', readme: '# subbers\n\n`PI_LOCAL_KNOB` tunes polling.\n' }],
    readme: '# fixture\n',
  });
  try {
    const f = family(dir, 'env-vars');
    assert.equal(f.status, 'PASS', f.findings.join('\n'));
  } finally { rmTree(dir); }
});

// ---------- family 1: md-commands fixture smoke ----------
test('md-commands: valid fixture command passes', () => {
  const dir = mkTree({ readme: '# fixture\n\n```sh\necho hello\n```\n' });
  try {
    const { human } = run(dir);
    const f = family(dir, 'md-commands');
    assert.equal(f.status, 'PASS');
    assert.deepEqual(f.findings, []);
    assert.ok(human.includes('md files scanned: 1'), human);
  } finally { rmTree(dir); }
});

// The inline path probes `command -v` before applying the MAC_ONLY / /tmp
// skips that the fenced-block path applies first. On Linux `security` and
// `codesign` do not exist, so a doc that cites them inline failed the check
// on CI while passing on macOS — a portability bug in the checker, not in the
// docs. These two cases pin the skip order for the inline path.
test('md-commands: inline macOS-only tool is skipped, not a missing binary', () => {
  const dir = mkTree({ readme: '# f\n\nRun `security find-identity -v`.\n' });
  try {
    const f = family(dir, 'md-commands');
    assert.equal(f.status, 'PASS', f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('md-commands: inline /tmp-downloaded tool is on-demand, not a missing binary', () => {
  const dir = mkTree({ readme: '# f\n\nRun `/tmp/actionlint -version`.\n' });
  try {
    const f = family(dir, 'md-commands');
    assert.equal(f.status, 'PASS', f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('md-commands: unknown binary fails', () => {
  const dir = mkTree({ readme: '# fixture\n\n```sh\nnot-a-real-bin-xyz --go\n```\n' });
  try {
    const f = family(dir, 'md-commands');
    assert.equal(f.status, 'FAIL');
    assert.ok(f.findings.some((x) => x.startsWith('BINARY NOT FOUND:') && x.includes('not-a-real-bin-xyz')), f.findings.join('\n'));
  } finally { rmTree(dir); }
});

// A probe that never succeeded must never be reported as a missing flag: the
// JS `catch` used to fold a timeout/ENOENT/empty-stdout probe into the same
// empty flag set as a genuinely absent flag (docs/backlog.md item 2). The fix
// re-probes once, and an unresolved probe is its own class.
test('md-commands: a probe that never resolves is its own finding, not a missing flag', () => {
  // `false` exits 1 with empty stdout: indistinguishable from a bad flag set
  // under the old logic, but it is a probe failure.
  const dir = mkTree({ readme: '# f\n\n```sh\nfalse --surely-not-a-flag\n```\n' });
  try {
    const f = family(dir, 'md-commands');
    assert.ok(
      !f.findings.some((x) => x.startsWith('FLAG NOT IN HELP:') && x.includes('--surely-not-a-flag')),
      f.findings.join('\n'),
    );
  } finally { rmTree(dir); }
});

test('md-commands: a brace group after || is a shell construct, not a binary', () => {
  // `cmd || { echo err; exit 1; }` splits on || into a segment starting with
  // `{`, and the brace was taken as the command name.
  const dir = mkTree({
    readme: '# f\n\n```sh\n[ -n "$X" ] || { echo "missing"; exit 1; }\n```\n',
  });
  try {
    const f = family(dir, 'md-commands');
    assert.equal(f.status, 'PASS', f.findings.join('\n'));
  } finally { rmTree(dir); }
});

test('md-commands: a real binary still has its flags verified', () => {
  // guard against the fix over-reaching: a resolvable probe must still catch a
  // genuinely absent flag. `rg` is KNOWN and not an INTERPRETER, so its flags
  // are actually introspectable (node/npm are skipped by design).
  const dir = mkTree({ readme: '# f\n\n```sh\nrg --surely-not-a-real-flag x\n```\n' });
  try {
    const f = family(dir, 'md-commands');
    assert.ok(
      f.findings.some((x) => x.startsWith('FLAG NOT IN HELP:') && x.includes('--surely-not-a-real-flag')),
      f.findings.join('\n'),
    );
  } finally { rmTree(dir); }
});

// ---------- step 5: aggregation + output ----------
test('aggregation: multi-family failure lists all findings, exit 1', () => {
  const dir = mkTree({
    skills: ['alpha', 'beta'],
    extensions: [{ name: 'subbers', ts: 'const v = process.env.PI_TURBO_MODE;\n' }],
    readme: makeReadme({ skills: ['alpha'] }),
  });
  try {
    const { json, human, status } = run(dir, '--json');
    assert.equal(status, 1);
    const byName = Object.fromEntries(json.families.map((f) => [f.name, f]));
    assert.equal(byName['skills-inventory'].status, 'FAIL');
    assert.ok(byName['skills-inventory'].findings.some((x) => x.includes("skills/beta/")));
    assert.equal(byName['env-vars'].status, 'FAIL');
    assert.ok(byName['env-vars'].findings.some((x) => x.includes('PI_TURBO_MODE')));
    // --json and human come from the same run; check the labels via a second run
    const { human: text } = run(dir);
    for (const label of ['MD-COMMANDS', 'SKILLS INVENTORY', 'EXTENSIONS INVENTORY', 'ENV-VARS']) {
      assert.ok(text.includes(label), `missing ${label} section`);
    }
    assert.ok(text.includes('families failed'));
  } finally { rmTree(dir); }
});

test('aggregation: --json emits the machine shape', () => {
  const dir = mkTree({ skills: ['alpha'], readme: makeReadme({ skills: ['alpha'] }) });
  try {
    const { json } = run(dir, '--json');
    assert.deepEqual(Object.keys(json), ['families']);
    assert.equal(json.families.length, 4);
    for (const f of json.families) {
      assert.deepEqual(Object.keys(f), ['name', 'status', 'findings']);
      assert.ok(['PASS', 'FAIL'].includes(f.status));
      assert.ok(Array.isArray(f.findings));
    }
  } finally { rmTree(dir); }
});

// (The repo's own doc-drift findings stay with `npm run doc:check` — a
// deliberate drift test would make this suite fail for repo reasons rather
// than checker reasons)
test('CLI smoke: --json on the real repo emits four families', () => {
  const r = spawnSync(BIN, [repoRoot, '--json'], { encoding: 'utf8', cwd: repoRoot, timeout: 120000 });
  assert.equal(r.error, undefined, `spawn ${BIN} failed — is the binary installed? (${r.error})`);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.families.map((f) => f.name), ['md-commands', 'skills-inventory', 'extensions-inventory', 'env-vars']);
  assert.ok(j.families.every((f) => f.status === 'PASS' || f.status === 'FAIL'));
});
