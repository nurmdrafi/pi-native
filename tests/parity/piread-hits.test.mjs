// Fused locate+read (`hits`) through the registered piread tool: schema
// surface, daemon + one-shot rungs, screening, miss notice. Mirrors the
// cross-rung child's registration mock from piread-parity.test.mjs.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const m = await import(join(ROOT, "extensions/piread/index.ts"));
const pi = {
  tools: new Map(),
  registerTool: (d) => pi.tools.set(d.name, d),
  on: () => () => {},
};
m.default(pi);
const tool = pi.tools.get("piread");
const REAL_BIN = join(ROOT, "bin", "piread");

const dir = mkdtempSync(join(tmpdir(), "piread-hits-"));
const FILE = join(dir, "f.ts");
// "target" sits on file line 21 (index 20); everything else is filler.
writeFileSync(
  FILE,
  Array.from({ length: 60 }, (_, i) =>
    i === 20 ? "export function target() {}" : `line ${i}`,
  ).join("\n"),
);

async function call(params) {
  try {
    const r = await tool.execute("t", params, undefined, undefined, { cwd: dir });
    return { ok: true, r };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) };
  }
}

test("schema exposes optional hits alongside the paging params", () => {
  const props = tool.parameters?.properties ?? {};
  assert.ok(props.path, "path kept");
  assert.ok(props.offset, "offset kept");
  assert.ok(props.limit, "limit kept");
  assert.equal(props.hits?.type, "string", "hits is an optional string");
});

test("fused read serves rg-shaped numbered windows via the daemon", async () => {
  const { ok, r } = await call({ path: FILE, hits: "target" });
  assert.ok(ok);
  assert.match(r.content[0].text, /(^|\n)21:export function target\(\) \{\}/);
  assert.match(r.content[0].text, /(^|\n)9:line 8/);
  assert.equal(r.details?.via, "daemon");
  assert.deepEqual(r.details?.locate?.hits, [21]);
  assert.deepEqual(r.details?.locate?.windows, [[9, 33]]);
});

test("fused read falls to the one-shot spawn with --hits args", async () => {
  const wrap = join(dir, "wrap");
  writeFileSync(
    wrap,
    `#!/bin/sh\ncase "$1" in --serve) exit 1 ;; esac\nexec "${REAL_BIN}" "$@"\n`,
  );
  chmodSync(wrap, 0o755);
  process.env.PI_READ_BIN = wrap;
  m.__resetDaemonForTest();
  try {
    const { ok, r } = await call({ path: FILE, hits: "target" });
    assert.ok(ok);
    assert.equal(r.details?.via, "oneshot");
    assert.match(r.content[0].text, /(^|\n)21:export function target/);
  } finally {
    delete process.env.PI_READ_BIN;
    m.__resetDaemonForTest();
  }
});

test("hits combined with paging params is rejected up front", async () => {
  const withOffset = await call({ path: FILE, hits: "target", offset: 1 });
  assert.ok(!withOffset.ok, "offset+hits must reject");
  assert.match(withOffset.err, /cannot combine/);
  const withLimit = await call({ path: FILE, hits: "target", limit: 5 });
  assert.ok(!withLimit.ok, "limit+hits must reject");
  assert.match(withLimit.err, /cannot combine/);
});

test("empty hits is a usage error", async () => {
  const { ok, err } = await call({ path: FILE, hits: "" });
  assert.ok(!ok, "empty hits must reject");
  assert.match(err, /hits must be a non-empty string/);
});

test("a miss returns the one-line notice, not an error", async () => {
  const { ok, r } = await call({ path: FILE, hits: "zzz_missing" });
  assert.ok(ok);
  assert.match(r.content[0].text, /\[no lines matching 'zzz_missing' in .+ \(60 lines, \d+ bytes\)\]/);
});
