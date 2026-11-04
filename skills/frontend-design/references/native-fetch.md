# Native Fetch — Implementation and Migration Guide

Canonical reference for the native-fetch HTTP module: the wrapper, timeouts, the auth ladder, RTK Query transport, and server-side forward-proxy calls. Greenfield implementation and axios migration in one place; no project-specific references. TypeScript, copy-adaptable.

Error contract, message extraction, dedupe, and last-resort nets: [api-error-handling.md](api-error-handling.md). Toast ownership and message precedence: [error-ux.md](error-ux.md).

## 1. What axios was doing for you

Re-earn every dropped dependency explicitly — map each axios behavior to its native equivalent before deleting anything:

| axios behavior | native fetch | Covered in |
|---|---|---|
| `baseURL` prefixing | string join in the wrapper | §3 |
| JSON body serialize + response parse | `JSON.stringify` / `res.json()`, manual | §3 |
| Rejects on non-2xx (`validateStatus`) | fetch resolves on any reachable status — the wrapper's status gate | §3 |
| `params` object → query string | `URLSearchParams` | §3 |
| `timeout` option | `AbortSignal.timeout` | §4 |
| Request/response interceptors | wrapper stages: headers in, status out | §5 |
| Auth header injection | header stage / `prepareHeaders` | §3, §6 |
| 401 refresh + replay | single-flight ladder in the auth module | §5 |
| `withCredentials` | `credentials: 'include'` | §3 |
| XSRF header auto-injection | manual header in the header stage | §10 |
| `proxy` option / custom agents | undici `ProxyAgent` dispatcher, server-side only | §7 |
| `axios.get/post/…` aliases | method helpers over one core function | §3 |
| `error.response.{status, data}` | `ApiError.status`, `ApiError.data` | [api-error-handling.md](api-error-handling.md) §2 |

Rules:
- One wrapper per app owns every row of the table; callsites never reimplement a row.
- The wrapper throws on failure — the same rejection semantics axios had — so existing `catch` blocks survive the migration unchanged.

## 2. Module map — one module per concern

Fresh implementations start here and stay on these names:

| File | Owns | Exports |
|---|---|---|
| `lib/httpClient.ts` | the client wrapper: URL build, body, status gate, aliases, ladder wiring (§3–§5) | `http`, `HttpResponse`, `RequestConfig` |
| `store/auth.ts` | token storage, the 401 refresh ladder, logout (§5) | `getStoredToken`, `setStoredToken`, `refreshAccessToken`, `handleUnauthorized` |
| `lib/timeoutSignal.ts` | cross-runtime timeout signal (§4) | `timeoutSignal(ms)`, `DEFAULT_TIMEOUT_MS` |
| `lib/proxy-fetch.ts` | server-side upstream fetch through the forward proxy (§7) | `proxyFetch` |
| `utils/apiUtils.ts` | error-message extraction, status-text map, dedupe | `getApiErrorMessage`, `isErrorAlerted`, `markErrorAlerted` ([api-error-handling.md](api-error-handling.md) §2–§3) |
| `utils/alertUtils.ts` | toast adapter, injected once at boot | `showErrorAlert`, `showAlert` — [error-ux.md](error-ux.md) |
| `redux/features/api/apiSlice.ts` | RTK Query transport + policy wrapper (§6) | `api`, `baseQuery` |
| `pages/api/frontend/*.ts` | same-origin BFF routes; the only callers of `proxyFetch` (§7) | route handlers |

Naming rules:
- camelCase for `lib/` and `utils/` modules, kebab-case for route files (framework convention), one transport module per concern — never a second wrapper.
- Scaling: start with `lib/httpClient.ts` alone. When the endpoint list outgrows one file, split into `lib/api/fetcher.ts` (transport plumbing) + `lib/api/client.ts` (an `Endpoints` map and typed calls) — a refactor of names, not of behavior.

## 3. Wrapper — feature parity in one function

The wrapper keeps the axios response shape (`{ data, status }` — plus `headers`) so callsites rewrite mechanically, and throws one `ApiError` per failure so the global error policy stays intact.

```ts
// lib/httpClient.ts — the single transport for the app
import { ApiError } from './apiError' // contract: api-error-handling.md §2
import { getStoredToken } from '../store/auth'
import { withRefresh } from '../store/auth' // ladder: §5

const BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? ''
const DEFAULT_TIMEOUT_MS = 60_000 // matches the policy default: api-error-handling.md §4.2

export interface HttpResponse<T = unknown> {
  data: T | null // null when empty or unparseable — never a silent success
  status: number
  headers: Headers // axios callsites reading response.headers keep working
}

export interface RequestConfig extends Omit<RequestInit, 'body' | 'headers'> {
  url: string
  headers?: Record<string, string>
  params?: Record<string, unknown>
  body?: unknown // JSON by default; FormData/Blob/URLSearchParams/string pass through
  timeoutMs?: number
  credentials?: RequestCredentials // default 'include' — a default change vs axios, see §10
  validateStatus?: (status: number) => boolean // default: response.ok
}

const buildUrl = (url: string, params?: Record<string, unknown>): string => {
  const target = /^https?:\/\//.test(url) ? url : `${BASE_URL}${url}`
  if (!params) return target
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) value.forEach(v => search.append(key, String(v)))
    else search.append(key, String(v))
  }
  const qs = search.toString()
  return qs ? `${target}${target.includes('?') ? '&' : '?'}${qs}` : target
}

// FormData owns its Content-Type (multipart boundary); JSON sets it only
// when we are the ones serializing.
const toBody = (body: unknown, headers: Record<string, string>): BodyInit | undefined => {
  if (body === undefined) return undefined
  if (typeof body === 'string' || body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams) {
    return body
  }
  headers['Content-Type'] = 'application/json'
  return JSON.stringify(body)
}

// HTML error pages (proxies, framework debug pages) are not JSON — parse
// failures become data: null, and the status gate does the rejecting.
const parseBody = async <T>(res: Response): Promise<T | null> => {
  if (res.status === 204) return null
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function httpRequest<T>(config: RequestConfig): Promise<HttpResponse<T>> {
  const { url, params, body, timeoutMs = DEFAULT_TIMEOUT_MS, validateStatus, headers = {}, credentials = 'include', signal, ...init } = config

  attachAuth(headers, url) // §5 — Bearer injection has exactly one home
  const requestHeaders = { ...headers }

  let response: Response
  try {
    response = await fetch(buildUrl(url, params), {
      ...init,
      headers: requestHeaders,
      body: toBody(body, requestHeaders),
      credentials,
      // Caller cancellation and timeout both apply when both exist
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw toTransportError(error) // §4 — timeout vs cancel vs network
  }

  // axios parity: fetch resolves on any reachable status — the gate is ours
  const accepted = validateStatus ? validateStatus(response.status) : response.ok
  if (!accepted) {
    throw new ApiError(response.status, await parseBody<unknown>(response))
  }
  return { data: await parseBody<T>(response), status: response.status, headers: response.headers }
}

// Everything funnels through one policy-wrapped entry point (§5)
const request = <T>(config: RequestConfig) => withRefresh(config, () => httpRequest<T>(config))

// The aliases callsites already know — same argument order as axios
export const http = {
  get: <T>(url: string, config?: Partial<RequestConfig>) => request<T>({ ...config, url, method: 'GET' }),
  post: <T>(url: string, body?: unknown, config?: Partial<RequestConfig>) => request<T>({ ...config, url, method: 'POST', body }),
  put: <T>(url: string, body?: unknown, config?: Partial<RequestConfig>) => request<T>({ ...config, url, method: 'PUT', body }),
  patch: <T>(url: string, body?: unknown, config?: Partial<RequestConfig>) => request<T>({ ...config, url, method: 'PATCH', body }),
  delete: <T>(url: string, config?: Partial<RequestConfig>) => request<T>({ ...config, url, method: 'DELETE' }),
}
```

Callsites that used to branch on status instead of catching keep that ability:

```ts
const { data, status } = await http.get<Session>(`/sessions/${id}`, {
  validateStatus: s => s === 404 || (s >= 200 && s < 300), // 404 handled locally, the rest throw
})
if (status === 404) return null
```

Transport obligations — the policy holds only if the transport keeps these:
- One extractor for both transports: the wrapper and the RTK baseQuery feed the same `getApiErrorMessage` ([api-error-handling.md](api-error-handling.md) §2); no transport-specific message logic anywhere.
- Rethrow the same object. The dedupe keys on object identity ([api-error-handling.md](api-error-handling.md) §3) — a catch that wraps the error in a new object makes one failure toast twice. Wrappers pass rejections through untouched.
- Canceled, timed-out, and 401 failures stay silent ([api-error-handling.md](api-error-handling.md) §3); a request owns its error UX via `skipGlobalErrorMessage`.

## 4. Timeouts — AbortSignal discipline

axios timed out via an option; fetch times out via an abort signal. Name the failure distinctly — map cancel and timeout to `ERR_TIMEOUT` / `ERR_CANCELED` codes — or the silence policy cannot tell them apart ([api-error-handling.md](api-error-handling.md) §3).

```ts
const toTransportError = (error: unknown): ApiError => {
  if (error instanceof DOMException) {
    // AbortSignal.timeout raises TimeoutError; caller cancellation raises AbortError
    if (error.name === 'TimeoutError') return new ApiError(408, null, 'Request timed out', 'ERR_TIMEOUT')
    if (error.name === 'AbortError') return new ApiError(0, null, 'Request canceled', 'ERR_CANCELED')
  }
  return new ApiError(0, null, 'Network error', 'ERR_NETWORK') // connect/DNS/CORS failures
}
```

Rules:
- Every request carries a timeout — one default at the wrapper, per-request overrides for known-slow endpoints.
- Combine, never replace: a caller signal and the timeout signal go through `AbortSignal.any`, so component unmount still cancels instantly.
- `AbortSignal.timeout` and `AbortSignal.any` are absent on old runtimes (Node < 17.3 / 20.3, pre-2022 browsers). Feature-check once and fall back to a controller + `setTimeout` (unref the timer on Node so it never holds the process open) — `lib/timeoutSignal.ts` in the module map is exactly that helper; do not discover the gap in production.

Unmount cancellation is two lines and stays silent by the codes above:

```ts
useEffect(() => {
  const controller = new AbortController()
  http.get<Report>('/report', { signal: controller.signal }).catch(() => {}) // unmount cancel: ERR_CANCELED, no toast
  return () => controller.abort()
}, [])
```

## 5. Interceptors — header stage and the 401 ladder

Axios interceptors were a global mutable chain; in the wrapper each concern becomes an explicit stage. Request interceptors run before `fetch` (header stage), response interceptors after it (status gate, refresh ladder).

```ts
// Request-interceptor replacement: auth injection, one place
const AUTH_EXEMPT = ['/auth/login', '/auth/refresh'] // credential endpoints never carry a stale Bearer

const attachAuth = (headers: Record<string, string>, url: string): void => {
  if (AUTH_EXEMPT.some(ep => url.includes(ep))) return
  const token = getStoredToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
}
// attachAuth overwrites Authorization from the store on every call — safe
// because the ladder stores the fresh token before re-issuing (below).
```

Only API origins receive the Bearer — an unconditional header stage leaks the session token to third-party endpoints ([api-error-handling.md](api-error-handling.md) §8).

```ts
// store/auth.ts — Mode A: refresh, replay, then logout (api-error-handling.md §5).
// Logout lives here, not in callers: the ladder re-issues or rethrows, so no
// path can log out twice.
let refreshPromise: Promise<string> | null = null

export const refreshAccessToken = (): Promise<string> => {
  refreshPromise ??= http
    .post<{ token: string }>('/auth/refresh') // AUTH_EXEMPT keeps the ladder off its own endpoint
    .then(({ data }) => {
      const token = data?.token ?? ''
      if (!token) throw new ApiError(401, data) // dead refresh token — the auth module's logout path
      setStoredToken(token)
      return token
    })
    .finally(() => {
      refreshPromise = null // a 401 arriving after completion starts a genuinely new refresh
    })
  return refreshPromise
}

export const withRefresh = async <T>(config: RequestConfig, issue: () => Promise<T>): Promise<T> => {
  try {
    return await issue()
  } catch (error) {
    // Credential endpoints and non-401 failures pass straight through
    if (!(error instanceof ApiError) || error.status !== 401 || AUTH_EXEMPT.some(ep => config.url.includes(ep))) throw error
    markErrorAlerted(error) // the retried 401 stays silent while the ladder runs
    const token = await refreshAccessToken() // the leader and every late 401 share one promise
    config.headers = { ...config.headers, Authorization: `Bearer ${token}` }
    return await issue() // a second 401 here re-enters the ladder; the next refresh throws — logout
  }
}
```

Why a memoized promise instead of the classic parked-request queue:
- Single flight is structural: every 401 — the first and any that land mid-refresh — awaits the same promise. There is no queue someone must remember to drain, so no waiter can park forever.
- `finally` clears the memo: a 401 arriving after completion triggers one fresh refresh, which is correct, not a leak.
- Loop guard is two-part: `AUTH_EXEMPT` keeps the ladder off `/auth/refresh`, and a replay that 401s again re-enters a refresh whose token is dead — it throws and the auth module logs out.

Other interceptor cargo lands in known places: branch-on-status → `validateStatus` (§3); custom headers per request → the config the caller already passes; logging → the error policy ([api-error-handling.md](api-error-handling.md) §4), not the transport.

## 6. RTK Query — fetchBaseQuery transport

`fetchBaseQuery` is fetch-native, so axios-based custom `baseQuery` implementations delete outright. Two additions restore parity: auth in `prepareHeaders`, timeout in `fetchFn`.

```ts
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'

const rawBaseQuery = fetchBaseQuery({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE_URL,
  prepareHeaders: (headers, { getState }) => {
    const token = (getState() as RootState).auth.accessToken
    if (token) headers.set('authorization', `Bearer ${token}`)
    return headers
  },
  // Every query carries the timeout — same default as the wrapper (§4)
  fetchFn: (input, init) => {
    const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
  },
})
```

`prepareHeaders` reads Redux state — after a refresh, dispatch the auth slice's action so the fresh token reaches the store, not just storage; otherwise every re-issue leaves with the stale Bearer.

The policy wrapper mirrors [api-error-handling.md](api-error-handling.md) §4.1 exactly — RTK adds nothing transport-specific beyond the timeout `fetchFn`:

```ts
// One policy wrapper — every failed query/mutation passes exactly one transport
export const baseQuery: BaseQueryFn<FetchArgs, unknown, FetchBaseQueryError> = async (args, api, extraOptions) => {
  const result = await rawBaseQuery(args, api, extraOptions)
  if (result.error?.status === 401) {
    markErrorAlerted(result.error)
    // Judge the 401 by what the failed request carried, not the store's current value
    handleUnauthorized(Boolean(result.meta?.request?.headers.get('Authorization')))
  } else if (result.error?.status === 403) {
    markErrorAlerted(result.error)
    handleForbidden(result.error)
  } else if (result.error && !(extraOptions as { skipGlobalErrorMessage?: boolean })?.skipGlobalErrorMessage) {
    showErrorAlert(result.error, undefined, 'global-api-error') // api-error-handling.md §3
  }
  return result
}

export const api = createApi({ baseQuery, tagTypes: ['Session'], endpoints: () => ({}) })
```

Refresh-and-replay for queries belongs to the auth module's ladder (§5); the RTK wrapper delegates 401 to `handleUnauthorized` and does not replay.

`fetchBaseQuery` already folds non-2xx responses into `result.error { status, data }` — axios rejection parity is free; only the global policy needs adding. Full transport-adapter rules: [api-error-handling.md](api-error-handling.md) §4.

## 7. Forward proxy — server-side upstream calls

axios supported forward proxies natively (`proxy` option, custom agents). Native fetch has no proxy support — and browsers cannot use one at all. The replacement is server-side: same-origin BFF routes call upstreams through undici's `ProxyAgent` dispatcher, and browser code never talks to upstreams directly.

```ts
// lib/proxy-fetch.ts — server-side upstream fetch through the forward proxy
import { fetch, ProxyAgent } from 'undici'
import { DEFAULT_TIMEOUT_MS, timeoutSignal } from './timeoutSignal' // §4 — cross-runtime fallback included

const proxyUrl = process.env.HTTP_PROXY ?? ''

// Certificate verification for the tunnelled origin connection stays off by
// default: a deployed forward proxy must keep working with no new server-side
// configuration. Enforce verification with PROXY_TLS_REJECT_UNAUTHORIZED=true;
// trust a proxy that terminates TLS with a self-signed certificate via
// NODE_EXTRA_CA_CERTS.
const rejectUnauthorized = process.env.PROXY_TLS_REJECT_UNAUTHORIZED === 'true'

const dispatcher = proxyUrl ? new ProxyAgent({ uri: proxyUrl, connect: { rejectUnauthorized } }) : undefined

export const proxyFetch = async (url: string, options: Parameters<typeof fetch>[1] = {}): Promise<Response> => {
  const startTime = Date.now()
  try {
    const response = await fetch(url, {
      ...options,
      // Caller cancellation wins; a proxied call is never unbounded
      signal: options.signal ?? timeoutSignal(DEFAULT_TIMEOUT_MS),
      ...(dispatcher && { dispatcher }), // unset proxy = direct connection
    })
    logger.debug({ msg: 'proxy fetch response', url, status: response.status, duration: Date.now() - startTime, proxyUrl: dispatcher ? proxyUrl : undefined })
    return response
  } catch (error) {
    logger.error({ msg: 'proxy fetch failed', url, duration: Date.now() - startTime, code: errorCode(error), err: error })
    throw error // rethrown as-is: identity preserved, no toast policy server-side
  }
}
```

Rules:
- One shared `proxyFetch` for every BFF route — no route builds its own dispatcher. Browser callsites target the same-origin route (`pages/api/frontend/*`), never the upstream.
- Empty `HTTP_PROXY` means direct connections; the module works both ways with no code change.
- Errors rethrow untouched — the server logs; the route maps failures to its own status codes; the client-side policy (§3 obligations) applies from the route response onward.

## 8. Escape hatches — when raw fetch is correct

| Case | Why raw fetch | Non-negotiables |
|---|---|---|
| Streamed bodies, downloads (`res.body` reader) | the wrapper JSON-parses; streams need the raw body | timeout signal; failures still map to `ApiError` |
| Upload progress | fetch cannot report upload progress — keep XHR for that one callsite | isolate it; document why it stayed |
| Third-party / public APIs | no Bearer, no refresh, foreign error contract | explicit headers; timeout |
| Unload-time beacons (`keepalive: true`) | outlives page teardown — axios had no equivalent | small bodies only (~64 KB); no streaming; no retries |

## 9. Migration checklist

1. Inventory: `rg -l "axios" src` — group callsites by instance (default vs `axios.create`), and list every attached interceptor.
2. Write the wrapper plus unit tests against a mocked `fetch`: non-2xx throws, 204 → `null`, HTML error page → `data: null`, params encoding, FormData passthrough, timeout and cancel codes.
3. Keep `{ data, status }` and rejection semantics identical — then callsites migrate mechanically: `axios.get` → `http.get`, `response.data` unchanged, existing catch blocks untouched.
4. Port each interceptor as one explicit stage: auth header → header stage (§5); status branching → `validateStatus` (§3); 401 refresh → the ladder (§5).
5. RTK Query apps: adopt `fetchBaseQuery` + `prepareHeaders` + `fetchFn` timeout + the policy wrapper (§6); delete axios-based custom baseQueries last.
6. Proxy inventory: axios `proxy` config or custom agents move to the server-side `proxyFetch` (§7); browser callsites switch to same-origin BFF routes.
7. Sweep for axios-only APIs: `validateStatus`, `error.response`, `axios.isCancel`, `CancelToken`, `withCredentials` — each has a named replacement in §3–§4.
8. Remove the dependency, then rerun `rg axios` — remaining hits must be comments or generated code, nothing executable.
9. Acceptance before cleanup: ladder unit tests (concurrent 401s share one refresh, no waiter left unsettled, loop guard) and one e2e asserting exactly one toast on a forced 500 plus silence on cancel and timeout ([api-error-handling.md](api-error-handling.md) §9).

## 10. Pitfalls

- fetch resolves on 4xx/5xx — an unwrapped callsite reads every failure as `data: null` success; the status gate exists exactly once, in the wrapper.
- Unguarded `response.json()` throws `SyntaxError` on HTML error pages — always catch and yield `data: null`. A 200 with a non-JSON body also parses to `data: null`: successful requests can carry null data; type the return accordingly.
- Cookie defaults change silently: axios sent cross-origin cookies only with `withCredentials: true`; fetch defaults to `same-origin`. This wrapper pins `credentials: 'include'` — one deliberate default, and the backend's CORS must allow it.
- axios auto-injects the XSRF header from its cookie; fetch does not — if the backend reads `X-XSRF-TOKEN`, set it in the header stage.
- Query encoding differs: axios renders arrays as `a[]=1&a[]=2`, `URLSearchParams` as `a=1&a=2` — pin the choice with a test; backends notice.
- Never set `Content-Type` on FormData bodies — the multipart boundary belongs to the browser.
- A DELETE with a body is legal in fetch but some proxies drop it — verify end-to-end when migrating `axios.delete(url, { data })`.
- A catch-and-rethrow that constructs a new error object doubles toasts — dedupe keys on object identity; pass the original rejection through ([api-error-handling.md](api-error-handling.md) §3).
- A ladder built as a parked-request queue strands waiters that arrive while the leader replays — the memoized-promise shape (§5) has no queue to forget.
- Migrating an upload-progress callsite to fetch silently deletes the feature — fetch has no upload progress; keep XHR there knowingly.
