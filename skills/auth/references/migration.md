# Migration: legacy custom auth → NextAuth credentials pattern

Legacy shape replaced (any subset): token in localStorage (often AES-"encrypted" with `NEXT_PUBLIC` key — obfuscation, not security), helper POSTing to internal set-cookies route so middleware sees auth state, presence-only middleware cookie checks, post-login side-effect chains (profile fetch → cookie write → `window.location.href`) inside API-layer hooks.

## Legacy symptom → root cause (why migrating)

| Symptom | Legacy root cause |
|---|---|
| Loading stops but redirect never fires | Redirect conditional on post-login profile fetch that can fail silently (null user, `!res.ok`, network error) while auth cookie already set |
| Login "works" only after manual refresh | Middleware sees auth cookie + public login route → bounces to app; client-side redirect was the broken half |
| First request after login returns 401 | Mutation promise resolves on HTTP response, not session hydration; side-effect chain still in flight |
| Instant logout right after login | 401 handler fires on that unauthenticated first request |
| Forged-cookie access to protected shells | Middleware checked cookie presence; cookie client-mintable |

## Migration sequence

### Phase 0 — inventory (before any new code)

```bash
# token storage keys and readers
rg -n "localStorage|secureStorage|getItem\(" lib components redux hooks
# internal cookie routes
rg -ln "set-cookies|clear-cookies|Set-Cookie" app
# auth side effects in API layer (the bug class)
rg -n "onQueryStarted" redux
# presence-only route guards
rg -n "cookies.get" proxy.ts middleware.ts
```

Record: every reader of stored token/user, every writer, every redirect call site, logout path, 401 handler.

### Phase 1 — build alongside (zero user impact)

Add full new stack (SKILL.md steps 1–4) without touching legacy: `lib/auth/options.ts` + route handler, session-token plumbing, `AuthProvider`, `auth-routes.ts`. NextAuth cookie additive; legacy cookie/storage keep working. Base query change = only shared piece — feature flag or separate exported slice if legacy token must keep working during window.

### Phase 2 — cut over (one surface per deploy)

Order minimizes broken windows:

1. Login form → `signIn("credentials", ...)` + `hydrateSessionToken()` + redirect chain. Both cookies exist now; either authenticates.
2. Route guard → `proxy.ts` rewrite with `getToken()`; delete presence check. Keep legacy cookie readable (don't clear) so logged-in sessions survive to natural expiry.
3. API base query → read `getSessionToken()`, drop legacy storage read. Existing sessions without NextAuth cookie → 401 ladder → re-login once. Acceptable; announce if needed.
4. Logout → `signOut({ redirect: true, callbackUrl })` + cleanup helper.
5. Register / forgot-password / OTP → rewire submit handlers onto step machines via [otp-flows.md](otp-flows.md); endpoints usually unchanged.

### Phase 3 — delete legacy (never leave dormant)

Remove everything Phase 0 recorded: storage keys + crypto helpers, internal cookie routes, `setAuthData`/`clearAuthData`-style helpers, `onQueryStarted` side-effect blocks, dead redirect call sites, their tests. Sweep seams: `rg -n "<removed export>"` for every deleted export (leftover `import { STORAGE_KEYS }` after deleting constant = typecheck failure `ignoreBuildErrors` silently hides); run `npx tsc --noEmit` — error count must not grow vs baseline. Dormant legacy auth code = #1 source of "ghost sessions" reported months later.

### Phase 4 — parity verification (all must pass)

- [ ] Login → redirect lands without refresh, slow network too (throttle in devtools)
- [ ] Wrong password → backend message surfaces, button re-enables
- [ ] Deep link to protected route logged-out → `/login?callbackUrl=` → returns after login
- [ ] Logged-in visit to `/login` → bounced to app, not second session
- [ ] Session outlives hard refresh; dies with backend token expiry
- [ ] 401 mid-session → sign-out → login with return path (retry only if token rotation exists)
- [ ] Logout clears NextAuth cookie + app shell
- [ ] Register (OTP-gated) → auto-login → redirect, no manual step
- [ ] Social buttons (if present) → exchange → session → redirect

## Rollback

Each Phase 2 step independently revertible if legacy path kept compiling through window. Revert order = reverse of cut-over. After Phase 3 deletion, rollback = redeploy previous release; keep migration commits granular (one surface per commit) so that stays cheap.
