# TUI layout: chat screen and input box

This file records how the interactive terminal screen is composed today, so future changes preserve it. Everything below is behavior as it is in the code, not as it could be.

Citation legend: repo files are repo-relative. `chunk-MM3LKT73.js:<line>` is the app's bundled interactive UI (`dist/bundle/chunks/chunk-MM3LKT73.js` inside the installed app package). `types.d.ts:<line>` is the extension API surface of the same package (`dist/core/extensions/types.d.ts`). `editor.js` / `editor.d.ts` are its terminal-UI editor component (`pi-tui/dist/components/editor.js` and `.d.ts`).

## 1. Screen map

Vertical order, top to bottom. The chat scroll view takes the remaining height; the dock below it stacks the rest (`chunk-MM3LKT73.js:961`).

| # | Region | Container | Who can write it |
|---|--------|-----------|------------------|
| 1 | Chat transcript (scrollable) | document view | app only |
| 2 | Queued messages parked while a reply streams | pendingMessages | app only |
| 3 | Status strip | status | app (working indicator; embedded into the input box top border when the editor supports it) |
| 4 | Extension widgets, above | widgetsAbove | `setWidget` with `placement: "aboveEditor"` |
| 5 | Input box (editor) | editor | app default editor, or a custom editor via `setEditorComponent` |
| 6 | Extension widgets, below | widgetsBelow | `setWidget` with `placement: "belowEditor"` |
| 7 | Footer | footer | app (branch, statuses) plus `setFooter` |

Order source: the dock is a vertical stack of pendingMessages, status, widgetsAbove, editor, widgetsBelow, footer (`chunk-MM3LKT73.js:961`); the containers are created and mounted in that same order (`chunk-MM3LKT73.js:969`).

## 2. Input box

What the stock box draws, and nothing more (`editor.js:393-484`):

- A top border line and a bottom border line of `─` characters (`editor.js:385-391`).
- Scroll counters inside those borders when text is hidden: `↑ n` on top, `↓ n` on bottom (`editor.js:386`, `editor.js:390`).
- The visible text lines and the cursor, padded; no side borders (`editor.js:434-470`).
- The autocomplete list, appended below the bottom border, not inside the box (`editor.js:474-483`).

What does not exist anywhere on the stock box: a placeholder, ghost text, a hint row, a mode badge, or a prefix slot. The editor's construction options are padding and autocomplete height only (`editor.d.ts:29-32`); the component has no field for any other decoration. An empty box renders blank padded lines.

Working-status text (working, compaction, retry) is embedded into the top border line by the app's editor subclass whenever status is active (`chunk-MM3LKT73.js:930`); the default editor is constructed with that embedding on (`chunk-MM3LKT73.js:969`). Bash mode (input starting with `!`) only recolors the border; it adds no badge text (`chunk-MM3LKT73.js:991`).

The interior accepts characters two ways: `setEditorText` (replace text) and `pasteToEditor` (bracketed-paste sequence) (`types.d.ts:133-135`, `chunk-MM3LKT73.js:988`). Any other drawing inside the box requires replacing the editor component itself (section 6).

## 3. Running-children widget

The subagents extension draws a bordered box above the input box, key `subagent-status`, placement `aboveEditor` (`extensions/subagents/index.ts:1562-1572`).

Renders, per registered child, one row inside a bordered box titled "Subagents": state icon, elapsed minutes:seconds, a lock tag, name, agent tag, and a usage label on the right (`extensions/subagents/index.ts:1493-1536`).

Scope semantics:

- Every registered child is drawn. Project scope affects ordering only: own-scope children first, foreign-scope after (`extensions/subagents/index.ts:1543-1552`).
- A child registered under another repo root stays visible but dimmed, tagged with its own repo name (`@<name>`); it is never dropped. Filtering the render set by scope emptied the widget entirely, which is why membership is never filtered (`extensions/subagents/index.ts:1512-1521`, guarded by `tests/subagents/widget-scope.test.ts:99`).
- The `▣` glyph on a row marks declared write-scope locks: glyph plus path count, matching the same glyph in the subagents list tool (`extensions/subagents/index.ts:1511`, `extensions/subagents/README.md:79-81`, `extensions/subagents/index.ts:4726`).

Lifecycle:

- Registration arms the refresh: one draw at once, then a redraw every second (`extensions/subagents/index.ts:2228-2230`, `extensions/subagents/index.ts:2532-2539`).
- Session start draws immediately when children are already registered, so a fresh session never shows a blank widget area (`extensions/subagents/index.ts:1585-1592`, wired at `extensions/subagents/index.ts:4165-4166`).
- When the set becomes empty the widget is removed and the timer stops (`extensions/subagents/index.ts:1553-1559`).
- Running children are tracked in a module-level in-memory map; reloading the module re-imports the file and drops that map, while old timers are cleared through a global registry (`extensions/subagents/index.ts:1129`, `extensions/subagents/index.ts:106-112`).
- Widget updates are wrapped so a dying session cannot crash the host: the widget is cosmetic (`extensions/subagents/index.ts:1573-1577`).

Limits: array-form widget content is capped by the host at 10 lines with a `... (widget truncated)` notice; component-factory content, which this widget uses, is not capped (`chunk-MM3LKT73.js:988`). Child sessions draw their own separate widget (`subagent-tools`, a tool-list box, also above the editor) — it adds no rows to the parent's box (`extensions/subagents/subagent-done.ts:177-224`). The widget glyph contract is pointed at from the subagents doctrine page (`docs/subagents.md:27`).

## 4. Extension API region map

| API | Region reached | Can draw inside the box |
|-----|----------------|-------------------------|
| `setEditorComponent(factory)` | replaces the input box component itself | yes — the factory's component owns the whole box render (`types.d.ts:175`, `chunk-MM3LKT73.js:988`) |
| `setEditorText(text)` | box interior text | yes (`types.d.ts:135`, `chunk-MM3LKT73.js:988`) |
| `pasteToEditor(text)` | box interior via bracketed paste | yes (`types.d.ts:133`, `chunk-MM3LKT73.js:988`) |
| `addAutocompleteProvider` | completion list below the box's bottom border | no — same component, outside the bordered area (`types.d.ts:141`, `editor.js:474-483`) |
| `setWidget(key, content, {placement})` | above or below the box only; default `aboveEditor` | no (`types.d.ts:47-51`, `chunk-MM3LKT73.js:988`) |
| `setStatus(key, text)` | one footer line: statuses sorted by key, joined with spaces | no (`types.d.ts:84`, `chunk-MM3LKT73.js:880`, `chunk-MM3LKT73.js:931`) |
| `setFooter(factory)` | footer, replacing the default one | no (`types.d.ts:111`, `chunk-MM3LKT73.js:988`) |
| `setHeader(factory)` | header above the transcript, startup only | no (`types.d.ts:115`) |
| `setTitle`, custom dialog | terminal title, modal overlay | no (`chunk-MM3LKT73.js:988`) |

Headless contexts get no-op stubs for the editor-touching calls (`chunk-MM3LKT73.js:523`). Passing `undefined` to `setEditorComponent` restores the default editor (`types.d.ts:144`, `types.d.ts:175`).

## 5. Do-not-change contract

Each invariant below is visible in code at the cited line; a change that breaks one should be challenged in review.

- The stock input box interior shows text and cursor only — no placeholder, ghost text, hint row, mode badge, or prefix slot is added (`editor.d.ts:29-32`, `editor.js:434-470`).
- Working-status text renders inside the top border, not as a separate row above the box (`chunk-MM3LKT73.js:930`, `chunk-MM3LKT73.js:969`).
- Bash mode recolors the border only; no badge text is added (`chunk-MM3LKT73.js:991`).
- The autocomplete list renders below the bottom border, never inside the box (`editor.js:474-483`).
- The running-children widget renders every registered child; scope orders rows and marks foreign ones, it never filters membership (`extensions/subagents/index.ts:1543-1552`).
- Foreign-scope children stay visible, dimmed, tagged with their own repo (`extensions/subagents/index.ts:1512-1521`, `tests/subagents/widget-scope.test.ts:99`).
- `▣` marks declared write-scope locks, glyph plus path count, matching the list tool's glyph (`extensions/subagents/index.ts:1511`, `extensions/subagents/README.md:79-81`).
- The widget is drawn at session start and its refresh is armed on registration; an empty set removes it and stops the timer (`extensions/subagents/index.ts:1590-1592`, `extensions/subagents/index.ts:2228-2230`, `extensions/subagents/index.ts:1553-1559`).
- Widgets above and below the editor are the only side regions extensions can occupy; neither reaches the box interior (`types.d.ts:47-51`).
- Array-form widget content is capped at 10 lines with a truncation notice (`chunk-MM3LKT73.js:988`).

## 6. Known precedent: owning the box

The compact editor is the one existing custom editor and the sanctioned shape for owning the box:

- Extend the app's editor subclass, override `render(width)`, and return clamped lines; forward every key to the base editor so shortcuts, history, and input-method positioning keep working (`extensions/compact-editor/index.ts:26-36`).
- Install it from the `session_start` hook via `ctx.ui.setEditorComponent` (`extensions/compact-editor/index.ts:33-34`).
- Its clamp keeps the head and tail of the rendered lines and collapses the middle into one `[... N more lines ...]` notice, default cap 10 lines (`extensions/compact-editor/clamp.ts:10`, `extensions/compact-editor/clamp.ts:23-43`); the clamp output is pinned by unit test (`tests/unit/compact-editor.test.mjs:1-62`).
- The API docs recommend the same shape: extend the exported editor subclass and call `super.handleInput` for keys you do not handle (`types.d.ts:150-152`).
