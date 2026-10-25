# Ant Design reference (frontend-design)

Sources: official skill github.com/ant-design/antd-skill + ant.design v5→v6 migration guide. Read when Stack Adaptation detects Ant Design.

## Version matrix

- v6: CSS variables on by default (modern browsers only, no IE), React ≥ 18, Semantic DOM on all components, v4-era deprecated APIs retired.
- v5: `ConfigProvider` theme algorithm; `cssVar` opt-in via `theme={{ cssVar: true }}`.
- v4: less variables theming.
Match the installed major — check `package.json` before writing.

## API lookup before writing (official rule)

Do not rely on memory for component props — query first, offline, via `@ant-design/cli`:

```bash
npx @ant-design/cli info <Component> --format json   # props/API, always --format json
npx @ant-design/cli demo <Component>                  # working baseline
npx @ant-design/cli token                             # theming token lookup
npx @ant-design/cli semantic                          # semantic styling hooks
npx @ant-design/cli doctor                            # project checks; also lint, migrate
```

Version-sensitive: `--version <x.y.z>` or auto-detect from local `node_modules`. CLI absent → official docs (antd documents every component); never undocumented APIs or internal `.ant-*` class coupling.

## Theming ladder (strict order)

1. Global tokens (`ConfigProvider` `theme.token`)
2. Component tokens (`theme.components.<Component>`)
3. Semantic slots (`classNames`/`styles` per DOM part — v6 Semantic DOM)

Avoid global CSS overrides. One root `ConfigProvider` unless strict isolation required; SSR adds `StyleProvider`.

## v6 renames (write v6 idioms in v6 projects)

`size="default"` → `size="medium"`; `direction` → `orientation`; `progressDot` → `type="dot"`; `labelPlacement` → `titlePlacement`; Statistic `valueStyle` → `styles.content`; Progress `trailColor` → `railColor`.

## Logic guards (AntD forms + tables)

- Edit forms: `initialValues` bind only at Form mount — fetch-then-fill needs remount gate (loading spinner) or `form.setFieldsValue`; display-only `defaultValue` in `Form.Item` leaves store empty, submits placeholder garbage (`moment(undefined)` formats as today).
- Prefill into lazy tab panes (rc-tabs): `forceRender: true` or fill on activation, else first `setFieldsValue` silently dropped.
- Table pagination — controlled means ALL of it together: `current` + `pageSize` as state + `onChange(page, pageSize)` setting both. Wiring only `current` while hardcoding `pageSize` silently ignores the size changer (looks broken/uncontrolled). Server-side tables: reset `page` to 1 whenever a filter/refresh replaces the dataset. Client-side tables: antd v4 keeps internal/controlled `current` when `dataSource` is replaced — no clamp — so shorter refetched data lands on an empty out-of-range page; reset to 1 on dataset change (effect or at fetch site).

## Mixed stack (AntD + Tailwind in one project)

Check Tailwind reset/preflight against AntD component styles before mixing utilities into AntD markup — antd documents the compatibility fix; apply it, don't fight symptoms with utility overrides.

## Source repo (complex cases)

Local clone: `git/ant-design` — component sources + docs. When behavior is subtle or version-specific (v6 Semantic DOM slots, token inheritance), search the clone (`rg` in `components/<Component>/` + `docs/`) instead of guessing.
