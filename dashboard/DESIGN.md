# DESIGN.md — pi sessions dashboard

Visual authority for `dashboard/`. Written for the 1.68 redesign; supersedes the
incumbent look. Surface mode: **Operate**.

## Mimic lineage (the reference world)

The world mimics the strongest conventions of three systems, chosen because this
stack already ships half of them:

- **shadcn/ui dashboard block** — the structure: icon sidebar, sticky top bar,
  card grids, dense tables, master-detail panels.
- **Vercel Geist** — the restraint: neutral chrome, one accent, tabular
  numerics, hairline borders, calm density, motion measured in milliseconds.
- **Linear** — the navigation feel: flat hierarchy, keyboard-first, everything
  one keystroke deep, active state unmistakable.

Rule of the world: **color is data and state, never decoration.** Chrome is
neutral; charts carry the hue; destructive/amber/green speak only for
over-budget / warning / live.

## Layout

- App shell: `lg:grid-cols-[224px_1fr]`. Sidebar fixed-height, `border-r`,
  scrolls internally if needed. Below `lg`, the sidebar collapses to a
  horizontally scrollable nav strip under the top bar.
- Top bar: sticky, `h-12`, `border-b`, backdrop blur. Wordmark, snapshot time,
  connection state, theme toggle, notification toggle — icon buttons 28px.
- Content: `p-6` desktop / `p-4` mobile, full-width tables, `grid gap-4`
  card rows. Stat rows: `grid-cols-2` → `lg:grid-cols-5/6`.
- Navigation state lives in the URL hash (`#/sessions`, `#/gate`, …): deep
  links, back button, reload-into-tab all work.

## Color

- Light (`:root`): paper-neutral surfaces (near-white background, `muted` card
  washes), ink foreground.
- Dark (`.dark`): the incumbent deep-violet-tinged charcoal (kept — it is the
  identity the operator already knows), default when the OS prefers dark.
- Accent: violet (`--primary`, oklch ~0.62 0.19 300) reserved for interactive
  and active states: active nav item, focus rings, links.
- Charts keep the five-hue oklch data sequence (`--chart-1..5`), tuned per
  theme for ≥3:1 on their card surface. Same hue → same meaning everywhere:
  chart-1 cost, chart-2 secondary series, chart-3 counts, chart-4 mix,
  chart-5 gate/blocks.

## Typography

- One family: Geist Variable. Hierarchy by weight and size steps, not new fonts.
- Scale: page title 13px/600, card titles 12px/500 uppercase tracking-wide is
  banned — titles stay sentence case 13px/500; stat labels 11px/500 muted;
  values 22px/600 tabular-nums; table cells 12px, ids/paths monospace 11px.
- All metrics `tabular-nums`. Money: `$1.23` / `$1,234`, milliseconds or
  `1.2s`, durations `2h 14m`, counts `1.2k`.

## Components

- Cards: `rounded-lg border bg-card`, header 12px title + muted suffix meta,
  no shadows on the resting surface (shadow only on keyboard focus/hover of
  interactive cards).
- Tables: header 11px muted, rows 36px, zebra off, hover `bg-muted/50`,
  selected row `bg-muted` + accent left edge. Rows that act as controls are
  focusable buttons (Enter/Space), with visible focus ring.
- Badges: severity — destructive (error), amber (warn), muted (off); live dot
  green with text label beside it (never color alone).
- Charts: recharts, hairline gridlines (horizontal only for time series,
  vertical only for horizontal bars), axis ticks 11px muted, tooltip follows
  the shadcn chart tooltip. No gradients, no 3D, no drop shadows on data.
- Empty states: one line of muted copy + a call to action when one exists
- Loading: skeletons mirror the resting layout — the app shell (header, nav,
  stat grid, two chart cards), the session detail panel (title, tabs, chart,
  rows) and the live feed rows (time, file, cost). Pulse on a muted surface;
  no spinners, no "loading" copy.
  ("no sessions match — clear the filter").

## Motion

150ms ease-out for hover/focus/state; nothing loops except the live connection
dot pulse (disabled under `prefers-reduced-motion`). No entrance animations on
data; charts can fade series in (150ms) but never animate axes.

## Estimates

- Avoided spend (gate tab) ≈ blocked calls × avg observed cost per call of the
  same tool; tools that never cost anything fall back to the global per-call
  average, and per-call cost comes from turn cost split evenly across the
  turn's calls. A proxy for what blocks saved, not a measurement — a blocked
  call also skips the turn's remaining work, which the estimate ignores. The
  caption beside the number restates the formula.

## Accessibility floor

Body/secondary text ≥4.5:1 both themes; icon-only buttons carry aria-labels;
every interactive element keyboard-reachable with a visible ring; tab crash is
contained by an error boundary that reports what failed instead of a blank
page; reduced-motion honored; tables keep real `<th scope>` headers.

## Voice

Lowercase, terse, factual — "34 sessions · updated 17:09 UTC", "no subagent
activity recorded". No exclamation, no emoji, no marketing tone.
