// Explicit JSON null in the optional params must behave exactly like an
// omitted key: the advertised wire schema offers null wherever a parameter
// may be left out, and the guard ladder should see one absence shape, not a
// type error. Pins both the execute guards and the declared schema.
import { mkdtempSync, writeFileSync } from "node:fs";
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

const dir = mkdtempSync(join(tmpdir(), "piread-null-"));
const FILE = join(dir, "f.txt");
writeFileSync(FILE, "one\ntwo\nthree\n");

async function call(params) {
  try {
    const r = await tool.execute("t", params, undefined, undefined, { cwd: dir });
    return { ok: true, r };
  } catch (e) {
    return { ok: false, err: String(e?.message ?? e) };
  }
}

test("explicit null offset/limit/hits behaves like omitted keys", async () => {
  const omitted = await call({ path: FILE });
  const nulled = await call({ path: FILE, offset: null, limit: null, hits: null });
  assert.ok(omitted.ok, `omitted baseline must succeed: ${omitted.err}`);
  assert.ok(nulled.ok, `explicit nulls rejected: ${nulled.err}`);
  assert.equal(nulled.r.content[0].text, omitted.r.content[0].text, "same body");
  assert.equal(nulled.r.details?.via, omitted.r.details?.via, "same rung");
});

test("explicit null in one nullable param composes with real values", async () => {
  const plain = await call({ path: FILE, limit: 2 });
  const mixed = await call({ path: FILE, offset: null, limit: 2, hits: null });
  assert.ok(plain.ok, `baseline must succeed: ${plain.err}`);
  assert.ok(mixed.ok, `null offset with a real limit rejected: ${mixed.err}`);
  assert.equal(mixed.r.content[0].text, plain.r.content[0].text, "same window");
});

test("string 'null'/'undefined' hits stays an absent selector", async () => {
  for (const needle of ["null", "undefined"]) {
    const r = await call({ path: FILE, hits: needle });
    assert.ok(r.ok, `literal ${needle} hits rejected: ${r.err}`);
    assert.equal(r.r.content[0].text, "one\ntwo\nthree\n");
  }
});

test("schema declares null as an accepted alternative for every optional", () => {
  const props = tool.parameters?.properties ?? {};
  const want = { offset: "number", limit: "number", hits: "string" };
  for (const [key, base] of Object.entries(want)) {
    const types = (props[key]?.anyOf ?? []).map((s) => s.type);
    assert.deepEqual(types, [base, "null"], `${key} must accept ${base} or null`);
  }
});
