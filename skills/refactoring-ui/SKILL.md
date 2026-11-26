---
name: refactoring-ui
description: Audit and fix existing web UIs — hierarchy, spacing, color, depth. Use when the UI "looks off", needs polish, a design system, or dark mode, or small UI defects need fixing (links to missing routes, invalid media queries, shared spinner states). FIXING/POLISHING existing UI only — NOT for building new UI → frontend-design.
license: MIT
metadata:
  author: wondelai
  version: "1.3.0-slim"
disable-model-invocation: false
---

# Refactoring UI (slim)

Audit-first system for **fixing existing UIs**. Sibling of `frontend-design` (greenfield). Apply when reviewing/polishing frontend code.

Core: **design in grayscale first, color last.** Great UI = systems, not talent — constrained scales for spacing, type, color, shadows. Start with too much whitespace, then remove.

## 0. House style wins over this skill (hard rules from real failures)
- Before redesigning ANY page: audit 2-3 sibling pages in same app section, copy their EXACT layout idiom — wrapper padding, page width (full vs constrained), heading size/tag, card style object. App's established pattern beats this skill's generic advice every time. "Better" design breaking app consistency = bug, not improvement.
- Verify real data keys before using them (`localStorage.getItem('x')` — confirm key against code that WRITES it, not a copy-pasted page).
- No production build to verify style-only changes in dev-server project — HMR shows live. Build only when imports/deps changed.
- After ANY scripted/regex edit to JSX: parse every touched file (esbuild --loader:.jsx) before declaring success. Regex count check ≠ verification. Prefer `edit` tool over ad-hoc python replace for JSX blocks — string replace on JSX nests/duplicates tags silently.

## 0b. Logic-in-UI hard rules
Apply when "polish" touches data flow, not just styles:
- Fetch-on-selection: staleness guard (cancelled flag / compare requested id) AND `.catch` clearing previous entity's data — late/failed response must never leave old data savable against new selection.
- Clearing/resetting state: enumerate every derived field (rg its consumers). Common survivors: derived data field alive after its "Clear" action; dependent list alive after parent selection changes.
- Dependent-select hierarchies (drill-down ladders like channel > business unit > category > brand): strictly sequential — a child select stays disabled until the level above holds a real pick ('all' counts as a pick); users must never jump levels. Clearing a level (emptying it, not picking 'all') clears every pick below it and re-locks those selects; a narrowed parent prunes stale children.
- Form pre-filled from row 1 + `values.x ?? o.x` fallback = dead fallback; bulk saves apply row 1's value to every row. Open fields empty or track touched fields.
- Lazy tab panes drop `setFieldsValue` made before mount (rc-tabs) — `forceRender: true` or prefill on tab activation.
- AntD edit forms: `initialValues` bind only at Form mount — fetch-then-fill needs remount gate (loading spinner) or `form.setFieldsValue`; display-only `defaultValue` inside `Form.Item` leaves store empty, submits placeholder garbage (`moment(undefined)` formats as today).
- List-row state keyed by index or load-time snapshot goes stale when row removed or list re-orders: delete-by-index removes wrong row, default-switch keys land one row off, failed save + retry can submit stale snapshot (or empty list). Read id from live form row at action time; rebuild list payloads from current form values at submit — never toggle-time snapshot.
- Conditional columns/panels: verify DEFAULT state of every span/collapse condition (panel hidden at `span=0` unless nav expanded ships invisible).

## Scoring
Rate UI 0–10 on principles below. State score + specific fixes to reach 10. Deliver in chat only — do NOT write an audit-reports/ file for this skill.

## 1. Hierarchy — not everything can be important
- Three levers: **size, weight, color**. Combine, don't stack — primary = large OR bold OR dark, not all three.
- "All three" reserved for single most important element on page.
- De-emphasize labels (form labels, table headers, metadata): smaller / lighter / uppercase-small. **Values win over labels.**
- Semantic color ≠ visual weight — muted danger button beats screaming one for routine actions.

## 2. Spacing & sizing — relationships, not arbitrary values
- Scale: **4, 8, 16, 24, 32, 48, 64** (`p-1 p-2 p-4 p-6 p-8 p-12 p-16`).
- Start with too much whitespace, then remove — you'll almost never remove enough.
- Space between groups > within groups.
- Text constrained to 45–75 chars (`max-w-prose` ~65ch); forms 300–500px (`max-w-md`). Full-width almost never right.

## 3. Typography — modular scale, two families max
- Scale (1.25 ratio): **12, 14, 16, 20, 24, 30, 36** (`text-xs/sm/base/lg/xl`).
- Headings tight (leading 1.0–1.25), body relaxed (1.5–1.75). Wider text → more leading.
- Emphasis via 600–700, not everywhere. Body weight ≥ 400.
- Two fonts max — or one family with weight variation.

## 4. Color — system first, grayscale first
- 5–9 shades per color (50–900). Darkest = 900-gray (`#111827`), never pure black.
- Pure grays look dead — subtle tint (cool → blue `#64748b`, warm → `#78716c`).
- Body text ≥ 4.5:1 contrast; large (18px+) ≥ 3:1. `#374151` (gray-700) on white.
- HSL variants: lighter = +lightness / −saturation / hue→60; darker = −lightness / +saturation / hue→0 or 240.
- Never convey meaning by color alone — always pair text/icon.

## 5. Depth & shadows — elevation scale
- Small = raised (buttons/cards `shadow-sm/md`); large = floating (dropdowns/modals `shadow-lg/xl`).
- Two-part shadow: tight dark (crispness) + large soft (atmosphere). Color = transparent dark, not opaque gray.
- Depth without shadow: lighter top border + darker bottom border, subtle gradient, offset overlap.
- Everything floats → nothing has depth.

## 6. Images & icons — design elements
- Icons sized to context, consistent stroke/style (`w-4 h-4` inline, `w-6 h-6` nav, `w-8 h-8` feature).
- Images: `object-fit: cover` + fixed `aspect-ratio` — never distort.
- Text on images needs overlay (`bg-gradient-to-t from-black/60 to-transparent`).
- Empty states: illustration + clear CTA, not bare text.

## 7. Layout — don't center everything
- Left-align text default; center only short headlines, heroes, single CTAs, empty states.
- Images bleed past card bounds; overlap containers; vary emphasis between list items.
- Sidebars 240–320px on lighter bg. Page container `max-w-4xl mx-auto`.

## Quick diagnostic
| Check | If it fails → |
|---|---|
| Squint/blur test: hierarchy reads? | boost primary vs secondary contrast |
| Works in grayscale? | strengthen size/weight/spacing (don't lean on color) |
| Enough whitespace? | add more, especially between groups |
| Labels quieter than values? | smaller / lighter / uppercase labels |
| Spacing on scale? | kill arbitrary px (13/17/23) |
| Text width constrained? | `max-w-prose` on text blocks |
| Contrast ≥ 4.5:1? | gray-700+ on white |
| Shadow matches elevation? | align to sm/md/lg/xl by purpose |

## Common fixes
| Symptom | Fix |
|---|---|
| "Looks amateur" | more whitespace, constrain widths |
| "Feels flat" | depth differentiation (shadow / border-bottom) |
| "Hard to read" | +line-height, constrain width, +contrast |
| "All looks the same" | vary size/weight/color — primary vs secondary |
| "Cluttered" | group related items, grow inter-group spacing |
| "Colors clash" | desaturate, more grays, stick to system palette |
| "Buttons don't pop" | +contrast vs surroundings, +shadow |
