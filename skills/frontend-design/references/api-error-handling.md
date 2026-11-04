# Global API Error Handling — Implementation Guide

How to implement a unified global API error-handling layer for fetch-based frontends (Next.js pages router or SPA, RTK Query and/or plain fetch wrappers, Redux Toolkit, antd `message` toasts). Combined solution; no project-specific references. Code is TypeScript, copy-adaptable.

UX-side policy (ownership, message precedence, dedupe contract): `error-ux.md`.

## 1. Architecture

One UI-agnostic core owns everything repeatable; transports, auth flows, and last-resort nets delegate to it.

| Layer | Owns | Lives in |
|---|---|---|
| Transport policy | per-request status handling, timeouts, opt-outs | baseQuery wrapper + plain fetch wrapper |
| Error contract | one `ApiError` shape + type guards | core |
| Normalization | human message from any failure shape | core |
| Dedupe + silence | one toast per failure; silent cancels/timeouts/401 | core |
| Surfaces | toast adapter, error boundary | adapter + app root |
| Last-resort nets | unhandled rejections, window errors | app root hook |
| Auth failure flow | refresh or logout, single-flight | auth module (two modes below) |

Rules of the layering:
- Every failed request passes exactly one transport; the transport applies the global policy; local handlers may only add feedback the global layer skipped.
- The core imports no UI library — the toast function is injected once.
- One error object → one toast, regardless of how many layers see it.

## 2. Core — error contract and message extraction

```ts
class ApiError extends Error {
  status: number
  data: unknown
  code?: string // 'ERR_CANCELED' | 'ERR_NETWORK' | ...
  constructor(status: number, data: unknown, message?: string, code?: string) {
    super(message ?? `Request failed with status ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    this.code = code
  }
}

const isApiError = (e: unknown): e is ApiError =>
  e instanceof ApiError || (typeof e === 'object' && e !== null && 'status' in e && 'data' in e)
```

Message resolution order: backend body key → status text → network pattern → generic fallback.

```ts
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Validation Failed',
  429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
}

// Unknown codes name themselves; non-error statuses (<400) never masquerade.
const statusText = (status: number): string =>
  STATUS_TEXT[status] ?? (status >= 400 ? `Request failed with status ${status}` : '')

// Connectivity signatures (fetch/browser level, not backend text)
const NETWORK_PATTERN =
  /(failed to fetch|fetch failed|network error|load failed|net::|socket hang up|econn\w*|err_\w+|timed out)/i

// HTML error pages (nginx/proxy/debug) are not user-facing messages
const HTML_PATTERN = /^\s*<(?:!doctype|html)/i

// Body keys a backend may carry its message under, priority order
const MESSAGE_KEYS = [
  'message', 'message_en', 'messageEn', 'error_description', 'error',
  'msg', 'detail', 'description', 'reason', 'data',
]

// Guards against pathological bodies
const MAX_MESSAGE_LENGTH = 300
const MAX_EXTRACTION_DEPTH = 3
```

`getApiErrorMessage(error, fallback)` must accept every shape that reaches it: `ApiError`, RTK `{status, data, error}` rejections, `unwrap()` rejections, `FETCH_ERROR` string statuses, plain `Error`, strings, raw bodies. Laravel-style `errors` objects flatten to a joined string. Keep the function isomorphic — no UI imports, `typeof window` guards where needed.

## 3. Core — dedupe and silence policy

```ts
// Errors that already produced a toast, so a second handler stays silent
const toastedErrors = new WeakSet<object>()

// A rejected promise carries the transport error one level down; a caller may
// hold either the wrapper or the error it wraps — both count as one failure.
const errorIdentities = (error: unknown): unknown[] => {
  if (error === null || typeof error !== 'object') return [error]
  const inner = 'error' in error ? (error as { error: unknown }).error : undefined
  return inner === undefined ? [error] : [error, inner]
}

export const markErrorAlerted = (error: unknown): void => {
  errorIdentities(error).forEach(c => {
    if (c !== null && typeof c === 'object') toastedErrors.add(c as object)
  })
}

export const isErrorAlerted = (error: unknown): boolean =>
  errorIdentities(error).some(
    c => c !== null && typeof c === 'object' && toastedErrors.has(c as object)
  )

// Silent failures: canceled/timed-out requests and 401 (owned by the auth
// flow). Request-option opt-outs live in the transport, not here.
const ABORT_PATTERN = /abort/i
const isSilentError = (error: unknown): boolean => {
  const c = error as { status?: unknown; data?: unknown; name?: string; message?: string; error?: unknown } | null
  if (c?.status === 401) return true
  if (c?.data && typeof c.data === 'object' && (c.data as Record<string, unknown>).status === 401) return true
  if (c?.name === 'AbortError' || c?.name === 'TimeoutError') return true
  if (typeof c?.message === 'string' && ABORT_PATTERN.test(c.message)) return true
  if (typeof c?.error === 'string' && ABORT_PATTERN.test(c.error)) return true
  return false
}

// Injected once at boot; the core stays UI-free
type AlertFn = (kind: 'error', key: string, message: string, duration?: number) => void
let toast: AlertFn

export const showErrorAlert = (error: unknown, fallback?: string, key = 'api-error'): void => {
  if (isErrorAlerted(error)) return
  if (isSilentError(error)) return
  alert('error', key, getApiErrorMessage(error, fallback)) // toast adapter injected at boot
  markErrorAlerted(error)
}
```

Fixed toast keys per category (`global-api-error`, `forbidden`) use antd key-replacement: N identical failures replace, not stack.

## 4. Transport adapters

### 4.1 RTK Query baseQuery wrapper — the global policy

```ts
export const apiBaseQuery: AppBaseQuery = async (args, api, extraOptions) => {
  const result = await baseQuery(args, api, extraOptions)

  if (result?.error) {
    if (result.error.status === 401) {
      // The auth flow owns user feedback for expired sessions
      markErrorAlerted(result.error)
      // Judge the 401 by what the failed request carried, not by the
      // token store's current value: a request sent before hydration
      // carries no bearer even if a token exists by the time it resolves.
      handleUnauthorized(Boolean(result.meta?.request?.headers.get('Authorization')))
    } else if (result.error.status === 403) {
      markErrorAlerted(result.error)
      handleForbidden(result.error)
    } else if (!(extraOptions as { skipGlobalErrorMessage?: boolean })?.skipGlobalErrorMessage) {
      showErrorAlert(result.error, undefined, 'global-api-error')
    }
  }
  return result
}
```

Endpoint opt-out: `extraOptions: { skipGlobalErrorMessage: true }` — the endpoint owns its error UX.

### 4.2 Plain fetch wrapper — throw on non-2xx, race the timeout

```ts
const DEFAULT_TIMEOUT_MS = 60_000

// Race the fetch lifecycle signal against a timeout through one controller;
// whichever fires first ends the request. The timeout abort carries a
// distinct reason so timeouts can stay silent.
const timeoutFetch: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const lifecycle = init?.signal
  if (!lifecycle) return fetch(input, { ...init, signal: timeout })

  const controller = new AbortController()
  lifecycle.addEventListener('abort', () => controller.abort(), { once: true })
  timeout.addEventListener('abort', () => controller.abort(new Error('Request timed out')), { once: true })
  return fetch(input, { ...init, signal: controller.signal })
}

interface RequestOptions {
  auth?: boolean            // false = skip Authorization header
  headers?: Record<string, string>
  onUnauthorized?: () => void
  timeout?: number           // per-request override
  skipGlobalErrorMessage?: boolean
  validateStatus?: (status: number) => boolean // default: 200-299
}

async function request<T>(url: string, init: RequestInit, options: RequestOptions): Promise<{ data: T; status: number }> {
  // init.headers come from a buildHeaders() helper: merge options.headers,
  // attach the bearer only when auth !== false AND the origin is allow-listed
  const response = await timeoutFetch(url, init)

  // 401 = session dead; notify the caller so it can sign out
  if (response.status === 401 && options.onUnauthorized) options.onUnauthorized()

  let data: any
  try { data = await response.json() } catch { data = null }

  const ok = options.validateStatus ? options.validateStatus(response.status) : response.ok

  // Non-2xx is an error, not data: throwing prevents error bodies from
  // flowing downstream as `[]`/undefined and silently emptying the UI.
  if (!ok) {
    const message = (data && typeof data === 'object' && (data.error || data.message)) || undefined
    const apiError = new ApiError(response.status, data, message)

    if (response.status !== 401 && !options.skipGlobalErrorMessage) {
      showErrorAlert(apiError, undefined, 'global-api-error')
    }
    throw apiError
  }

  return { data, status: response.status }
}
```

Map fetch-level failures to codes before they reach callers: abort → `ERR_CANCELED` (never toast), everything else → `ERR_NETWORK` (human network message).

## 5. Auth failure flows

Pick one mode per product; the core exposes `handleUnauthorized` either way.

### Mode A — refresh, replay, then logout

```ts
interface RequestConfig {
  url: string
  headers: Record<string, string>
  _retry?: boolean // loop guard set before a refresh replay
  // … method, body, params — the wrapper's normalized config
}

let isRefreshing = false
let refreshPromise: Promise<string> | null = null
const pendingRequests: Array<{ resolve: (t: string) => void; reject: (e: unknown) => void }> = []

const processQueue = (error: unknown, token: string | null) => {
  pendingRequests.forEach(p => (token ? p.resolve(token) : p.reject(error)))
  pendingRequests.length = 0
}

// Refresh endpoint URLs never auto-refresh (recursion guard)
const shouldSkipRefresh = (url?: string) =>
  !!url && (url.includes(AUTH.LOGIN) || url.includes(AUTH.REFRESH_TOKEN))

const handleResponseError = async (error: ApiError & { config: RequestConfig }): Promise<unknown> => {
  const { config } = error
  const statusCode = error.status

  // Global toast for every FINAL failure; 401s that will be retried
  // with a refreshed token stay silent.
  if (statusCode !== 401 || shouldSkipRefresh(config.url) || config._retry) {
    if (typeof window !== 'undefined') showErrorAlert(error, undefined, 'global-api-error')
    throw error
  }

  config._retry = true // loop guard: a second 401 after retry is terminal

  if (isRefreshing) {
    // Park concurrent 401s; replay each with the new token when it resolves
    return new Promise<string>((resolve, reject) => {
      pendingRequests.push({ resolve, reject })
    }).then(token => {
      config.headers = { ...config.headers, Authorization: `Bearer ${token}` }
      return issue(config) // re-issue through the same wrapper
    })
  }

  isRefreshing = true
  try {
    const newToken = await refreshAccessToken()
    setStoredToken(newToken)
    processQueue(null, newToken)
    config.headers = { ...config.headers, Authorization: `Bearer ${newToken}` }
    return await issue(config) // re-issue through the same wrapper
  } catch (refreshError) {
    processQueue(refreshError, null)
    throw refreshError
  } finally {
    isRefreshing = false
  }
}

// Single-flight refresh: every concurrent caller shares one HTTP call.
// Raw fetch — the refresh endpoint stays outside the wrapper to avoid
// recursion; failure paths force logout with a typed error so every
// queued request rejects with the SAME object (one toast via WeakSet).
const requestRefreshToken = async (): Promise<string> => {
  const token = getStoredToken()
  if (!token) { forceLogout(); throw new AuthSessionExpiredError() }

  const response = await fetch(AUTH.REFRESH_TOKEN, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  if (response.status === 401) { forceLogout(); throw new AuthSessionExpiredError() }
  if (!response.ok) throw Object.assign(new Error(`Request failed with status ${response.status}`), { response: { status: response.status } })

  const data: any = await response.json().catch(() => null)
  const accessToken = data?.data?.access_token
  if (!accessToken) { forceLogout(); throw new AuthSessionExpiredError() }
  return accessToken
}

export const refreshAccessToken = async (): Promise<string> => {
  if (refreshPromise) return refreshPromise
  refreshPromise = requestRefreshToken().finally(() => { refreshPromise = null })
  return refreshPromise
}
```

### Mode B — logout, never refresh

Use when nothing can rotate the token between attempts.

```ts
let isSigningOut = false
const handleUnauthorized = (hadBearer: boolean) => {
  if (typeof window === 'undefined' || isSigningOut) return
  // No bearer on the failed request: it went out before the token store was
  // hydrated — this 401 means "missing session", not "dead session".
  if (!hadBearer) return
  isSigningOut = true // N parallel 401s → exactly one logout

  const currentPath = window.location.pathname
  const finish = () => {
    isSigningOut = false
    if (isProtectedRoute(currentPath) && currentPath !== '/login') {
      window.location.replace(`/login?callbackUrl=${encodeURIComponent(currentPath)}`)
    }
  }

  // Any awaited cleanup goes here, BEFORE finish() — the redirect destroys
  // the page and aborts in-flight async cleanup. Best effort: a cleanup
  // failure never blocks sign-out.
  signOut({ redirect: false }).then(finish).catch(finish)
}
```

### 403, allowlists, and cleanup order

- 403 is permission, not session expiry: toast `forbidden` (single key, backend message wins) and keep the session — unless the product explicitly treats 403 as expiry.
- Allowlist auth endpoints (`login`, `changePassword`) out of force-logout so wrong credentials show the backend message instead of a redirect loop.
- Logout order: clear storage → clear cookies (awaited) → redirect last. Parallel 401s are safe only if the redirect is the final statement.
- Route guards read cookies/storage at mount; a login path that writes the token without cookies will bounce navigation despite a valid token.

## 6. Last-resort nets

### Window-level hook

```ts
const DEDUPE_WINDOW_MS = 3000
const GENERIC_MESSAGE = 'Something went wrong. Please try again.'

const useGlobalErrorToast = (): void => {
  const lastShownRef = useRef<{ message: string; at: number } | null>(null)

  useEffect(() => {
    const report = (reason: unknown) => {
      if (isErrorAlerted(reason)) return // transport already toasted it
      const message = getApiErrorMessage(reason, GENERIC_MESSAGE)
      console.error('Uncaught error:', reason)

      const now = Date.now()
      const last = lastShownRef.current
      if (last && last.message === message && now - last.at < DEDUPE_WINDOW_MS) return

      lastShownRef.current = { message, at: now }
      markErrorAlerted(reason)
      toast('error', 'global-error', message, 5)
    }

    const handleRejection = (event: PromiseRejectionEvent) => {
      // Claim the rejection so the runtime does not also report it —
      // that report is what triggers the dev overlay
      event.preventDefault?.()
      report(event.reason)
    }
    const handleError = (event: ErrorEvent) => {
      event.preventDefault?.()
      report(event.error ?? event.message)
    }

    window.addEventListener('unhandledrejection', handleRejection)
    window.addEventListener('error', handleError)
    return () => {
      window.removeEventListener('unhandledrejection', handleRejection)
      window.removeEventListener('error', handleError)
    }
  }, [])
}
```

Mount once at the app root. Verify listener order against the monitoring SDK: `preventDefault()` on these events may hide them from Sentry — if rejections must be reported, let the SDK register first or capture explicitly before preventing.

### Error boundary

Class boundary with `getDerivedStateFromError`, `componentDidCatch` (console + report hook), reset when `resetKeys` change (pass `[router.asPath]` so navigation clears the fault), antd `Result` fallback with a Try-again button. Add `_error.tsx`/`global-error.tsx` per router type for failures outside the client boundary.

## 7. Coverage checklist

1. Toast once per failure across all layers — dedupe by error identity (WeakSet), never by fixed string key.
2. Decide 401 by product: refresh (Mode A) or logout (Mode B). Single-flight; queue + replay failed requests; second 401 terminal; ignore pre-hydration/no-bearer 401s; run awaited cleanup before the redirect; reject all queued requests with one error object.
3. Separate 403 from session expiry; force logout on both only as a deliberate product choice.
4. Distinguish network vs HTTP vs cancel vs timeout: distinct codes, silent cancels/timeouts, human network message.
5. Parse non-JSON safely: parse failure → `data = null`; filter HTML pages from messages; never surface `SyntaxError`.
6. Handle 429: human message at minimum; parse `Retry-After`; opt-in backoff for idempotent requests.
7. Set a 5xx retry policy for idempotent GETs — silent-swallow and infinite-retry are both wrong.
8. Cover queries AND mutations — a middleware matching `executeQuery/rejected` alone leaves every mutation silent; RTK 1.9 puts the error in `action.payload` (`rejectedWithValue`), not `action.error`.
9. Provide opt-outs: `skipGlobalErrorMessage` per endpoint plus `validateStatus` for local interception of specific statuses.
10. Surface partial batch failures — a transport that never rejects hides per-item failures inside `.map`s.
11. Capture unhandled rejections + `window.onerror`; define the monitoring interplay explicitly.
12. Mount an error boundary keyed on route.
13. Default + per-request timeouts with silent abort.
14. One `ApiError` contract with type guards; ad-hoc `Error('SOME_CODE')` throws break shape guards — attach `.data` and document the contract.
15. Keep extractors isomorphic: no UI imports; `typeof window` guards on toasts.
16. Report every layer to the monitoring SDK, not only auto-instrumentation.

## 8. Pitfalls

- Fixed toast keys (`'error-message-key'`) shared across handlers collapse concurrent distinct failures into one toast — dedupe by identity, key by category.
- A wrapper that resolves `{ data, status }` on non-2xx turns batch failures into silent no-ops; throw, and let callers that want status-inspection use `validateStatus`.
- Unguarded `response.json()` surfaces a raw `SyntaxError` from HTML error pages; always `catch { data = null }`.
- Suppressing 401 toasts everywhere hides endpoint-level auth bugs — keep the "final failure" distinction: retried-and-still-401 should surface somewhere.
- Middleware alerting only 429/5xx leaves all 4xx business errors to per-endpoint handlers — count the endpoints with handlers before relying on it.
- Empty `catch {}` blocks returning `[]` convert failures into "empty data" and lie to the UI; catch → toast or catch → typed empty state, never silent.
- `Bearer` tokens sent to non-API origins leak credentials — allow-list the origins that may receive the session token.
- Storage cleanup inline in a baseQuery grows untestable; extract a `forceLogout()` with typed error and unit-test the ladder.

## 9. Adoption steps

1. Extract the core (contract, extraction, dedupe, silence policy) as a UI-free module; inject the toast adapter at boot.
2. Wrap the primary transport (baseQuery or plain wrapper) with the global policy; keep old helpers as thin wrappers over the core so existing catch blocks keep working.
3. Wire the auth flow (Mode A or B) behind `handleUnauthorized`; add the endpoint allowlist.
4. Add the window hook and error boundary at the app root; settle the monitoring listener order.
5. Add timeouts to transports that lack them; enable Retry-After/backoff behind options, default off.
6. Acceptance tests before any behavior change: extractor unit tests (every shape), dedupe unit test (one toast per object), auth-ladder unit test (single-flight, loop guard), and one e2e asserting exactly one toast on a forced 500.
7. Migrate ad-hoc `message.error` callsites to `getApiErrorMessage` gradually; each migration deletes a hardcoded fallback string.
