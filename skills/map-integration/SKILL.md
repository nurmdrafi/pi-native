---
name: map-integration
description: "ANY map work, Barikoi stack included: react-bkoi-gl / bkoi-gl (Barikoi's maplibre wrappers), maplibre-gl/mapbox-gl and react-map-gl-family wrappers, deck.gl overlays, turf geometry, draw polygons/polylines, camera flyTo/fitBounds, geolocation, MQTT real-time plotting, GPX routes, snap-to-road (OSRM), boundary layers, Barikoi map styles and barikoi.xyz APIs, map bugs (style-load, marker drift), map key leaks (api key in client bundle, hardcoded barikoi key, key shipped to browser). Detects stack from package.json; reuses existing idioms."
disable-model-invocation: true
---

# Map Integration

## 1. Detect stack first — never assume

Check project `package.json`, bundler aliases, existing map components before writing anything. Stack families in this workspace:

- `react-bkoi-gl` (current gen — Barikoi's React wrapper): react-map-gl-style API (`Map`, `useMap`, `useControl`, `Source`/`Layer`) + `DrawControl` (draw built in — but callback-only, `references/known-pitfalls.md` #10), `MinimapControl`/`Minimap`, `GlobeControl`, `TerrainControl`, `LogoControl`, `CanvasSource`. Engine (`maplibre-gl@6`) ships as own dep — import everything from `react-bkoi-gl`, never `maplibre-gl` directly; engine utils re-exported. **Its `Map`/`Marker`/`Popup`/controls are React components — engine constructors NOT exported** (`references/known-pitfalls.md` #9), so imperative code (`new Map(...)`, `marker.on('dragend')`) can't run on it. CSS: `import "react-bkoi-gl/styles"`.
- `bkoi-gl` (vanilla JS — Barikoi's MapLibre v6 build): engine constructors live here (`Map` with `BkoiMapOptions` incl. `accessToken`/`style`). Bundles engine + self-contained worker (no maplibre install, no worker hosting); `bkoi-gl/worker` only for strict-CSP apps. CSS: `bkoi-gl/style.css`. React apps prefer `react-bkoi-gl` — but legacy imperative components (class components hand-building maps) need this package. `bkoi-gl-js` = CDN dist name (`cdn.barikoi.com/bkoi-gl-js/...`), NOT npm; npm name `bkoi-gl`.
- Legacy: `react-map-gl` + `maplibre-gl` / `mapbox-gl` (some pin `mapbox-gl@1.13.3` or alias `mapbox-gl → maplibre-gl`). Same react-map-gl API surface.
- `@deck.gl/*` (overlays), `@turf/turf` (geometry), `@mapbox/mapbox-gl-draw` (editing), `mqtt`/`socket.io-client` (real-time), `geo-polyline-tools` (route polylines).

Sibling dashboards = forks of one shared template — before writing new map code, `rg` nearest sibling for existing idiom.

Never let `mapbox-gl` drift to v3 via transitive deps — v3 demands Mapbox token, breaks custom/self-hosted styles.

## 2. Developing a map wrapper library itself

- Engine majors (e.g. maplibre v5→v6) break as **silent render failures** (worker resolution), not type errors — consult engine's migration guide, run README-matrix e2e first for fastest contract-breakage signal. (bkoi-gl 4.x + react-bkoi-gl 3.x already on MapLibre v6 — the worker break is why bkoi-gl bundles a self-contained worker.)
- Consumers never import engine directly (transitive deps don't resolve under pnpm strict layout or yarn PnP): re-export engine utils (`setWorkerUrl`, `getWorkerUrl`, `getVersion`, `GPUInitializationError`) from wrapper.
- Package surface: `exports` = `.` (import/require + types), `./styles` or `./style.css`, `./worker` (if shipped); peer deps `react`/`react-dom` across supported React majors. Both current packages match.
- Framework suite: real repro apps (Vite, Next.js both bundler modes, CRA…) each installing **packed tarball, never link**; headless runs assert actual rendering (engine `load` + `idle`, zero uncaught errors). Full library pipeline: sdk-development skill (test pyramid, pack smoke, docs-as-contract).
- Wrapper bug guards (fixed once — keep pattern): strip wrapper-only props (`position`, `style`) before constructing engine controls — leaked wrapper prop makes engine validation silently reject every toggle. `<Marker>` with popup-only child keeps default pin.

## 3. Base map

- `react-map-gl`-family API: `<Map>`, `useMap()`, `useControl()`, `MapRef`, `Source`/`Layer`.
- Auth/config via env vars: map style token, routing API key (separate keys per service). Check project `.env*` for naming convention; never introduce provider token project doesn't use.

### Barikoi styles + keys

- Style URL: `https://map.barikoi.com/styles/{name}/style.json?key=$BARIKOI_API_KEY` — key rides as `?key=` query param. Only key channel under react-bkoi-gl (its MapProps has no accessToken field — stock maplibre-gl dep; bkoi-gl's engine Map does accept accessToken). Styles in use: `osm-liberty` (default), `osm_barikoi_v1`, `planet_map`, `barikoi-light`, `barikoi-dark`, `barikoi-dark-mode`. Served by self-hosted `tileserver-gl` (barikoi/tileserver-gl).
- Style switching: `mapbox-gl-style-switcher` (`MapboxStyleSwitcherControl(styles, { defaultStyle: 'OSM Liberty' })`) mounted via `useControl`, usually wrapped in `StyleControl`; style list in `App.config`/`app.config` (`MAP.STYLES`).
- Search/geocode/routing/geofence APIs: base `https://barikoi.xyz`, same key (endpoint spec: `barikoiapis/openapi/barikoi-api-spec.yaml`). Docs: docs.barikoi.com; keys: developer.barikoi.com.

## 4. deck.gl overlays (established pattern)

Typical overlay component (search repo for existing one, match shape):

```tsx
import { MapboxOverlay, MapboxOverlayProps } from '@deck.gl/mapbox'
import { IconLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers/typed'
import { PathStyleExtension } from '@deck.gl/extensions/typed'
import { useControl } from 'react-map-gl'

const DeckGLOverlay = (props: MapboxOverlayProps) => {
  const overlay = useControl(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}
```

- Paths: `PathLayer` + `PathStyleExtension({ dashed })`. Markers: `IconLayer`/`ScatterplotLayer`.
- Performance: never `setState` inside `onHover`/view-state callbacks — fire per frame, rerender tree; throttle (dashboards use `useThrottle(popupData, 250)`).
- Recreating layer instances per render fine (deck diffs props); appending live data must not rebuild whole buffer — append into stable structure or one layer per chunk.
- Reuse existing layers (marker/trace/boundary) before writing new — search repo's layer components first.
- Dashboards share one template: `components/Map/DeckGLMap.jsx` (Map shell, `MAP.STYLES[0]`, throttled tooltip) + `OverLayers.jsx` (DeckGLOverlay above — `useControl` from `react-bkoi-gl`) + `Map/Layers/` composite layer classes (`TraceLayer`, `RouteLayer`…), all fed from Redux slice. Before writing new: diff sibling dashboard — forks of same shape.

## 5. Known map bugs / pitfalls (fixed before — keep guards)

Twelve numbered guards in `references/known-pitfalls.md` — cited as `known-pitfalls.md #N` elsewhere. Covers: queryRenderedFeatures guards, mapbox-gl v3 drift, [lng, lat] order, geolocation validation, draw/polygon sync, geometry staleness, marker `dragend` capture, engine-clear-vs-state-clear, react-bkoi-gl component-vs-constructor exports, DrawControl callback-only architectures, draw-toolbar CSS mismatch, degenerate turf rings.

## 6. Camera idioms

- `mapRef.current?.flyTo({ center: [lon, lat], zoom })` after marker set/selection.
- `fitBounds` for multiple markers — reuse existing map-bounds util if project has one.
- Redux/store-driven map state: selection, route mode, playback live in store slice — map components subscribe, don't duplicate local state.

## 7. Real-time plotting (MQTT / WebSocket)

Established pattern in `references/realtime-plotting.md`: buffer + batch, LRU-cap markers, subscription guards, auth-teardown flush, one config source for broker opts — reference now carries working code shapes (connection hook, batch buffer, store merge, deck overlay).

## 8. GPX / route utilities (reuse, don't rewrite)

Search repo for existing route utils first — mature map projects typically have: route flattening (LineString + MultiLineString, dropping duplicate points so cumulative distance stays monotonic), traveled-slice (polyline up to km), route-head projection (position + heading along route), diverged-segment detection (live vs planned drift). Simplify/distance helpers usually alongside.

Route modes: live / planned / compare, + playback with speed control (state in map store slice).

Optimized routes: call through server-side API proxy — routing API key out of browser.

## 9. Snap-to-road (OSRM)

- Typical flow: track endpoint with `snap_to_road=true` → track/route service → OSRM matching service. Project has OSRM integration → reuse its service module, never call OSRM from browser.
- OSRM server-side — no CORS concern, no browser key.
- Frontend just re-renders polyline when snap toggle changes.

## 10. Env vars

Read project `.env*` for actual names — don't invent. Common shapes: map style token (`NEXT_PUBLIC_MAP_API_ACCESS_TOKEN` / `VITE_MAP_API_ACCESS_TOKEN`), MQTT broker host/port/protocol + auth username/password, routing API key (separate from map token). Barikoi names in use: `BARIKOI_API_KEY` (dominant), `BARIKOI_STYLE_URL`, `BARIKOI_GL_TOKEN`, `BARIKOI_API`/`BARIKOI_API_ENDPOINT`, `NEXT_PUBLIC_MAP_BASE_URL`; legacy mapbox-era: `NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN`.

Browser-visible credentials = public by definition: style key rides in style URL, MQTT creds in wss connection. Consequences: restrict keys by allowed origin in developer dashboard, one key per app/service, privileged keys (routing, geofence CRUD) server-side behind app's proxy. Restrictive-CSP deployments need real worker URL, not blob: — that's what `./worker` exports are for (§1).

## 11. CI for dashboard family (solved once — keep pattern)

Shared Production/Staging/Review workflow family across dashboards hardened once; never reintroduce fixed patterns:

- Secrets reach steps via `with:` only, never workflow-level `env:` — workflow-level env exposes them to every step incl. third-party webhook/release actions.
- Third-party actions + reusable workflows pinned to full commit SHAs (tag as comment), not mutable tags.
- `permissions: contents: read` workflow level; `contents: write` only to release step needing it.

Beyond this shape → github-actions skill (SHA pinning, least-privilege permissions, secret scoping, actionlint).

## Checklist before writing map code

Realtime & render prevention (from the repo review audit):

- Rebuild layers/scenes on upstream data change — not on hover/zoom/tick; one client per connection; reconnect only on real change; no duplicate clients; reset stale state on re-join.
- Heavy math off the main thread; no O(N²) scans or pagination; scope selectors/hooks.
- Time/environment-dependent features work outside the happy window (off-hours, offline, reconnects).

- Equivalent Layer/hook/util exists in this repo (or sibling/fork)? Reuse first — sibling dashboards = forks of same template.
- Barikoi repos: import map code from `react-bkoi-gl`/`bkoi-gl` only (never `maplibre-gl` directly); style key in `?key=` query param; check sibling dashboard's DeckGLMap template before starting fresh.
- Coord order `[lng, lat]`. Validate before flyTo/bounds.
- Guard `queryRenderedFeatures` / any style-dependent call.
- Real-time: batch messages, LRU-cap markers, guard subscriptions, cleanup on unmount.
- Shared map state in store slice — map components subscribe, don't own.
- Map wrapper library work: framework apps install fresh packed tarball (never link); every README claim covered by e2e case; engine majors = silent render failures — run README matrix first.
- Draw/edit flows: idempotent polygon-sync upsert covering all three triggers (`known-pitfalls.md` #5); guarded geometry loads with failure-path clearing (#6); resets touch every derived field; markers capture `dragend`, draw-clears propagate to parent state (#7–8).
- CI touched: secrets step-scoped, actions SHA-pinned, least-privilege permissions (§11).
- No provider key literal in source or bundled config (`app.config.ts` etc.) — keys ride env vars; anything `NEXT_PUBLIC_*` or client-imported = public by definition. Server-side Barikoi/routing calls via API proxy, never client-held key.
- Layers/scenes rebuild on data/selection change, not hover/zoom/tick; heavy math off main thread; no O(N²) scans or pagination.
