---
name: api-performance
description: "Fixes N+1 request fan-out and protects upstreams behind proxy, aggregator and image-fetch routes: reads the observability signal (Sentry N+1 API Call insight, span counts), finds whether repeats come from browser refetching or concurrent duplicate misses, and applies the fix ladder — HTTP cache headers, in-flight dedupe, bounded TTL cache, batch endpoint. Use when a route is called once per rendered item, profiling shows repeated upstream calls, a response carries no-store, an icon/asset/geocode proxy is slow under load, or an APM insight names a route as N+1. NOT for choosing a cache library (→ ponytail) or map icon loading specifics (→ map-integration)."
---

# N+1 fan-out and route-level caching

One page render asks for N items; each item reaches the server separately, and the server forwards each one upstream. Latency multiplies, the upstream sees a concurrent burst, and a single user can generate the load of a hundred.

Two independent causes, two different fixes. Identify which one you have before touching code.

| Cause | Evidence | Fix |
|---|---|---|
| Repeats over time — the same URL requested again on every render | Response carries `no-store`; browser network panel shows the identical request each time | Cache headers (step 1) |
| Repeats at the same instant — a burst of identical requests before any response lands | Concurrent server spans for the same key; upstream sees clone calls | In-flight dedupe (step 2) |
| Many distinct keys for one view | N different URLs from one page, each cheap but summed expensive | Batch endpoint or TTL cache (steps 3–4) |

## Read the signal first

APM tools surface this pattern under names like "N+1 API Call" with the route pattern attached (for Sentry: Performance → Insights, route normalized as `/api/...?key=*`). Confirm the count against the route's own spans before optimizing: one insight row naming a route proves repeats exist, not why.

Check the cheap explanation before the clever one: a pass-through route that sets `Cache-Control: private, no-store` (or inherits a no-cache default) makes the browser refetch on every render. That is one header away from being gone, and no server-side machinery is needed.

## Fix ladder

Apply in order; each step is independently useful, and stopping early is fine when the signal disappears.

**1. Cache headers.** Per-user content: `private, max-age=<ttl>`. Content identical for every caller (icons, config, geocoding): `public, max-age=<ttl>, immutable` if the URL is content-addressed. Pick the TTL from the content's real update cadence — a marker icon changes on upload, so minutes-to-hours, not a year.

**2. In-flight dedupe.** Collapse concurrent identical misses into one upstream call:

```ts
const inflight = new Map<string, Promise<string>>()

async function fetchOnce(key: string): Promise<string> {
  const pending = inflight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const res = await upstream(key)
      if (!res.ok) throw new Error(`upstream ${res.status}`)
      const body = await res.text()
      cache.set(key, body)
      return body
    } finally {
      inflight.delete(key)   // delete in finally, never after resolve only
    }
  })()

  inflight.set(key, request)
  return request
}
```

**3. Bounded TTL cache.** Size-capped, oldest-evicted, rejecting expired entries on read. Cache the success path only — a cached failure turns one upstream hiccup into a TTL-long outage.

**4. Batch.** When one view needs many keys, a single endpoint that accepts a list beats N calls that are each cached well. Only worth it if the client can be changed too.

## Invariants

- Authorization and input validation run **before** the cache, so a cache hit can never serve content the caller is not allowed to see.
- Cache key = exact upstream URL plus every input that changes the response (accept header, format, viewport). A key that drops an input serves the wrong variant.
- Bound the map. An unbounded `Map` keyed by user-supplied URLs is a memory-exhaustion primitive — cap entries and evict.
- Never let a client-supplied URL reach the cache without the same allowlist check the route already enforces; a cache is not a bypass.

## Verification

Write the three tests before the code — concurrent collapse (one upstream call for two simultaneous requests), cached repeat (second request makes no upstream call), failure not cached (a failed upstream retries on the next request). Then confirm on the live route:

```bash
curl -sI "<route-url>" | grep -i cache-control
```

and count the upstream requests for a single page render in the network panel: the number should equal the number of distinct keys, once.

## Reporting

State the before/after call count per render and the TTL chosen with its reason. "Added a cache" hides whether the burst or the repeat was fixed, and whether the TTL fits the content.
