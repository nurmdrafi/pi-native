# Engine migration — react-map-gl / mapbox-gl / CDN bkoi-gl → react-bkoi-gl

Recipe from a completed sibling-dashboard migration (react-bkoi-gl 3.1.0, MapLibre v6 engine).
Grounded in the wrapper's shipped dist, not docs claims.

**Contents** — §0 ground rules · §1 phase order · §2 import swap · §3 draw migration · §4 style switcher · §5 CSS prefix port · §6 legacy CDN class rewrite · §7 deck overlays · §8 verification

## 0. Ground rules (verified against dist)

- Export surface: React components (`Map`, `Marker`, `Popup`, `Source`, `Layer`, all controls incl. `DrawControl`/`AttributionControl`, `MapProvider`), hooks (`useMap`, `useControl`), types (`MapRef`, `MarkerDragEvent`, `ViewState`, style specs), engine utils (`LngLat`, `LngLatBounds`, `getVersion`, `setWorkerUrl`/`getWorkerUrl`, `GPUInitializationError`). Engine constructors are NOT exported — [known-pitfalls.md](known-pitfalls.md) #9.
- `MapRef` proxies engine methods but SKIPS `setStyle`, `addSource/addLayer/removeSource/removeLayer`, `setFilter`, paint/layout setters — call `mapRef.current.getMap().setStyle(...)` etc.
- The wrapper vendors its draw engine inline but keeps `mapbox-gl-draw-hot`/`-cold` SOURCE ids — click-guards keyed on those strings survive the migration unchanged.
- Engine DOM classes are `maplibregl-*`. One CSS import per map entry component: `import 'react-bkoi-gl/styles'`.

## 1. Phase order (verify each before the next)

1. Mechanical import swap on React-component map files (§2) + styles import → app boots, map renders.
2. CSS prefix port in global stylesheets (§5) → footer logo/attribution render correctly.
3. Draw migration (§3) → draw/delete/edit flows work.
4. Style switcher replacement (§4).
5. Legacy CDN class-component rewrite (§6) → remove CDN script + global type decl.
6. Full verification pass (§8).

## 2. Import swap — React-component consumers

Same react-map-gl API family; a sed-level change:

```tsx
// before
import { Map, Marker, Popup, Source, Layer, useMap, useControl,
         FullscreenControl, NavigationControl, AttributionControl } from 'react-map-gl'
import type { MapRef, MarkerDragEvent } from 'react-map-gl'

// after
import { Map, Marker, Popup, Source, Layer, useMap, useControl,
         FullscreenControl, NavigationControl, AttributionControl } from 'react-bkoi-gl'
import type { MapRef, MarkerDragEvent } from 'react-bkoi-gl'
import 'react-bkoi-gl/styles'
```

`mapStyle`, `initialViewState`, `onClick`/`e.lngLat`, control `position` props are unchanged.

## 3. Draw migration

Pick per [known-pitfalls.md](known-pitfalls.md) #10: (a) keep `@mapbox/mapbox-gl-draw` + `useControl` when imperative instance access is required (vertex-editing preloaded geometry, #5); (b) wrapper's callback-only `DrawControl` otherwise. The sibling chose (b) and dropped the `@mapbox/*` deps entirely:

```tsx
// Callback-only DrawControl + re-key remount = instance-free deleteAll()
const DrawController = ({ isClearDraw, setIsClearDraw, setPolygon }) => {
  const [resetKey, setResetKey] = useState(0)

  const handleDrawn = (e) =>                    // events carry e.features —
    setPolygon({ type: 'FeatureCollection', features: e?.features ?? [] }) // == draw.getAll()

  const handleDelete = () => {                  // trash button: wipe editor + parent state (#8)
    setPolygon({})
    setIsClearDraw(false)
    setResetKey(k => k + 1)
  }

  useEffect(() => {                            // external "clear draw" trigger
    if (isClearDraw) handleDelete()
  }, [isClearDraw])

  return (
    <DrawControl
      key={resetKey}                           // remount = clear; control stays mountable again
      displayControlsDefault={false}
      controls={{ polygon: true, trash: true }}
      onDrawCreate={handleDrawn}
      onDrawUpdate={handleDrawn}
      onDrawDelete={handleDelete}
    />
  )
}
```

Existing-geometry editing (old `draw.add(feature)` + direct_select) is NOT reachable through the wrapper (#10, upstream "not planned"). Replacement: read-only `<Source>/<Layer>` preview + a vertex editor over it — outer ring as state, map `pointerdown/move/up` dragging a selected vertex, publish on drag end, sync (and reset) from the incoming geometry prop (#6). Make the lost direct-select UX explicit to the user — invisible in code review.

## 4. Style switcher replacement — faithful port, not a redesign

`mapbox-gl-style-switcher` is a mapbox-gl-1.x plugin; its control DOM/styles no longer resolve under the v6 engine. Replace it with a port of the plugin's OWN control — same DOM, same open/close behaviour, same CSS, only the class prefix changes. Users verify migrations by pixel-parity of existing controls; a redesign (Dropdown + hover popover, moved corner) reads as a regression even when it works. Ground truth for the port: the plugin's dist source + styles.css, still in `node_modules` until the dep is removed.

UX contract to preserve (all of it): registered via `useControl(..., { position })` in the same corner as before; click-to-open (button hides, list shows), click a style to switch, any document click outside closes — hover never opens it; the list renders INSIDE the ctrl-group container below the button (right-aligned 14px items, bold active, 1px separators — the control box grows into the menu); layers icon = the plugin's base64 SVG as `background-image`.

```tsx
class StyleSwitcherControl {           // satisfies MapControl structurally (onAdd/onRemove)
  constructor(styles, { defaultStyle, onSelect }) {
    this.container = document.createElement('div')
    this.container.classList.add('maplibregl-ctrl', 'maplibregl-ctrl-group')
    this.list = document.createElement('div')   // display:none via CSS, shown on open
    this.list.classList.add('maplibregl-style-list')
    for (const s of styles) {
      const item = document.createElement('button')
      item.type = 'button'
      item.innerText = s.title
      item.classList.add(s.title.replace(/[^a-z0-9-]/gi, '_'))
      if (s.title === defaultStyle) item.classList.add('active')
      item.addEventListener('click', () => {
        if (item.classList.contains('active')) return
        onSelect(s.uri)   // parent: mapRef?.getMap().setStyle(uri) — setStyle skipped on MapRef (§0)
        this.list.querySelectorAll('.active').forEach((el) => el.classList.remove('active'))
        item.classList.add('active')
        this.close()
      })
      this.list.appendChild(item)
    }
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.classList.add('maplibregl-ctrl-icon', 'maplibregl-style-switcher') // icon via CSS
    this.button.addEventListener('click', () => this.open())
    this.onDocumentClick = (e) => { if (!this.container.contains(e.target)) this.close() }
    document.addEventListener('click', this.onDocumentClick)
    this.container.append(this.button, this.list)
  }
  onAdd() { return this.container }
  onRemove() { document.removeEventListener('click', this.onDocumentClick); this.container.remove() }
  open() { this.button.style.display = 'none'; this.list.style.display = 'block' }
  close() { this.list.style.display = 'none'; this.button.style.display = 'block' }
}

const StyleControl = () => {
  const { current: mapRef } = useMap()            // useMap() returns { current }
  useControl(
    () => new StyleSwitcherControl(MAP.STYLES, {
      defaultStyle: MAP.STYLES[0].title,
      onSelect: (uri) => mapRef?.getMap().setStyle(uri),
    }),
    { position: 'bottom-right' },                 // same corner the old wrapper used
  )
  return null
}
```

Port its styles.css 1:1 with the prefix swap (right-aligned 14px items, `padding: 8px 8px 6px`, bold `.active`, `rgba(0,0,0,0.05)` hover, `button + button` 1px `#ddd` separator, `.maplibregl-style-switcher` icon `background-size: 70%`). Then remove the dead plugin dep from package.json.

## 5. CSS prefix port — the silent breaker

Engine swap flips DOM classes `.mapboxgl-*` → `.maplibregl-*`; every custom override keyed on the old prefix silently stops matching. No error, no warning — the UI just degrades. Port these (names verified in the shipped stylesheet):

| old selector | new selector |
| --- | --- |
| `.mapboxgl-canvas` | `.maplibregl-canvas` |
| `.mapboxgl-popup-content` | `.maplibregl-popup-content` |
| `.mapboxgl-ctrl-bottom-left/right` | `.maplibregl-ctrl-bottom-left/right` |
| `.mapboxgl-ctrl-attrib`, `-inner` | `.maplibregl-ctrl-attrib`, `-inner` (also `-button`) |

Typical casualty: the "attribution-as-logo" hack that renders the vendor logo bottom-left by hiding the inner links and drawing a base64 image — after migration the logo dies and raw attribution text floods the bottom bar on both corners. Port and verify visually (§8):

```css
.maplibregl-ctrl-attrib { background: transparent !important; }
.maplibregl-ctrl-attrib-inner {
  width: 50px; height: 30px; display: block; background: transparent;
}
.maplibregl-ctrl-attrib-inner a { display: none; }
.maplibregl-ctrl-attrib-inner::after {
  content: url('<vendor-logo>'); /* same base64 blob as before, only selectors changed */
  transform: scale(.52);
}
```

Also port draw-toolbar overrides — but note [known-pitfalls.md](known-pitfalls.md) #11 first: base-control styling now comes from `react-bkoi-gl/styles`.

The rename hits every string keyed on DOM classes, not only stylesheets: e2e locators (`canvas.mapboxgl-canvas`, `.mapboxgl-map`, `.mapboxgl-marker`), marker `className`s, imperative `querySelector`s. Sweep `rg "mapboxgl-"` repo-wide — tests included (#17) — then drop the dead plugin deps.

## 6. Legacy CDN class component rewrite

Older forks load the engine from a CDN script and build maps imperatively in class components (`window.<engine>.Map({ container, ... })`, `addControl`, draw instance in state). Under react-bkoi-gl that code cannot survive as an import swap (#9). Rewrite as the React component, keeping the PROPS contract identical so consumer components are untouched:

- `new window.<engine>.Map({...})` → `<Map ref={mapRef} mapStyle={...} initialViewState={...} />`; `componentWillUnmount` → `useEffect` cleanup.
- Manual resize observers → `useEffect(() => { mapRef.current?.resize() }, [layoutDep])`.
- Raw draw instance → §3 DrawController + vertex editor.
- Delete from `_document`: the CDN `<Script src>` + its `<link rel="stylesheet">`; delete the `window.<engine>: any` global type decl.

## 7. deck.gl overlays

`@deck.gl/mapbox`'s `MapboxOverlay` keeps working — register it with `useControl` imported from react-bkoi-gl; deck 8.9 renders fine over the v6 engine. A deck 8→9 upgrade (sibling runs 9.1.9) is a separate change with its own API deltas — never bundle it into this migration.

## 8. Verification loop

Per phase: scoped lint + typecheck + offline unit tests, then a headless-browser probe (login via API → token to localStorage → open a map route → wait for `.maplibregl-canvas` → screenshot the bottom-left/right corners + exercise the phase's flow: draw a polygon, switch styles). Attribution/logo/draw toolbar breakage is visual — DOM asserts miss it; screenshot both corners every phase. When a control was replaced (§4), screenshot it against the pre-migration original — same corner, same open/close behaviour, same list layout; pixel parity of existing controls is the acceptance bar users apply. CDP-attached e2e suites against the developer's Chrome run last, by hand.
