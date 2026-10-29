# Real-time plotting (MQTT / WebSocket)

Established pattern (search repo for `mqtt.connect` + any batching util before writing new):

- Connect with `mqtt.connect(brokerUri, { username, password })` from env vars (broker host/port/protocol — wss for browsers).
- **Buffer + batch, never dispatch per message**: buffer into ref, flush on batch size (~100 msgs) or timer (~100ms), memory cap on markers (LRU ~3000). Batch-processor class exists → reuse. Latest-fix-per-entity feeds: key buffer `Map<entityId, payload>` — bounded by entity count, no array spread per message.
- Track subscribed topics in ref `Set` (no double-subscribe); `isConnectedRef` guard; cleanup `client.end(true)` on unmount + `cancelled` flag around any async-before-connect step so client created mid-unmount is ended immediately.
- Business-hours/off-hours suppression belongs in data hook, not map component.
- Repo has `buildMqttConnection(topic)` util (e.g. `trace-mqtt-dashboard/src/utils/mqttUtils.ts`) → route every connection through it — broker env, auth, topic conventions encoded there; never hand-roll `mqtt.connect` next to it.
- Broker URL + client opts from ONE config source (protocol/host/port from env): mqtt.js spreads opts over parsed URL — hardcoded `protocol: 'wss'` in opts silently overrides `ws://` URL (breaks local dev); handle empty-port case once, centrally.
- Bound every live-feed buffer client-side: cap events/markers array (drop oldest). Unbounded `[event, ...prev]` prepend with O(n) copy per event grows forever on long-lived/wall-display pages.
- Auth teardown must stop batch processor in same action (cancel timer, clear refs), not rely on unmount — flush between store reset and unmount repopulates freshly cleared state with old tenant's markers.
- Typical backend pipeline: MQTT → queue (Redis/BullMQ) → DB + geofence store (e.g. Tile38). Live reads hit geofence store; historical via API endpoints.

## Code shapes (live trace dashboard, react-bkoi-gl + deck.gl)

Deployed variant of the pattern above — interval-only flush with a
`shouldFlush` gate (no size trigger), broker config riding the auth-session
response. Search keys when reusing: `mqtt.connect`, `createMqttBuffer`,
`batch_update`.

Connection hook — one hook owns connect/subscribe/teardown:

```ts
// config rides the auth-session response, held in module memory, read via
// useSyncExternalStore — null until the session resolves, so no connection
// happens before auth; never baked into the client bundle
const mqttConfig = useSyncExternalStore(subscribeMqttConfig, getMqttConfig, () => null)

// guard on the client ref (not the connected flag): a client that exists
// but hasn't subscribed yet can never be duplicated
const shouldConnect =
  enabled && isMapRoute && !mqttClientRef.current && canConnect && mqttConfig
if (shouldConnect) initializeMQTT()
// effect deps: enabled, isMapRoute, topicKey, mqttConfig — config/filter
// changes that don't alter the topic set never reconnect; callbacks are
// read through optionsRef (latest-ref) instead

const initializeMQTT = async () => {
  const mqtt = (await import('mqtt')).default   // client-side only
  if (cancelled) return                         // unmount won the race
  const client = mqtt.connect(config.uri, {
    port: config.port,        // session JSON delivers strings; mqtt.js accepts
    username: config.username,
    password: config.password,
    clientId: `trace_${Math.random().toString(16).slice(2, 8)}`,
  })
  client.on('connect', () => {
    subscribedTopicsRef.current.clear()
    for (const t of optionsRef.current.subscribeTopics()) {
      if (subscribedTopicsRef.current.has(t)) continue   // no double-subscribe
      subscribedTopicsRef.current.add(t)
      client.subscribe(t, { qos: 0 })
    }
  })
  client.on('message', (_topic, message) => {
    try { optionsRef.current.onMessage(JSON.parse(message.toString())) }
    catch { /* one bad payload must not kill the stream */ }
  })
  client.on('error', err => {
    const authFail = [4, 5].includes((err as any).code) ||
      /bad user name or password|not authorized/i.test(err.message)
    if (authFail && reauthAttemptsRef.current < MAX_REAUTH) {   // bounded retry
      reauthAttemptsRef.current += 1
      client.end(true)
      hydrateSessionToken().then(() => { if (!cancelled) initializeMQTT() })
    }
  })
}
// teardown: cancelled = true; mqttClientRef.current?.end(true);
//           subscribedTopicsRef.current.clear()
```

Batch buffer — sits between the message handler and the store:

```ts
const createMqttBuffer = <T>({ intervalMs, shouldFlush, onFlush }) => {
  let buffer: T[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  const flush = () => {
    if (buffer.length === 0) return
    if (shouldFlush && !shouldFlush()) return   // e.g. only while connected
    const items = buffer; buffer = []
    onFlush(items)
  }
  return {
    push: item => { buffer.push(item) },
    flush,
    start: () => { if (timer === null) timer = setInterval(flush, intervalMs) },
    stop:  () => { if (timer !== null) { clearInterval(timer); timer = null } },
    // stop keeps pending items — nothing lost on teardown-then-resume
  }
}
// wiring: onMessage → validate coords + business-hours gate → push
//         flush  → dispatch(setTraceUsers({ type: 'batch_update', data }))
```

Store merge — latest fix per entity, keyed Map, no per-message spreads:

```ts
case 'batch_update': {
  const byId = new Map(state.users.map(u => [u._id, u]))
  for (const fix of data) {
    const existing = byId.get(fix._id)
    if (existing) byId.set(fix._id, {
      ...existing,
      lat: fix.latitude, lon: fix.longitude, at: fix.gpx_time,
    })
  }
  state.users = [...byId.values()]
}
```

deck.gl overlay over the engine map — prop updates without remount:

```tsx
const DeckGLOverlay = (props: MapboxOverlayProps) => {
  const overlay = useControl(() => new MapboxOverlay(props))
  overlay.setProps(props)
  return null
}
```

Viewport reads — style-gated and throttled (hover popups throttled the
same way):

```ts
const map = mapRef.current?.getMap()
if (map?.isStyleLoaded?.())
  setViewportBounds([[bounds._sw.lng, bounds._sw.lat], [bounds._ne.lng, bounds._ne.lat]])
const throttledPopup  = useThrottle(popupData, 250)
const throttledBounds = useThrottle(viewportBounds, 500)
```
