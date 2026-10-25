# shadcn/ui + Tailwind reference (frontend-design)

Sources: official skill github.com/shadcn-ui/ui/tree/main/skills/shadcn + ui.shadcn.com docs (MCP/preset machinery dropped — unsupported in this harness). Read when Stack Adaptation detects shadcn or Tailwind.

## Detection

- `components.json` in project root → shadcn project (read it: style, base color, aliases, registry config).
- Tailwind major: v4 = CSS-first (`@import "tailwindcss"` + `@theme` blocks in the stylesheet, no `tailwind.config.js` unless legacy); v3 = `tailwind.config`. Detect before adding utilities.

## CLI (use the project's package runner)

`npx shadcn@latest` / `pnpm dlx shadcn@latest` / `bunx --bun shadcn@latest` — match `packageManager` in `package.json`:

```bash
npx shadcn@latest info --json          # project context: config + installed components
npx shadcn@latest docs <component>     # per-component docs + examples
npx shadcn@latest add <component>      # add as source code into the project
```

Query before writing — the info JSON is the source of truth for what exists; prefer extending an installed component over hand-rolling a parallel one.

## Primitives layer (match what siblings import)

- `@base-ui-components/react` — Base UI, current default (Radix lineage; adds Combobox, Autocomplete, Number Field).
- `@radix-ui/*` — unified Radix package, still supported.
Never mix primitive layers in one component tree; new components use the layer the registry already uses.

## Composition rules

- `cn()` utility for class merging — never string-concat conditionals.
- Extract repeated utility patterns into components, not custom CSS.
- Tailwind spacing scale for consistency; extend theme via project tokens (`@theme` v4 / config v3), not arbitrary values.

## Hard rules (official skill)

- `TabsTrigger` must be inside `TabsList` — never render triggers directly in `Tabs`.
- `Avatar` always needs `AvatarFallback` (image load failure).
- Extend the existing registry + tokens (`registry:base` design systems ship components, CSS vars, fonts) — reuse, do not fork a hand-rolled system beside it.

## Source repos (complex cases)

Local clones: `git/ui` (shadcn source, official skill under `skills/shadcn/`) and `git/tailwindcss` (framework source + docs). Subtle behavior (variant composition, @theme interaction, registry payloads) → search the clones instead of guessing.
