---
name: frontend-design
description: "Build NEW web components/pages/apps from scratch. Detects UI stack (Ant Design, shadcn/Tailwind, vanilla), audits sibling components + tokens, extends established idioms. NOT editing/fixing/polishing existing UI (→ refactoring-ui) or logic-only changes with no new markup."
license: Complete terms in LICENSE.txt
disable-model-invocation: true
---

Build distinctive, production-grade frontend interfaces; avoid generic "AI slop" aesthetics. Real working code, exceptional attention to aesthetic detail + creative choices.

Input: frontend requirements — component/page/app/interface; maybe purpose, audience, constraints.

Scope steering: `/skill:frontend-design antd` / `shadcn` / `greenfield` — read only the matching reference.

## Pattern Audit (MANDATORY FIRST — overrides every aesthetic directive below)

Before any UI: **extending** existing design system or **creating from scratch**? Existing codebase → ALWAYS extending.

1. Read closest siblings first: 2–3 existing components/pages nearest to target (`rg -l` similar names, then `read`). Note exact structure, classes, props, spacing, primitive composition.
2. Extract design language:
   - Theme/tokens: AntD `ConfigProvider` `theme`/`token` (v5; v6 = CSS variables on by default) or less variables (v4); Tailwind v4 `@theme` block in CSS (CSS-first, no config file) vs v3 `tailwind.config`; global CSS `:root` vars; design-system package exports.
   - Spacing/layout scale
   - Color palette + semantic mapping (bg/text/border/states)
   - Radius
   - Shadows/elevation
   - Typography stack (families, sizes, weights, line-heights)
   - Motion
3. Sibling gaps = design opportunities, not permission to fork idioms.

## Stack Adaptation (part of Pattern Audit)

Detect UI stack from `package.json` + existing components; express design through that stack's idioms — never impose foreign style system. Read the matching reference BEFORE writing component code:

- **Ant Design**: `references/ant-design.md` — version matrix (v4/v5/v6), CLI-first API lookup (`npx @ant-design/cli info`), theming ladder, form/table logic guards, v6 renames.
- **shadcn/ui + Tailwind**: `references/shadcn-tailwind.md` — `components.json` detection, project context via CLI, Base UI vs Radix primitives, Tailwind v3/v4 token detection, composition rules.
- **Vanilla/other**: no established idioms → full aesthetic freedom below.
- Mixed stacks: read both references; check Tailwind reset against AntD styles before mixing.
- Existing-UI polish/audit/critique (not new build) → impeccable skill: `/skill:impeccable <command>`; full source clone `git/impeccable`.

Match existing patterns before introducing new ones. New framework = new file under `references/` + one router row here.

### Logic guards (new UI mutating data)

- Mutating routes/admin panels: permission gating from day one.
- Fetch-on-selection effects: staleness guard + `.catch` + clear list while refetching (out-of-order responses never repaint old entity's data).
- Bulk-edit forms: open empty or track touched fields — pre-filled field makes every `values.x ?? o.x` fallback dead code.
- Conditional visibility: check polarity + DEFAULT state of every span/collapse condition before shipping.
- Framework-specific guards (AntD forms/tabs/tables): `references/ant-design.md`.

### Runtime robustness + errors (new UI ships this)

- Error boundaries wrap the page + major subtrees — one thrown panel must not blank the app.
- Every async surface: loading/empty/error states; a failed poll keeps the last good view.
- Non-2xx = error, not data: reject, set timeouts, surface the failure; never a silent empty state. Failures also arrive resolved (data layers return `{error}` instead of rejecting) — branch on the error field before the empty check, or a 500 renders as "No data found".
- Validate/parse API values pre-use — nullable/string numbers hitting `.toFixed`/`.map`/`.charAt` blank the UI.
- No success toast/modal close on a failed mutation; reset prior entity state on selection change.
- One owner per failure: a single global layer catches/normalizes/logs/decides — components don't each re-handle (no duplicate toasts/logs/sign-outs). Mark a failure as surfaced the moment it toasts (identity on the error object) so no layer repeats it; local handlers add context only when the owner stayed silent. Cancellation — unmount, superseded request, client timeout — is not a failure: no toast.
- Handlers at every level: process (`window.onerror`, `unhandledrejection`), router/app error page, component boundaries, data layer (one API interceptor).
- Classify every status/kind, never one generic message: network/timeout, 400/422 validation, 401 auth, 403 permission, 404 missing, 409 conflict, 429 throttle, 5xx server — each → user message + recovery action. Prefer the backend's own message; frontend text is fallback — a hardcoded guess (fixed "already exists" on any 500) lies to the user.
- Never swallow: no empty `catch`, no `console.error` stripped in prod.
- Retry only transient failures, with backoff — never infinite, never deterministic.
- Fallback UI: error page/boundary with reset/retry; keep the last good view.
- Full failure-UX architecture (transport-owned toasts, message precedence, single-toast dedupe): `references/error-ux.md`.

## Design Thinking (GREENFIELD ONLY — skip if Pattern Audit found existing UI)

Direction depth: `references/design-language.md` (persona, hero, typography discipline, structural devices, empty/error voice).

Before coding greenfield:
- Purpose: what problem, who uses it?
- Tone: pick an extreme: brutally minimal, maximalist chaos, retro-futuristic, organic, luxury/refined, playful, editorial, brutalist, art deco, soft/pastel, industrial. Inspirations only; design true to one direction.
- Constraints: framework, performance, accessibility.
- Differentiation: what makes this UNFORGETTABLE? The one memorable thing?

Commit to clear conceptual direction, execute with precision. Bold maximalism + refined minimalism both work — key = intentionality, not intensity.

Implementation (HTML/CSS/JS, React, Vue, …): production-grade, functional, visually striking, cohesive point-of-view, meticulous detail.

## Aesthetics Guidelines

- Typography: beautiful, unique, interesting fonts. Avoid Arial/Inter/generics; distinctive characterful choices elevating aesthetics. Pair distinctive display font + refined body font. One or two families only; type treatment as active design element; line length < 80 chars.
- Hero = the most characteristic thing in the subject's world; big-number-plus-gradient default only when truly best.
- Structural devices (numbering, eyebrows, dividers) encode real information — numbered markers only for actual sequences.
- Color/theme: cohesive aesthetic, CSS variables. Dominant colors + sharp accents > timid even palettes.
- Motion: animations + micro-interactions; CSS-only for HTML, Motion library for React when available. One orchestrated page load with staggered reveals > scattered micro-interactions.
- Spatial composition: unexpected layouts, asymmetry, overlap, diagonal flow, grid-breaking, generous negative space OR controlled density.
- Backgrounds/details: atmosphere + depth, not default solid colors. Contextual effects/textures matching aesthetic: gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, grain overlays.
- Empty/error states: direction, not mood — interface voice, what happened + recovery action.

NEVER generic AI aesthetics: overused fonts (Inter, Roboto, Arial, system), clichéd schemes (purple gradients on white), predictable layouts, cookie-cutter design lacking context character.

Interpret creatively, unexpected context-designed choices. No two designs same. Vary light/dark themes, fonts, aesthetics. NEVER converge on common choices (Space Grotesk) across generations.

Match implementation complexity to vision: maximalist = elaborate code, extensive animations/effects; minimalist = restraint, precision, spacing/typography/subtle detail. Elegance = executing vision well.

Don't hold back — commit fully to distinctive vision.
