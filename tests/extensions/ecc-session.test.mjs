import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import eccSession from "../../extensions/ecc-session/index.ts";

const commandName = "ecc-session";
const flag = "ECC_DISABLED_HOOKS";
const start = "session:start";
const end = "session:end:marker";

async function withAgent(t) {
  const dir = await mkdtemp(join(tmpdir(), `${commandName}-test-`));
  t.mock.method(process, "emitWarning", () => {});
  const keys = [flag, "PI_CODING_AGENT_DIR"];
  const original = keys.map((key) => process.env[key]);
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(async () => {
    for (const [i, key] of keys.entries()) {
      if (original[i] === undefined) delete process.env[key];
      else process.env[key] = original[i];
    }
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function load() {
  let command;
  const notices = [];
  eccSession({ registerCommand: (name, options) => {
    assert.equal(name, commandName);
    command = options;
  } });
  return {
    run: (args) => command.handler(args, { ui: { notify: (...notice) => notices.push(notice) } }),
    complete: (prefix) => command.getArgumentCompletions(prefix)?.map(({ value }) => value),
    notices,
  };
}

test("persists off and on for subsequent loads without changing other hook flags", async (t) => {
  await withAgent(t);
  process.env[flag] = end;
  const first = load();
  assert.equal(process.env[flag], end);
  await first.run("off");
  assert.equal(first.notices.at(-1)[1], "info");
  assert.equal(process.env[flag], end);

  const second = load();
  assert.deepEqual(new Set(process.env[flag].split(",")), new Set([end, start]));
  await second.run("on");
  assert.equal(second.notices.at(-1)[1], "info");
  assert.ok(process.env[flag].includes(start));

  process.env[flag] = ` SESSION:START ,${end}`;
  load();
  assert.equal(process.env[flag], end);
});

test("rejects invalid arguments and offers on and off completions", async (t) => {
  await withAgent(t);
  process.env[flag] = start;
  const command = load();
  assert.deepEqual(command.complete("o"), ["on", "off"]);
  await command.run("on off");
  assert.equal(command.notices.at(-1)[1], "warning");
  load();
  assert.equal(process.env[flag], start);
});

test("keeps the inherited flag after a corrupt preference and reports failed saves", async (t) => {
  const dir = await withAgent(t);
  process.env[flag] = start;
  const cacheDir = join(dir, ".cache");
  const preference = join(cacheDir, commandName);
  await mkdir(cacheDir);
  await writeFile(preference, "invalid\n");
  assert.ok(load());
  assert.equal(process.env[flag], start);

  await rm(preference);
  await mkdir(preference);
  const command = load();
  await command.run("on");
  assert.equal(command.notices.at(-1)[1], "error");
  assert.equal(process.env[flag], start);
});
