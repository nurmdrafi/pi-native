# Composite-layer performance (deck.gl)

Patterns from a performance pass over composite layers fed by national-scale
marker loads. One goal: rebuilding the layer stack (hover, zoom, selection,
live batch) must NOT invalidate attribute buffers. Search keys: `updateState`.

1. Module-level stable accessors — an accessor declared inline (`getPosition`,
   `getPath`, `getIcon`) gets a fresh identity on every rebuild; deck.gl reads
   that as an attribute change and recomputes it per row. Hoist accessors,
   constant prop values, and extension instances to module scope.

```ts
// Shared position accessor: stable identity so rebuilding the layer stack
// on unrelated updates (hover, zoom, trace batches) does not invalidate
// position attributes and recompute them.
const getOutletPosition = (info: DataType): [number, number] =>
  info ? [+info.longitude, +info.latitude] : [90.3938010872331, 23.821600277500405]

// Owner overlay: PathLayer accessors and the extension instance too.
const getRoutePath = (info: any): any => info.geometry.coordinates
const ROUTE_DASH_EXTENSION = new PathStyleExtension({ dash: true })
```

2. `updateState` cache: viewport-filtered rows — derived data handed to
   sub-layers belongs in layer state keyed on prop identity, not recomputed in
   `renderLayers`. `null` bounds renders all rows; identical bounds keeps the
   array identity; ~1km padding (`VIEWPORT_PADDING = 0.01` degrees) so rows
   don't pop on a one-pixel pan. Filtering inside the layer means a pan
   changes only this layer's own data — the stack is not rebuilt.

```ts
export const filterRowsByViewport = (rows: any[], bounds: ViewportBounds): any[] => {
  if (!bounds) return rows

  const [sw, ne] = bounds
  const minLng = sw[0] - VIEWPORT_PADDING
  const maxLng = ne[0] + VIEWPORT_PADDING
  const minLat = sw[1] - VIEWPORT_PADDING
  const maxLat = ne[1] + VIEWPORT_PADDING

  return rows.filter((row: DataType) => {
    const lng = Number(row[4])
    const lat = Number(row[3])
    return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat
  })
}

updateState(params: UpdateParameters<MultiOutletLayer>): void {
  super.updateState(params)
  const { props, oldProps } = params
  if (
    props.multiGeoOutlets !== oldProps.multiGeoOutlets ||
    props.viewportBounds !== oldProps.viewportBounds
  ) {
    this.setState({
      visibleRows: filterRowsByViewport(props.multiGeoOutlets?.rows ?? [], props.viewportBounds),
    })
  }
}
// renderLayers reads state.visibleRows ?? multiGeoOutlets?.rows ?? []
```

3. `updateState` cache: selected-entity subsets — filtering rows by a
   selection list via `Array.includes` is O(rows × selection); a `Set` keyed
   on the join field is O(rows). Cache it keyed on data + selection identity
   (same `props.x !== oldProps.x` guard as above) so unrelated rebuilds reuse
   the same reference.

```ts
// inside updateState, guarded on props.srUsers/props.selectedSR identity:
const selectedSrIds = new Set((props.selectedSR ?? []).map((sr: any) => sr.sr_id))
this.setState({
  visibleUsers: (props.srUsers ?? []).filter(
    (user: TraceUserType) => user?.sr_id && selectedSrIds.has(user.sr_id),
  ),
})
// renderLayers: const data = visibleUsers.length === 0 ? srUsers : visibleUsers
```

4. Boolean updateTriggers for zoom-dependent text — a raw float zoom in
   `updateTriggers.getText` fires on every zoomend and rebuilds text
   attributes for every row; text depends only on a threshold, so the boolean
   flip is the trigger. Accessors read the boolean (`showText ? name : ''`),
   triggers list booleans + object identity, never floats.

```tsx
      getText: (info: DataType) => (showText ? info?.name : ''),
      updateTriggers: {
        getText: [showText, gpxTrigger, isBreakTime],
      }
```

5. Owner overlay: one `layers` useMemo — the owner computes threshold booleans
   once, derives route-geometry data in its own memo (the layer array never
   sees a fresh data reference), and builds the whole stack in a single
   `useMemo`. No `useState(layers)` + `useEffect` recreate loop; a raw zoom
   float in the deps rebuilt the whole stack on every zoomend and reset every
   accessor. Deps are data references + booleans, never zoom floats.

```tsx
  const showTraceText = currentZoomLevel > 12
  const showSerialNumber = currentZoomLevel >= 14.5
  const showMultiOutletText = currentZoomLevel > 16.5

  const layers = useMemo((): any[] => {
    // each composite layer takes its boolean, not the zoom float
    return newLayers
  }, [
    // Base Data — data references only
    showTraceText,
    showSerialNumber,
    showMultiOutletText,
  ])
```

6. Boundary/fill layers: boolean selection prop + `updateTriggers.getFillColor`
   — a fill accessor closing over a selection array goes stale when a new
   (equivalent) array arrives: accessor identity is unchanged, so deck.gl
   never re-evaluates the fill. Collapse the selection to a boolean, use it in
   the accessor AND as the updateTrigger.

```tsx
    // Boolean trigger: the fill only depends on whether an SR is selected, and
    // the raw array reference would invalidate the attribute on every rebuild.
    const hasSelectedSR = (selectedSR?.length ?? 0) > 0

      getFillColor: (info: DataType) =>
        hasSelectedSR ? [0, 100, 60, 0] : info?.properties?.fillColor,
      updateTriggers: {
        getFillColor: hasSelectedSR,
      },
```

7. Feeding layers: paginated loads, first page immediate — a national load
   must not block the map on the last page. Dispatch page one, then append
   the rest through one append action that pushes rows into the Immer draft
   (linear) instead of re-spreading accumulated rows per page. Flush halfway
   and at the end — every append freezes accumulated rows, so two flushes
   keep total work near a single dispatch while the map still grows.

```ts
      dispatch(setMultiGeoOutlets(firstPageData.data.data))

      const flushEvery = Math.max(1, Math.ceil(lastPage / 2))
      const isFlushPage = (page: number): boolean =>
        page === lastPage || page % flushEvery === 0
      const pendingRows: any[] = []

      for (let page = 2; page <= lastPage; page++) {
        // fetch page; bail out early if the load toggle was switched off
        // ...for (const outlet of pageData.data) pendingRows.push(outlet)
        if (pendingRows.length > 0 && isFlushPage(page)) {
          dispatch(appendMultiGeoOutlets(pendingRows.slice()))
          pendingRows.length = 0
        }
      }

      // A page failure or an early stop can leave rows outside a flush page.
      if (pendingRows.length > 0) {
        dispatch(appendMultiGeoOutlets(pendingRows.slice()))
      }
```

8. Feeding layers: RTK mutation via `queryFn`, not `onQueryStarted` — a
   national-scale payload parked in the mutation cache is pure memory bloat:
   everything the UI needs is already dispatched to the map slice. Call the
   base query inside `queryFn`, dispatch the rows, cache only a null
   placeholder; errors return `{ error }` through the same dispatch path.

```ts
    getMultiGeoOutlets: builder.mutation({
      queryFn: async (body, { dispatch }, _extraOptions, baseQuery) => {
        dispatch(setIsLoadingOutlets(true))
        try {
          const result = await baseQuery({ url: OUTLET_API.GET_MULTI_GEO_OUTLETS, method: 'POST', body })
          if (result.error) return { error: result.error }
          const outlets = (result?.data as any)?.data
          if (outlets && outlets.length > 0) {
            dispatch(setMultiGeoOutlets(outlets))
          }
          // The raw payload is dispatched, not retained — nothing to cache.
          return { data: null }
        } finally {
          dispatch(setIsLoadingOutlets(false))
        }
      },
    }),
```

## Checklist (after editing a composite layer file)

- Run `npx tsc --noEmit` before build — a truncated mid-edit state once produced
  a syntax error only the build caught.
- New accessor → module scope; derived dataset → `updateState` cache; zoom-
  dependent text → boolean threshold; layer memo deps → data + booleans only.
