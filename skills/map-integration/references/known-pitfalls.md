# Known map bugs / pitfalls (fixed before — keep the guards)

Pitfall numbers stable — SKILL.md references them as `known-pitfalls.md #N`.

1. `Cannot read properties of undefined (reading 'featuresets')` — `queryRenderedFeatures` throws if style/layers not loaded. Guard every call:
   ```ts
   const queryFeatures = (point) => {
     try {
       const m: any = mapRef?.current
       if (!m || !m.isStyleLoaded?.()) return []
       return m.queryRenderedFeatures(point) || []
     } catch { return [] }
   }
   ```
   (Guard pattern reused across deck.gl-over-map components — apply same fix anywhere `queryRenderedFeatures` is called.)
2. mapbox-gl v3 transitive drift — pin `mapbox-gl@1.13.3` as explicit dep or alias to maplibre.
3. flyTo with invalid coords — validate lat/lon before dispatch + `flyTo({ center: [lon, lat] })`; **[lng, lat] order everywhere**.
4. Geolocation — shared validation helper for device position (auto-locate + current-location button share it); never trust raw `position.coords`.
5. Draw/edit polygon sync (MapboxDraw) — needs draw INSTANCE (#10a); sync = idempotent upsert (`_syncEditPolygon`) triggered by ALL of: draw instance appearing, `drawObj` changing, edit-mode enable transition. Never bare one-shot flag (kills later drawObj updates → stale polygon on next zone edit), never presence-check-only (re-adds after user deletes), never on-every-update (stacks `draw.update` listeners — remove-then-add or its own one-shot).
6. Geometry load for selected entity — staleness guard (cancelled flag / compare requested id) AND `.catch` clearing previous entity's geometry: late OR failed load must never leave entity A's polygon savable against entity B. Reset paths (clear polygon, hierarchy change) clear EVERYTHING derived: drawObj, geoJsonData, polygonData, centerPoint, loadedId.
7. Draggable marker without `dragend` capture — drag visually succeeds but parent state holds pre-drag coords; Save writes old location. Attach `marker.on('dragend', () => setState(marker.getLngLat()))` at EVERY creation site (click-placement + initial-data placement), or `draggable: false`.
8. Engine clear without state clear — `draw.delete`/trash + clear-draw handlers calling only `draw.deleteAll()` leave deleted shape in parent state: next submit silently re-saves it. Call parent setter (`setPolygon({})`) in same handler; compute WKT/geometry at submit time from current state — never cache in set-once variable (`&& !cached` guard freezes first shape forever).
9. react-bkoi-gl exports React components, not constructors — `new Map(...)`/`new Marker(...)` from `react-bkoi-gl` throw "not a constructor": every export named like an engine class (`Map`, `Marker`, `Popup`, `NavigationControl`, `FullscreenControl`) is a `React.FC`; only types + few utils (`getVersion`, `setWorkerUrl`, `LngLat`, …) re-exported. Imperative code (legacy class components, hand-built maps) must import vanilla `bkoi-gl` — switching a component between the two styles = rewrite, not import swap. Also: `MapRef` proxies engine methods but SKIPS `addSource/addLayer/removeSource/removeLayer/setFilter/setStyle…` — go through `mapRef.current.getMap()` for source/layer mutation.
10. DrawControl is callback-only (no instance) — react-bkoi-gl vendors `maplibre-gl-draw` INLINE in dist (not a dependency, not exported, no ref forwarding), so `draw.add/deleteAll/getAll/changeMode` unreachable through it. Two valid architectures:
    - (a) imperative: keep `@mapbox/mapbox-gl-draw`, get raw instance via `useControl(() => new MapboxDraw(...))` (hook IS exported, returns control). Required for #5 vertex-editing of preloaded geometry.
    - (b) pure wrapper: `<DrawControl onDrawCreate/onDrawUpdate/onDrawDelete>` (events deliver `e.features` — build FeatureCollection yourself, matching old `draw.getAll()` shape), clear by re-keying/remounting control, preload existing geometry as read-only `<Source>/<Layer>` preview user redraws over. Costs vertex-editing of existing shapes — upstream closed as "not planned"; this wrapper pattern = accepted answer. Make regression explicit to user; invisible in code review.
11. Draw toolbar CSS class mismatch — `@mapbox/mapbox-gl-draw` renders `mapboxgl-ctrl-*` DOM, its own CSS has ZERO base-control rules; `react-bkoi-gl/styles` covers `maplibregl-ctrl-*` + `.mapbox-gl-draw_*` buttons only. Old CDN `bkoi-gl.css` shipped `mapboxgl-*` aliases — removing CDN stylesheet blanks @mapbox draw toolbar (invisible buttons → "cannot draw"). Fix: compat CSS for `.mapboxgl-ctrl-group`, or wrapper's DrawControl (vendored buttons styled).
12. turf rejects degenerate rings — `centerOfMass`/`polygon()` throw `Each LinearRing of a Polygon must have 4 or more Positions` on real DB geometries; one bad zone crashes whole selection flow. Validate rings (≥4 positions) before turf, return undefined instead of throwing; never hand-turf pseudo-geometry built by flatMapping rings where polygons belong — works only until one ring is degenerate.
13. deck.gl has no per-layer `zIndex` prop — unknown props on Layer subclasses are silently inert (verified against `@deck.gl` typings; an inherited `zIndex: 110` on an IconLayer did nothing), so stacking is layers-array order ONLY. Corollary: restyle-on-selection (accessors keying stroke/radius off a selected datum) rebuilds buffers on every click and fights uniform-stroke designs — keep accessors constant and express selection as a DOM `<Marker>` overlay (SKILL.md §4 styled scatter markers).
