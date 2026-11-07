import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import piwriteExtension from "../../extensions/piwrite/index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  resetCapabilitiesCache,
  setCapabilityOverrides,
} from "@earendil-works/pi-tui";

// The REAL built-in write renderers, resolved from the repo-installed package
// (legal in node tests; the extension itself may only import package roots).
// import.meta.resolve keeps the path machine-independent AND keeps the
// reference on the repo's pi-tui instance, so instanceof checks see one
// Container class instead of a second one from a global-install copy.
const piPkgRoot = dirname(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
);
const { writeRenderers } = await import(
    `${piPkgRoot}/dist/core/tools/renderers/write.js`
);

// keyHint/highlight read the global theme; the interactive UI initializes it
// before any render, tests must do the same.
initTheme();

/**
 * Byte-for-byte parity contract: piwrite's renderCall/renderResult must
 * produce the exact string payloads the built-in write tool's writeRenderers
 * produce when driven through identical scripted sequences — streaming
 * partials (empty content growing frame by frame), argsComplete completion,
 * expand toggles, success and error results. Allowed difference: none. The
 * title matches the built-in's literal `write` label, and paths render
 * through the built-in's home-shortening + OSC8 hyperlink rules.
 */

/** Theme stub: deterministic passthroughs so assertions compare payloads. */
const identityTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/** Sink that captures what a renderer pushes into the reused component. */
function fakeComponent() {
  const state = { text: "", cleared: false };
  return {
    state,
    setText(text) {
      state.text = text;
    },
    clear() {
      state.cleared = true;
      state.text = "";
    },
  };
}

/** The registered piwrite definition, captured through a stub ExtensionAPI. */
function captureTool() {
  let def;
  piwriteExtension({ registerTool: (d) => (def = d) });
  return def;
}

const ours = captureTool();
assert.ok(ours, "piwrite must register a tool");
assert.equal(typeof ours.renderCall, "function");
assert.equal(typeof ours.renderResult, "function");
const theirs = writeRenderers;

const baseContext = {
  lastComponent: undefined,
  expanded: false,
  isPartial: true,
  argsComplete: false,
  cwd: "/tmp",
};

/**
 * Drive one renderer's renderCall through frames exactly as the TUI does:
 * frame 1 renders with no lastComponent, later frames receive the component
 * the previous frame returned (the TUI's callRendererComponent slot), and
 * the rendered text is read back from that component after each frame.
 */
function driveCall(renderer, frames, contextOverrides = {}) {
  let component;
  return frames.map((frame) => {
    component = renderer.renderCall(frame.args, identityTheme, {
      ...baseContext,
      ...contextOverrides,
      ...frame.context,
      lastComponent: component,
    });
    return component.text;
  });
}

/** First-frame path: no lastComponent, real component, read its text. */
function freshCallText(renderer, args, context = {}) {
  const component = renderer.renderCall(args, identityTheme, {
    ...baseContext,
    ...context,
  });
  assert.ok(component, "renderer must return a component");
  return component.text;
}

/* ------------------------------------------------------------------ *
 * Streaming call sequences
 * ------------------------------------------------------------------ */

// A 60-line typescript body: crosses WRITE_PARTIAL_FULL_HIGHLIGHT_LINES (50),
// includes a tab line, so the incremental prefix refresh path runs.
const bigLines = Array.from({ length: 60 }, (_, i) =>
  i === 5 ? "\ttabbed = 1;" : `const v${i} = ${i};`,
);
const big = bigLines.join("\n");

// Grow `seed` into `big` in prefix-preserving chunks of 10 lines.
const seed = "const v0 = 0;";
const growing = [];
for (let n = 10; n <= 60; n += 10) {
  growing.push({ args: { path: "src/example.ts", content: bigLines.slice(0, n).join("\n") } });
}

const streamFrames = [
  { args: { path: "src/example.ts", content: "" } }, // title only
  { args: { path: "src/example.ts", content: seed } },
  // Unterminated block comment: single-line (cache tail) highlighting must
  // differ from whole-file highlighting — proves the cache path is exercised.
  { args: { path: "src/example.ts", content: `${seed}\n/* open\nblock` } },
  { args: { path: "src/example.ts", content: `${seed}\n/* open\nblock\nstill */` } },
  ...growing,
  // CRLF + trailing empties while still streaming.
  { args: { path: "src/example.ts", content: `${big}\r\n\r\n` } },
  // Rewrite mid-stream: new content is not an extension of the old one.
  { args: { path: "src/example.ts", content: `// rewrite\n${big}` } },
  // Language switch mid-stream forces a full rebuild.
  { args: { path: "src/example.py", content: `# py rewrite\n${big}` } },
  // Back to the ts file: lang switch again.
  { args: { path: "src/example.ts", content: big } },
  // Completion: args arrive whole; the partial cache is dropped.
  { args: { path: "src/example.ts", content: big }, context: { argsComplete: true } },
  // Expand toggles on the completed call.
  { args: { path: "src/example.ts", content: big }, context: { argsComplete: true, expanded: true } },
  { args: { path: "src/example.ts", content: big }, context: { argsComplete: true, expanded: true, isPartial: false } },
  // Collapsed again: the "(N more lines, M total," hint returns.
  { args: { path: "src/example.ts", content: big }, context: { argsComplete: true, isPartial: false } },
];

/** The one deliberate divergence: rows are titled `piwrite`, not the built-in
 * `write`. Applied to the built-in's text so everything else must still match
 * byte-for-byte. */
const asPiwrite = (t) => t.replace(/^write /, "piwrite ");

test("streaming + completion + expand frames match byte-for-byte", () => {
  const ourTexts = driveCall(ours, streamFrames);
  const theirTexts = driveCall(theirs, streamFrames);
  for (let i = 0; i < streamFrames.length; i++) {
    assert.ok(ourTexts[i] !== undefined || theirTexts[i] === undefined, "frame rendered");
    assert.equal(
      ourTexts[i],
      asPiwrite(theirTexts[i]),
      `frame ${i} (${JSON.stringify(streamFrames[i].args?.path)}, len ${streamFrames[i].args?.content?.length}) diverged`,
    );
  }
});

test("no-language path streams identically (plain toolOutput lines)", () => {
  const frames = [
    { args: { path: "notes.txt", content: "" } },
    { args: { path: "notes.txt", content: "first line" } },
    { args: { path: "notes.txt", content: "first line\nsecond\tline" } },
    { args: { path: "notes.txt", content: "first line\nsecond\tline\n" }, context: { argsComplete: true } },
  ];
  const ourTexts = driveCall(ours, frames);
  const theirTexts = driveCall(theirs, frames);
  for (let i = 0; i < frames.length; i++) {
    assert.equal(ourTexts[i], asPiwrite(theirTexts[i]), `frame ${i} diverged`);
  }
});

test("invalid args render identically (content, path, empty path)", () => {
  const frames = [
    { args: { path: "a.ts", content: 42 } }, // non-string content
    { args: { path: 42, content: "x" } }, // non-string path -> [invalid arg]
    { args: { path: "", content: "x" } }, // empty path -> "..."
    { args: { content: "x" } }, // missing path -> "..."
    { args: {} }, // everything missing -> "..." + empty content
  ];
  const ourTexts = driveCall(ours, frames);
  const theirTexts = driveCall(theirs, frames);
  for (let i = 0; i < frames.length; i++) {
    assert.equal(ourTexts[i], asPiwrite(theirTexts[i]), `frame ${i} diverged`);
  }
});

test("home-dir path shortens to ~/ exactly like the built-in", () => {
  const homePath = `${homedir()}/proj/deep/x.ts`;
  const frames = [
    { args: { path: homePath, content: "const a = 1;" } },
    { args: { path: `${homedir()}/`, content: "const a = 1;" }, context: { argsComplete: true } },
  ];
  const ourTexts = driveCall(ours, frames);
  const theirTexts = driveCall(theirs, frames);
  assert.equal(ourTexts[0], asPiwrite(theirTexts[0]));
  assert.equal(ourTexts[1], asPiwrite(theirTexts[1]));
  assert.ok(ourTexts[0].includes("~/proj/deep/x.ts"), `shortened title in: ${ourTexts[0].split("\n")[0]}`);
});

test("OSC8 hyperlink capability wraps both renderers identically", () => {
  const before = { ...getCapabilities() };
  try {
    setCapabilityOverrides({ hyperlinks: true });
    const frames = [
      { args: { path: "abs.ts", content: "const a = 1;" } },
      { args: { path: `${homedir()}/proj/x.ts`, content: "const a = 1;" }, context: { argsComplete: true } },
    ];
    const ourTexts = driveCall(ours, frames);
    const theirTexts = driveCall(theirs, frames);
    assert.equal(ourTexts[0], asPiwrite(theirTexts[0]));
    assert.equal(ourTexts[1], asPiwrite(theirTexts[1]));
    assert.ok(ourTexts[0].includes("file:///tmp/abs.ts"), `href in: ${ourTexts[0].split("\n")[0]}`);
  } finally {
    setCapabilityOverrides({});
    resetCapabilitiesCache();
    void before;
  }
});

test("fresh component (no lastComponent) renders the piwrite title", () => {
  const ourTitle = freshCallText(ours, { path: "src/fresh.ts", content: "" });
  const theirTitle = freshCallText(theirs, { path: "src/fresh.ts", content: "" });
  assert.equal(ourTitle, asPiwrite(theirTitle));
  assert.ok(ourTitle.startsWith("piwrite "), `piwrite title in: ${JSON.stringify(ourTitle)}`);
});

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

function driveResult(renderer, result, context = {}) {
  const sink = fakeComponent();
  const returned = renderer.renderResult(
    result,
    { expanded: false, isPartial: context.isPartial ?? false },
    identityTheme,
    { ...baseContext, ...context, lastComponent: sink },
  );
  return { returned, sink };
}

test("success result: reused component cleared, fresh result is a Container", () => {
  const ok = { content: [{ type: "text", text: "Successfully wrote to src/example.ts" }], details: { via: "oneshot", bytes: 3 } };
  const ourRun = driveResult(ours, ok, { isError: false, argsComplete: true });
  const theirRun = driveResult(theirs, ok, { isError: false, argsComplete: true });
  assert.equal(ourRun.sink.state.cleared, theirRun.sink.state.cleared);
  assert.equal(ourRun.sink.state.cleared, true);
  assert.equal(ourRun.sink.state.text, theirRun.sink.state.text);

  const ourFresh = ours.renderResult(ok, { expanded: false, isPartial: false }, identityTheme, { ...baseContext, isError: false });
  const theirFresh = theirs.renderResult(ok, { expanded: false, isPartial: false }, identityTheme, { ...baseContext, isError: false });
  assert.ok(ourFresh instanceof Container, "ours returns a Container");
  assert.ok(theirFresh instanceof Container, "theirs returns a Container");
});

test("partial success result (streaming update) clears identically", () => {
  const partial = { content: [{ type: "text", text: "" }], details: undefined };
  const ourRun = driveResult(ours, partial, { isError: false, isPartial: true, argsComplete: true });
  const theirRun = driveResult(theirs, partial, { isError: false, isPartial: true, argsComplete: true });
  assert.equal(ourRun.sink.state.cleared, theirRun.sink.state.cleared);
});

test("error result text matches byte-for-byte (single and joined blocks)", () => {
  const one = { content: [{ type: "text", text: "boom" }], details: undefined };
  const two = {
    content: [
      { type: "text", text: "boom1" },
      { type: "text", text: "boom2" },
    ],
    details: undefined,
  };
  for (const result of [one, two]) {
    const ourRun = driveResult(ours, result, { isError: true, argsComplete: true });
    const theirRun = driveResult(theirs, result, { isError: true, argsComplete: true });
    assert.equal(ourRun.sink.state.text, theirRun.sink.state.text);
    assert.equal(ourRun.sink.state.cleared, theirRun.sink.state.cleared);
  }
});

test("error result without text blocks clears identically", () => {
  const noText = { content: [{ type: "image", data: "x", mimeType: "image/png" }], details: undefined };
  const empty = { content: [], details: undefined };
  for (const result of [noText, empty]) {
    const ourRun = driveResult(ours, result, { isError: true, argsComplete: true });
    const theirRun = driveResult(theirs, result, { isError: true, argsComplete: true });
    assert.equal(ourRun.sink.state.cleared, theirRun.sink.state.cleared);
    assert.equal(ourRun.sink.state.cleared, true);
  }
});
