# Session boundaries — expiry, guards, identity switch, third-party failures

Where a session may end, and what is not allowed to end it. Read with `token-plumbing.md` (holder mechanics) and `route-protection.md` (routes and redirects).

## Expiry derives from the IdP token, never from a static duration

next-auth re-encodes the JWE on every session read (`GET /api/auth/session`), so a login-time duration slides `exp` forward on each read and a cookie that keeps being read never dies.

```ts
// lib/auth/options.ts
jwt: {
  async encode({ secret, token, salt }) {
    // remaining lifetime, recomputed per encode — no login-time constant
    const backendExp = typeof token?.backendExp === 'number' ? token.backendExp : undefined
    const maxAge = backendExp ? Math.max(0, backendExp - Math.floor(Date.now() / 1000)) : 0
    const { encode } = await import('next-auth/jwt')
    return encode({ secret, token, maxAge, salt })
  },
},
callbacks: {
  async session({ session, token }) {
    // client-visible end = the same absolute deadline
    const backendExp = typeof token.backendExp === 'number' ? token.backendExp : 0
    if (backendExp) session.expires = new Date(backendExp * 1000).toISOString()
    return session
  },
},
```

- No fallback lifetime: a token without a usable expiry encodes with `maxAge: 0` — an already-expired cookie, no session. A guessed 24h/30d both outlives revocation and lies to the client.
- Without the `session.expires` write, next-auth reports `session.maxAge`'s default (30 days) while the bearer is long dead: the client believes it is signed in and every request 401s.
- The cookie's `Max-Age` attribute comes from static `session.maxAge` config and cannot follow a per-user deadline. Document that; the JWE `exp` is what every verifying party enforces.
- No refresh path means the IdP token expiry is the absolute session end. State it, do not silently re-mint.

## Two guards, one deliberate asymmetry

```ts
// API route guard — verify the JWE, then the absolute deadline
const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
const backendExp = typeof token?.backendExp === 'number' ? token.backendExp : 0
if (!token || !backendExp || backendExp <= Math.floor(Date.now() / 1000)) {
  return res.status(401).json({ error: 'Unauthorized' })
}
```

```ts
// page guard (middleware) — same check, 120s early, fail-safe for navigation
const nearExpiry = !backendExp || backendExp - Math.floor(Date.now() / 1000) <= 120
```

- API guard uses `getToken()`, not `getSession()`/`getServerSession()`: a session read can extend the cookie and the session object carries no expiry check, so any decodable cookie passes.
- The buffer stays in the page guard only: copying it into the API layer shortens the usable lifetime twice, removing it from pages brings back mid-page 401s.
- `getToken()` runs no callbacks. Per-request session enrichment has to be re-added at the guard explicitly.

## Third-party failures never end the app session

```ts
// proxy route: the upstream status is not the app session's status
if (response.status === 401 || response.status === 403) {
  logger.warn({ msg: 'upstream rejected the proxied call', status: response.status })
  return res.status(502).json({ error: UPSTREAM_UNAVAILABLE_MESSAGE })
}
// client: toast the message, never signOut — the app session is not the failing one
showAlert('error', 'upstream-unavailable', UPSTREAM_UNAVAILABLE_MESSAGE)
// everything else keeps its real reason so the toast can show it
const data = await response.json().catch(() => null)
return res.status(response.status).json(data ?? {})
```

- Never forward a second service's 401/403: the client's 401 ladder signs the user out and its 403 path reports a permission error on the app account, while the app session is untouched.
- Rule in one line: a third-party auth failure must not log the app user out. Surface it as a toast plus an ops alert; keep the session, keep the page, keep working.
- Keep the generic message in one shared constant read by both the proxy and the client classifier. Drift here turns a gateway 502 into "your credentials were rejected".
- Service-token cache: single-flight login promise, compare-and-clear on 401, failure backoff with one alert per window.

```ts
function clearCachedToken(token: string) {
  // a late 401 from an old token must not wipe a token another request minted
  if (cachedToken === token) cachedToken = null
}
```

- Backoff state is process memory — a multi-replica deploy gets one attempt and one alert per replica.

## 401 without a bearer is not a dead session

```ts
const handleUnauthorized = () => {
  if (isSigningOut) return
  // empty holder = not hydrated yet; signing out here destroys a live session
  if (!getSessionToken()) return
  isSigningOut = true
  signOut({ redirect: false }).finally(() => {
    window.location.replace(`/login?callbackUrl=${encodeURIComponent(location.pathname)}`)
  })
}
```

## Identity switch (SSO landing, account switch)

```tsx
const started = useRef(false)

useEffect(() => {
  // one link = one sign-in POST, even if the effect is re-invoked
  if (!router.isReady || started.current) return
  started.current = true
  if (!encryptedLoginId) return void window.location.replace(PORTAL_LOGIN)

  window.history.replaceState(null, '', '/sso-callback') // scrub before use
  const result = await signIn('credentials', { encryptedLoginId, redirect: false })
  if (result?.error) return void window.location.replace(PORTAL_LOGIN) // keep the old session
  await hydrateSessionToken()
  window.location.href = '/dashboard' // hard load: store + holders rebuilt
}, [router.isReady, encryptedLoginId])
```

```tsx
// SessionTokenSync: another tab switched identity while this one renders old data
const previous = previousToken.current
previousToken.current = token
if (previous && token && previous !== token) window.location.reload()
```

- A login token in the URL is a credential. When the business rule is "one login link = that individual user, always", a valid blob applies even over an active session. Write that as the acceptance criterion and record the login-CSRF tradeoff explicitly; the durable fix is a portal-side timestamp or single-use nonce inside the blob.
- Hard-navigate, not `router.push`: a full load rebuilds the store and module holders, so no cached query of the previous user survives.
- A rejected blob must leave the existing session intact and return to the portal.

## Protected-page gate

```tsx
const waiting = isProtectedRoute(pathname) && status === 'loading'

useEffect(() => {
  if (!waiting) return
  const timer = setTimeout(() => router.replace('/login'), SESSION_FETCH_DEADLINE_MS)
  return () => clearTimeout(timer)
}, [waiting, router])

if (waiting) return null
```

- The deadline is the difference between "protected page loads late" and "protected page stays blank forever".
- Holding on "authenticated but holder empty" needs render state, not a module read: the effect that fills the holder runs after the render that would open the gate.

## Callback param

```ts
const url = new URL(value, location.origin)
if (url.origin !== location.origin) return null
if (!/^\/(?![/\\])/.test(url.pathname)) return null // //host, /\host
return url.pathname + url.search
```

Same-origin check alone is not enough: `new URL(value, origin)` keeps the app origin for `//host` and `/\host` (WHATWG collapses the backslash) while the pathname points off-origin.
