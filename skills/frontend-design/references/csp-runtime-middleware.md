# CSP runtime middleware (Next.js)

Ship `Content-Security-Policy` per request from `middleware.ts`, assembled from the runtime environment — never from `next.config` `headers()`, which bakes the policy at build time. Baking means every origin change needs a rebuild, and pipelines that substitute placeholder tokens into built artifacts can ship a literal `CSP_ORIGINS` token in the header (origins silently vanish) or corrupt a bundle outright.

Two moving parts: one module owns assembly + validation; middleware only stamps headers on every return path.

## lib/csp.ts — policy module

```ts
export interface CspEnv {
  CSP_MODE?: string // enforce | report-only | off — unknown falls back to enforce
  CSP_ORIGINS?: string // space/comma-separated source list
  SENTRY_CSP_REPORT_ENDPOINT?: string
}

export type ResponseHeader = { key: string; value: string }

// Boot-dead validation: the server refuses to start on a policy that would
// be broken, instead of silently serving one whose origins vanished.
export const validateCspEnv = (env: CspEnv): void => {
  const raw = env.CSP_ORIGINS
  if (raw === undefined || raw.trim() === '') {
    throw new Error('CSP_ORIGINS is required: the connect-src allowlist cannot be empty')
  }
  if (raw.trim() === 'CSP_ORIGINS') {
    throw new Error('CSP_ORIGINS holds its own placeholder name — pass the real origin list')
  }
  if (/["'`\n\r]/.test(raw)) throw new Error('CSP_ORIGINS must not contain quotes or line breaks')
  if (raw.includes(';')) {
    throw new Error('CSP_ORIGINS must not contain semicolons (CSP directive injection)')
  }
}

const originOf = (raw: string | undefined): string | null => {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['https:', 'http:'].includes(url.protocol) ? url.origin : null
  } catch {
    return null
  }
}

// The report endpoint keeps its full URL (path + query) — validate, don't
// reduce to origin.
const reportEndpointOf = (raw: string | undefined): string | null => {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return ['https:', 'http:'].includes(url.protocol) ? raw : null
  } catch {
    return null
  }
}

const policy = (connectSources: string[], scriptSources: string[]): string => [
  "default-src 'self'",
  `script-src ${scriptSources.join(' ')}`,
  "style-src 'self' 'unsafe-inline'",
  'img-src * data: blob:',
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  `connect-src ${connectSources.join(' ')}`,
  'report-to csp-endpoint', // one enforcing header; no report-only twin
].join('; ')

// Comma- or space-separated list. Bare ws:/wss: pass through (blanket
// schemes for per-session broker hosts); anything unparseable degrades to
// "source omitted" — CSP ignores invalid sources — rather than breaking
// the whole policy.
const originListOf = (raw: string): string[] =>
  raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .flatMap(entry => {
      if (entry === 'wss:' || entry === 'ws:') return [entry]
      if (entry.includes(';')) return []
      return [originOf(entry) ?? []].flat()
    })
    .filter(Boolean)

export const buildCspResponseHeaders = (env: CspEnv): ResponseHeader[] => {
  validateCspEnv(env)
  const origins = originListOf(env.CSP_ORIGINS ?? '')

  // Public vars: DIRECT member access only — see "Env reads" below
  const scriptSources = ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...origins]
  const connectSources = [
    "'self'",
    originOf(process.env.NEXT_PUBLIC_BASE_URL),
    originOf(process.env.NEXT_PUBLIC_SENTRY_DSN),
    ...origins,
  ].filter((source): source is string => source !== null)

  const mode = env.CSP_MODE?.trim() ?? ''
  if (mode === 'off') return []
  const headers: ResponseHeader[] = [
    {
      key: mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
      value: policy(connectSources, scriptSources),
    },
  ]
  const endpoint = reportEndpointOf(env.SENTRY_CSP_REPORT_ENDPOINT)
  // Unset endpoint: no header ships; `report-to` names an endpoint the
  // browser ignores — client-side violation capture still delivers.
  if (endpoint) headers.push({ key: 'Reporting-Endpoints', value: `csp-endpoint=${endpoint}` })
  return headers
}

// Boot-dead on the production server only. `next build` also evaluates this
// module with NODE_ENV=production and no CSP env, so the gate is NEXT_PHASE —
// and bracket access, so the check itself is never inlined away.
if (process.env['NEXT_PHASE'] === 'phase-production-server') {
  validateCspEnv(process.env as CspEnv)
}
```

## middleware.ts — stamp every return path

Keep existing middleware (auth, routing) as an internal function; a wrapper stamps headers on pass-through, redirects, and the fail-closed catch alike — any path that skips the wrapper ships no policy.

```ts
// Server-only keys: bracket access — the compiler never inlines them,
// so the running container's env is always read.
const CSP_ENV_KEYS = ['CSP_MODE', 'CSP_ORIGINS', 'SENTRY_CSP_REPORT_ENDPOINT'] as const

const readCspEnv = (): CspEnv => {
  const env: Record<string, string | undefined> = {}
  for (const key of CSP_ENV_KEYS) env[key] = process.env[key]
  return env as CspEnv
}

const withCspHeaders = (response: NextResponse): NextResponse => {
  for (const { key, value } of buildCspResponseHeaders(readCspEnv())) {
    response.headers.set(key, value)
  }
  return response
}

const middleware = async (request: NextRequest): Promise<NextResponse> =>
  withCspHeaders(await routeMiddleware(request)) // existing auth/routing logic

export default middleware

export const config = {
  // Document routes only — API responses and static assets need no policy
  matcher: ['/((?!api|_next/static|_next/image|images|icons|markers|favicon.ico).*)'],
}
```

## Env reads — the two channels

Public vars (`NEXT_PUBLIC_*`) are inlined at **build time**; server-only vars never are. In edge/middleware-bundled code each needs its own spelling:

- **Server-only keys → bracket access**: `process.env['CSP_ORIGINS']`, or the `CSP_ENV_KEYS` loop above. Nothing is baked; runtime env wins.
- **Public keys → direct member access only**: `process.env.NEXT_PUBLIC_BASE_URL` inlines to a **quoted** placeholder string; a deploy that substitutes placeholders lands the real value inside the quotes.

Never emit a **bare** public token in bundled source — deploys that rewrite bare tokens turn it into a broken bundle:

- Dot access `env.NEXT_PUBLIC_BASE_URL` minifies to `a.NEXT_PUBLIC_BASE_URL`, substitutes to `a.https://app.example.com`, and the `//` swallows the rest of the line: `SyntaxError: missing ) after argument list` — middleware dies, every route fails.
- A key-array string `'NEXT_PUBLIC_BASE_URL'` substitutes to the value itself: `process.env[<value>]` — a silent undefined lookup, origins vanish from the policy.

## Tests

Boot-dead validation and policy shape are unit tests against the module; the bare-token rule is pinned by a source scan:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('placeholder-token safety', () => {
  const sources: Record<string, string> = {
    'middleware.ts': readFileSync(join(process.cwd(), 'middleware.ts'), 'utf8'),
    'lib/csp.ts': readFileSync(join(process.cwd(), 'lib/csp.ts'), 'utf8'),
  }

  it.each(Object.entries(sources))(
    '%s mentions NEXT_PUBLIC_* only as process.env member access',
    (_name, source) => {
      expect(source.split('process.env.NEXT_PUBLIC_').join('')).not.toMatch(/NEXT_PUBLIC_[A-Z]/)
    }
  )
})
```

Also cover: validation throws on missing/placeholder/quote/semicolon values; `CSP_MODE` off/report-only/enforce fallback; middleware stamps the header on every return path (mock `getToken`, hit a public route, assert `response.headers.get('Content-Security-Policy')`).

## Deploy verification

Build with bare-name placeholders exactly as the pipeline does, replay the substitution over every bundle holding a token, syntax-check each:

```bash
NEXT_PUBLIC_BASE_URL=NEXT_PUBLIC_BASE_URL NODE_ENV=production next build

for f in $(rg -l 'NEXT_PUBLIC_[A-Z_]+' --glob '*.js' .next); do
  sed -e 's|NEXT_PUBLIC_BASE_URL|https://app.example.com|g' "$f" > /tmp/check.js
  node --check /tmp/check.js
done
```

Before the fix this reproduces the container's `SyntaxError: missing ) after argument list`; after it, every file passes.
