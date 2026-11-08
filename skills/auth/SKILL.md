---
name: auth
description: "Implements or migrates to NextAuth v4 credentials auth for Next.js App Router apps against an external REST IdP issuing bearer tokens: authorize() with server-side backend calls, session-token plumbing for RTK Query/fetch layers, middleware route guards, 401 retry and sign-out ladder, OTP registration and password-reset flows, social-login token exchange, deterministic post-login redirects. Use for 'nextauth', 'auth migration', 'login not redirecting', 'stuck on login page', 'refresh fixes login', 'protect routes', 'middleware auth', 'session token', 'signIn credentials', '401 handling', 'session outlives backend token', 'jwt sliding session', 'signOut on every 401', 'random sign-outs', 'signed out while browsing', 'sso account switch', 'third-party 401 logs the user out', 'blank protected page after refresh', 'otp login', 'social login', 'new auth integration'. NOT for OAuth-first setups, Auth.js v5, Firebase auth, or non-Next.js apps."
disable-model-invocation: true
---

`<skill-dir>` = this skill's directory (`location` attribute on the injected skill tag; normally `~/.pi/agent/skills/auth`). All `scripts/`, `references/`, `assets/` paths in this skill resolve under it — never the session cwd.

# auth

NextAuth v4 (next-auth@4.x) credentials architecture for Next.js App Router app, real IdP = external REST backend issuing bearer tokens. Followed end-to-end kills classic bug class: login resolves, loading stops, redirect never fires (or only after manual refresh).

## Entry point

- New integration — implementation sequence below, steps 1–5
- Migrating legacy custom auth (localStorage tokens, cookie-presence middleware, post-login side-effect chains) — [references/migration.md](references/migration.md) first, then sequence

## Architecture at a glance

```
Browser                        Next.js server                  External backend
───────                        ─────────────                   ────────────────
signIn("credentials",
        {redirect:false})  ──► authorize()
                                 POST /login ──────────────────► access_token
                                 GET  /profile (Bearer) ───────► user
                                 maps user + accessToken
                                 + sessionDuration (JWT exp)
                               sets httpOnly session cookie ◄── one response
await hydrateSessionToken()     (GET /api/auth/session)
router.push(callbackUrl |
            referrer | "/")
```

File map (every piece exists for a reason; skip none):

| File | Role |
|---|---|
| `lib/auth/index.ts` | public surface — import from `@/lib/auth`, never deep paths |
| `lib/auth/options.ts` | `authOptions`: credentials `authorize()`, social exchange in `jwt` callback, type augmentation, `auth()` = `getServerSession` |
| `lib/api.ts` | server-side backend REST wrappers (`loginApi`/`getProfileApi`) used by `authorize()` |
| `app/api/auth/[...nextauth]/route.ts` | 4-line route handler exporting GET/POST |
| `lib/auth/session.ts` | module-level token holder + `hydrateSessionToken()` |
| `components/provider/SessionTokenSync.tsx` | `useSession` → `setSessionToken` on every session change |
| `components/provider/AuthProvider.tsx` | `SessionProvider` + `SessionTokenSync` |
| `app/layout.tsx` | `const session = await auth()` → `<AuthProvider session>` (zero round-trip bootstrap) |
| `lib/auth/routes.ts` | protected/auth route lists + helpers |
| `proxy.ts` (or `middleware.ts`) | `getToken()` signature check, redirects both directions |
| `redux/features/api/apiSlice.ts` | `baseQueryWithAuth`: Bearer from `getSessionToken()`, 401 retry once, then signOut |
| `components/auth/LoginPageClient.tsx` | signIn → hydrate → redirect chain; OTP + register steps for OTP-gated backends |

## Implementation sequence (new integration)

1. NextAuth setup — `lib/auth/options.ts` + route handler + env (`NEXTAUTH_SECRET`, `NEXTAUTH_URL`). [references/nextauth-setup.md](references/nextauth-setup.md)
2. Route protection — `lib/auth/routes.ts` + `proxy.ts`. [references/route-protection.md](references/route-protection.md)
3. Token plumbing — `lib/auth/session.ts`, `SessionTokenSync`, `AuthProvider`, base query. [references/token-plumbing.md](references/token-plumbing.md); expiry, guards and identity switch: [references/session-boundaries.md](references/session-boundaries.md)
4. Flows — login client, register auto-signIn, logout helper: [references/login-flows.md](references/login-flows.md)
5. Optional — OTP registration/forgot-password: [references/otp-flows.md](references/otp-flows.md); Google/Facebook exchange: [references/social-login.md](references/social-login.md)

## Hard rules (each fixes a real observed bug)

- `authorize()` throws `new Error(backendMessage)` on bad credentials — never `return null`. With `signIn({redirect:false})` thrown message becomes `result.error` shown to user; `null` = generic failure.
- Class login failures by HTTP status before user sees them. Single catch in `authorize()` rethrowing one message collapses throttling, 5xx, network blips, token anomalies into it — valid credentials told "wrong password", every infra incident reported as frontend bug. Wrap backend calls with error type carrying status (`ApiError`-style), map: 401 → credentials message, 429 → too-many-attempts (wait a minute), else or network failure → service-unavailable. Report non-401 to Sentry/server logs; wrong passwords = expected user noise.
- Per-IP throttling invisible in client-side tests. Backends commonly rate-limit login per source IP (Laravel default throttle: 60/min); Next server funnels every user's login through one egress IP → peak traffic intermittently 429s valid logins — Postman/curl from dev machine = different IP, never reproduces. Throttle responses often HTML error pages: detect 429 by status before parsing body.
- All backend auth calls inside `authorize()`, server-side. Client-side post-login fetch chains (profile fetch → set-cookie → redirect) = root cause of no-redirect bug. One `signIn()` = one response = one cookie.
- `await hydrateSessionToken()` after every successful `signIn` (login, register auto-login, any programmatic sign-in) before any authorized request or redirect. `signIn({redirect:false})` resolves *before* `useSession` cache updates; stale empty token → anonymous requests → 401 → logout loop.
- Redirect = awaited `router.push(callbackUrl)` in the component — never `window.location.href` in an API layer, never conditional on profile fetch. Sanitize `callbackUrl` to same-origin relative path first — query param, user-controllable; `router.push("https://evil.com")` = open redirect.
- Session cookie maxAge = backend token `exp` (decode with `jose`) — always, no fallback. `authorize()` rejects tokens without usable expiry (`'Login token has no expiry'`); guessed lifetime (fixed 24h etc.) kills live sessions early or leaves expired ones minted. Custom `jwt.encode` override, not default. Derive it per encode (`backendExp - now`): next-auth re-encodes on every session read, so a login-time duration slides expiry — and set `session.expires` from `backendExp` so the client sees the same end. [references/session-boundaries.md](references/session-boundaries.md)
- API guard: `getToken()` + strict `backendExp <= now`. The middleware 120s buffer is a navigation fail-safe only — never copied into the API layer.
- 401 with no bearer attached = session not hydrated, not dead — do not sign out.
- A proxy for a second service never forwards that service's 401/403 (map to `502` + one generic message from one shared constant); other statuses pass through so the toast keeps the real reason. A third-party auth failure is a third-party problem: toast it and alert ops — never `signOut`, never a permission error on the app account.
- SSO landing: a valid blob applies even over an active session when that is the business rule, then hard-navigate; one link = one sign-in POST; an identity change in another tab reloads so no data of the previous user survives.
- `callbackUrl` sanitizer: a same-origin check alone passes `//host` and `/\host`; require exactly one leading slash on the resolved pathname.
- 401 ladder in base query: retry only if something can rotate the token between attempts (refresh endpoint, session re-fetch). Static module-holder token → retry byte-identical — skip, go straight to `signOut({redirect:false})` + `location.replace('/login?callbackUrl=...')` gated by `isProtectedRoute()` so public pages don't bounce. Sign-out single-flight: only base-query ladder owns it — `signOut` from per-request listeners = one expired token → N parallel 401s → N sign-outs → users logged out mid-action.
- **No token in localStorage, ever.** Only client-visible token copy = NextAuth session; API layers read via module holder.
- Social logins exchange provider token for backend token inside `jwt` callback — provider token never stored as app token.
- Logout revokes backend session server-side, not only local state; session token never attached to cross-origin or scheme-less URL.

## Hardening (from the repo review audit)

- AuthN+authZ server-side, never client-only: don't trust a forgeable cookie/local flag; never ship "all permissions" to every user.
- Every mutating route: authN + explicit permission. Every id-addressed read/write: caller owns/can access the record (IDOR).
- Login needs real credentials — no session for a bare id.
- Tokens: least privilege, never in client JS, never on cross-origin/scheme-less URLs, refresh before expiry.
- Cookies: `Secure`+`HttpOnly`+`SameSite`; no public-key "encryption" in localStorage.
- TLS verification never disabled, incl. proxy agents.
- Service worker: never cache authenticated responses across logout; no `skipWaiting`+runtime chunk rewrite stranding stale config.
- CSP+security headers set; no ids/secrets in access logs; rate-limit; container ports never bypass the proxy.
- No secret in client bundle, git history, image layers or logs — keys/webhooks/broker creds/tokens server-side/env only; check the built bundle after build.
- No unmaintained dep with known CVEs in the prod tree; audit prod deps, not just dev.

## Checklist

- [ ] `authorize()` throws with backend message; does all backend auth calls
- [ ] Login failures class-distinct: 401 credentials / 429 throttled / other or network → service-unavailable; non-401 causes captured server-side
- [ ] `hydrateSessionToken()` after signIn and register-auto-login; sets token + user holders
- [ ] Redirect chain: `callbackUrl` (same-origin validated) → same-origin referrer (≠ auth page) → default
- [ ] Route guard uses `getToken()` (signature-verified), not cookie presence
- [ ] Expiry derived per encode from the IdP token; `session.expires` matches it; no static fallback lifetime
- [ ] API routes reject past `backendExp`; page buffer 120s; buffer absent from the API layer
- [ ] Second-service proxy maps upstream 401/403 to 502; upstream text never reaches the browser
- [ ] 401 without an attached bearer does not sign out
- [ ] SSO/account switch: blob scrubbed from history, one sign-in POST, hard navigation, cross-tab reload; rejected blob keeps the session
- [ ] Callback param requires exactly one leading slash
- [ ] Unauthenticated on protected → `/login?callbackUrl=<path>`
- [ ] Base query: Bearer per request, 401 ladder (retry only with real token rotation), single-flight signOut fallback
- [ ] Session user typed from backend profile; components read domain/user fields via one accessor, not ad-hoc `session?.user?.x` chains
- [ ] Layout passes server session into `SessionProvider`
- [ ] OTP flows: plain endpoints, no auth side effects; resend cooldown enforced
- [ ] Social: provider token exchanged for backend token before session write
- [ ] AuthN+authZ server-side on every mutating route; id-addressed access verifies ownership (IDOR)
- [ ] Cookies `Secure`+`HttpOnly`+`SameSite`; no token in localStorage; TLS verification on (incl. proxy agents)
- [ ] No secret in client bundle (check built output); CSP/security headers set
- [ ] New integration: legacy-free day one. Migration: legacy storage/cookie/route code deleted, not dormant
