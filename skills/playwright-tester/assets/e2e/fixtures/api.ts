import type { Page } from "@playwright/test"
import { getAppPage } from "./cdp"

// API calls go through page.evaluate in the connected tab: same origin, same
// token the app uses — the crosscheck sees exactly what the server returns
// for the real session.
//
// Lesson (learned the hard way): tokens expire mid stress-run. Every helper
// below self-heals: on 401 it calls refreshAuth() once and retries.

export type Rec = Record<string, unknown>

export async function apiGet(
  page: Page,
  url: string,
  retry = true
): Promise<{ status: number; body: Rec }> {
  const token = await getToken(page)
  const res = await page.evaluate(
    async ({ url, token }) => {
      const r = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    },
    { url, token }
  )
  if (res.status === 401 && retry) {
    await refreshAuth(page)
    return apiGet(page, url, false)
  }
  return res
}

export async function getToken(page: Page): Promise<string> {
  // ADAPT: the app's localStorage token key
  const key = process.env.E2E_AUTH_TOKEN_KEY || "auth_token"
  return page.evaluate((k) => localStorage.getItem(k) || "", key)
}

export async function refreshAuth(page: Page): Promise<void> {
  // ADAPT: the app's login endpoint + credentials source.
  // Credentials must be supplied in E2E_EMAIL / E2E_PASSWORD — never hardcode.
  const { email, password } = getCredentials()
  await page.evaluate(
    async ({ email, password }) => {
      const r = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
      const body = await r.json()
      const token = body?.token || body?.data?.token
      if (token) localStorage.setItem("auth_token", token)
    },
    { email, password }
  )
}

function getCredentials(): { email: string; password: string } {
  const email = process.env.E2E_EMAIL
  const password = process.env.E2E_PASSWORD
  if (email && password) return { email, password }
  throw new Error("E2E_EMAIL / E2E_PASSWORD not set in environment")
}

// Lesson: APIs sometimes serialize nested objects as JSON strings (string
// blobs). Normalize before comparing or spreading — string spread yields
// numeric keys and silently seeds nothing.
export function parseBlob(v: unknown): Rec {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v)
      return p && typeof p === "object" ? (p as Rec) : {}
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" ? (v as Rec) : {}
}

// Deep-diff two records; ignores specified keys (e.g. server-derived fields
// the client never sends). Returns field-level diffs for the report.
export function diffRec(
  before: Rec,
  after: Rec,
  ignore: string[] = []
): { field: string; before: unknown; after: unknown }[] {
  const out: { field: string; before: unknown; after: unknown }[] = []
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const k of keys) {
    if (ignore.includes(k)) continue
    const b = JSON.stringify(before[k] ?? null)
    const a = JSON.stringify(after[k] ?? null)
    if (b !== a) out.push({ field: k, before: before[k], after: after[k] })
  }
  return out
}
