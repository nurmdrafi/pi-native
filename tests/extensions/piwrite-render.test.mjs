import test from "node:test";
import assert from "node:assert/strict";

import piwriteExtension from "../../extensions/piwrite/index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

// keyHint reads the global theme; the interactive UI initializes it before
// any render, tests must do the same.
initTheme();

/**
 * Renderer parity tests: piwrite's interactive display must match the
 * built-in write tool's writeRenderers (dist/core/tools/renderers/write.js)
 * byte-for-byte, except the title token which is the tool's own `piwrite`
 * label: title line, 10-line collapsed preview (expanded shows all), trailing-empty
 * trim, `... (N more lines, M total,` expand hint, error-color results, and a
 * cleared (empty) result component on success.
 */

/** Theme stub: pass text through so assertions see the literal strings. */
const identityTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/** Strip OSC-8 hyperlinks (path wrapping from the real renderToolPath chain);
 *  the parity test locks the exact wire bytes, so plain-text assertions
 *  compare against the unlinked form. */
const stripOsc8 = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

/** Capture what the renderer pushes into the component it reuses. */
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

const makeContext = (overrides = {}) => ({
  lastComponent: undefined,
  expanded: false,
  isPartial: false,
  argsComplete: true,
  cwd: "/tmp",
  ...overrides,
});

/** The registered tool definition, captured through a stub ExtensionAPI. */
function captureTool() {
  let def;
  piwriteExtension({ registerTool: (d) => (def = d) });
  return def;
}

const def = captureTool();
assert.ok(def, "extension must register a tool");

/** 12 real lines (tab on line 3), CRLF joins, 3 trailing empty lines. */
const source = Array.from({ length: 12 }, (_, i) => `line-${i + 1}`);
source[2] = "line-3\twithtab";
const content = `${source.join("\r\n")}\r\n\r\n\r\n`;

const PLAIN_PATH = "out.zzzq9"; // extension with no language mapping

const renderCallText = (args, context = makeContext()) => {
  // The TUI renders the first frame with no lastComponent and reuses the
  // returned component (which carries the highlight state) afterwards.
  // Read the text back from the returned component, like the TUI does.
  const component = def.renderCall(args, identityTheme, { ...context, lastComponent: undefined });
  return component.text;
};

test("registration keeps tool identity and adds renderResult", () => {
  assert.equal(def.name, "piwrite");
  assert.equal(typeof def.execute, "function");
  assert.equal(typeof def.renderCall, "function");
  assert.equal(typeof def.renderResult, "function");
});

test("renderCall title: the piwrite label + accent path", () => {
  const text = renderCallText({ path: PLAIN_PATH, content: "x" });
  assert.ok(stripOsc8(text).startsWith(`piwrite ${PLAIN_PATH}`), `title in: ${text}`);
});

test("collapsed preview: first 10 lines, CRLF normalized, tabs to 3 spaces", () => {
  const text = renderCallText({ path: PLAIN_PATH, content });
  assert.ok(text.includes("line-1\n"), "first line shown");
  assert.ok(text.includes("\nline-3   withtab\n"), "tab replaced by 3 spaces");
  assert.ok(text.includes("line-10"), "tenth line shown");
  assert.ok(!text.includes("line-11"), "eleventh line hidden");
  assert.ok(!text.includes("\r"), "carriage returns stripped");
});

test("remaining hint: N more / M total with expand key hint", () => {
  const text = renderCallText({ path: PLAIN_PATH, content });
  assert.ok(
    text.includes("... (2 more lines, 12 total,"),
    `exact totals in: ${JSON.stringify(text.slice(-160))}`,
  );
  assert.ok(text.includes("to expand"), "keyHint description present");
  assert.ok(text.trimEnd().endsWith(")"), "hint closed by paren");
});

test("expanded context shows every line and no hint", () => {
  const text = renderCallText(
    { path: PLAIN_PATH, content },
    makeContext({ expanded: true }),
  );
  assert.ok(text.includes("line-12"), "last line shown");
  assert.ok(!text.includes("more lines"), "no collapse hint");
});

test("trailing empty lines never count toward totals", () => {
  const text = renderCallText({ path: PLAIN_PATH, content: "only\r\n\r\n\r\n" });
  assert.ok(!text.includes("more lines"), "single line, no hint");
  assert.ok(text.includes("only"));
});

test("language-mapped path renders highlighted (ANSI) lines", () => {
  const text = renderCallText({
    path: "/tmp/pw/sample.ts",
    content: "const answer = 42;\n",
  });
  assert.match(text, /\x1b\[/, "ANSI escapes from highlightCode");
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(stripped.includes("const answer = 42;"), "source preserved");
});

test("non-string content arg renders the invalid-content marker", () => {
  const text = renderCallText({ path: PLAIN_PATH, content: 42 });
  assert.ok(
    text.includes("[invalid content arg - expected string]"),
    `marker in: ${text}`,
  );
});

test("empty string content renders the bare title", () => {
  const text = renderCallText({ path: PLAIN_PATH, content: "" });
  assert.equal(stripOsc8(text), `piwrite ${PLAIN_PATH}`);
});

test("non-string path arg renders the invalid-arg marker", () => {
  const text = renderCallText({ path: 0, content: "x" });
  assert.ok(text.includes("[invalid arg]"), `marker in: ${text}`);
});

test("renderCall reuses the component from lastComponent", () => {
  const sink = fakeComponent();
  const returned = def.renderCall(
    { path: PLAIN_PATH, content: "x" },
    identityTheme,
    makeContext({ lastComponent: sink }),
  );
  assert.equal(returned, sink);
  assert.ok(sink.state.text.length > 0);
});

test("renderResult error: text blocks joined, error-colored, leading newline", () => {
  const sink = fakeComponent();
  const returned = def.renderResult(
    { content: [{ type: "text", text: "boom" }] },
    {},
    identityTheme,
    makeContext({ lastComponent: sink, isError: true }),
  );
  assert.equal(returned, sink);
  assert.equal(sink.state.text, "\nboom");
});

test("renderResult error with no text output clears instead", () => {
  const sink = fakeComponent();
  const returned = def.renderResult(
    { content: [] },
    {},
    identityTheme,
    makeContext({ lastComponent: sink, isError: true }),
  );
  assert.equal(returned, sink);
  assert.equal(sink.state.cleared, true);
});

test("renderResult success: cleared container, nothing rendered", () => {
  const returned = def.renderResult(
    { content: [{ type: "text", text: "Successfully wrote to x" }] },
    {},
    identityTheme,
    makeContext(),
  );
  assert.ok(returned instanceof Container, "fresh cleared Container on success");
});
