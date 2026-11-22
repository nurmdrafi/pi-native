# CSP middleware pattern (Next.js)

## The goal

CSP incidents are env-only operations. A misconfigured allowlist, a new
third-party source, or a host change on a live site is fixed by setting env
and restarting the container — never a rebuild, never a redeploy, never a
stale image shipping a broken policy. Implement it the way the reference
project ships it (runtime middleware delivery, everything volatile in env);
do not invent a variant.

CSP mechanics primer (directives, allowlist trade-offs, header vs meta,
strict-CSP recommendation): <https://web.dev/articles/csp>

Consequences that follow from the goal:

- Every origin-shaped source comes from env; code carries only the stable
  directive shape. Reachability changes are ops work, not releases.
- No CSP token may be baked into any build artifact (bundle, manifest,
  Dockerfile placeholder). An unsubstituted placeholder cannot exist if the
  token was never there.
- Invalid config fails boot-dead instead of serving a silently-weakened
  policy — a policy whose origins vanished is worse than a container that
  refuses to start, because half the app keeps working while maps,
  notifications, and live tracking break invisibly.

## Env contract (identical in every project)

- `CSP_ORIGINS` — the required origin allowlist, comma- or space-separated,
  feeding both script-src and connect-src. Bare `ws:`/`wss:` pass through as
  schemes.
- `CSP_MODE` — `enforce` (default), `report-only`, `off`. Unknown values fall
  back to enforce: a typo must never silently weaken or drop the policy.
  `off` emits no CSP headers (emergency rollback) — never a weaker policy.
- `SENTRY_CSP_REPORT_ENDPOINT` — violation report URL. Valid http(s) URL →
  `Reporting-Endpoints: csp-endpoint=<url>` header; the policy always carries
  `report-to csp-endpoint`. One policy, no report-only twin.

## Port checklist (the reference implementation, in order)

1. Middleware sets CSP headers on every HTML response — `next.config`
   `headers()` is build-time only and cannot do this job.
2. Server-only vars (`CSP_MODE`, `CSP_ORIGINS`,
   `SENTRY_CSP_REPORT_ENDPOINT`) read with computed member access
   (`process.env[key]` over a key list) — runtime container env; never
   Dockerfile build placeholders, never entrypoint substitution.
3. `NEXT_PUBLIC_*` values are the opposite: direct member access only
   (`process.env.NEXT_PUBLIC_BASE_URL`) — the compiler inlines a quoted
   placeholder the entrypoint substitution can safely fill. A quoted
   `NEXT_PUBLIC_*` literal in a key array is the trap: substitution rewrites
   the array element into the real value, the lookup then indexes env by an
   origin, and every origin silently vanishes while dev and tests stay
   green.
4. `validateCspEnv`: missing, equal to its own variable name, quotes/
   newlines, or semicolons → throw. Gate a module-load call on
   `process.env['NEXT_PHASE'] === 'phase-production-server'` (bracket
   access, so the compiler cannot inline it) — the container boots dead;
   dev/test surface the same error from the first header build. Unparseable
   entries degrade to source-omitted, never a broken policy.
5. Sanitizer semantics: split `/[,\s]+/`; `ws:`/`wss:` pass through as
   schemes; anything unparseable is omitted (CSP ignores invalid sources).
6. Pages Router delivery: middleware stamps the headers on
   `NextResponse.next()` responses; `_document` carries no CSP of any kind
   (no meta tag, no nonce attributes). A `<meta>` CSP cannot carry
   `frame-ancestors`, `report-uri`/`report-to`, or `sandbox` — header
   delivery only.
7. `script-src` is an allowlist: `'self' 'unsafe-inline' 'unsafe-eval'` +
   `CSP_ORIGINS`. Do not reach for nonce + `strict-dynamic`: strict-dynamic
   makes browsers ignore `'self'` and every host allowlist, so each script
   must carry the nonce — and next dev injects its chunks (react-refresh,
   HMR, webpack.js) plus inline-by-design scripts (CSS-in-JS style
   extraction) without one; every dev page then blocks. `'unsafe-eval'`
   covers deck.gl/luma.gl `new Function` shaders; `'unsafe-inline'` covers
   the inline-by-design scripts. `style-src` also needs `'unsafe-inline'`
   for CSS-in-JS (Ant Design cssinjs).
8. Middleware matcher excludes `_next/static`, `_next/image`, assets, and
   API routes; CSP governs HTML documents, and redirects need no CSP.
9. Tests: builder units (mode fallbacks, sanitizer, validation throws,
   env-origin pickup), middleware assertions (stamped header, public-page
   coverage), plus a source-scan pin: no quoted `NEXT_PUBLIC_*` literals in
   the policy module.
10. Ship new or changed policies through `CSP_MODE=report-only` first and
    watch the report endpoint — report-only is what caught the
    silent-origin-loss incident this pattern encodes.
11. `connect-src` = `'self'` + env origins + deployment endpoint origins +
    the scheme sources the app actually fetches. A frequent miss: icon and
    image loaders convert SVG text to `data:` urls and `fetch` them (deck.gl /
    luma.gl image loading does exactly this), so an enforced policy without
    `data:` in `connect-src` blanks map icons while every other request looks
    fine — the console shows `Fetch API cannot load data:image/svg+xml…`
    against the `connect-src` directive. `img-src data:` does not cover
    `fetch`. Verify on a live response instead of reading the builder:

    ```bash
    curl -sI <url> | grep -o "connect-src [^;]*"
    ```

    then exercise the icon path in a browser. Cross-check `img-src`,
    `font-src`, `media-src`, `worker-src` for the same `data:`/`blob:` gap
    whenever the app generates URLs client-side.

## References

- CSP overview, allowlist trade-offs, header vs meta:
  <https://web.dev/articles/csp>
- Strict CSP guide (why the article recommends nonces — and why the dev-mode
  constraint above overrides it here):
  <https://web.dev/articles/strict-csp>
- Directive reference: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy>
