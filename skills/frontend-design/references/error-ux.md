# Failure UX architecture (frontend-design)

Read when adding async data to new UI, or whenever failure handling spans more than one layer (transport, store, component, window). Stack-agnostic — applies to any HTTP wrapper, store query layer, or interceptor.

## Ownership

- The single request layer (HTTP wrapper, store base query, interceptor) owns surfacing: every non-2xx failure toasts exactly once, globally. Per-request opt-out flag hands ownership to the caller for local UX.
- 401 is owned by the auth refresh/logout ladder — mark handled, redirect, never a generic toast. 403 = access-denied toast (backend message preferred), session intact.
- Cancellation — unmount, superseded/racing request, client timeout abort — is not a failure. No toast at any layer; filter by abort/timeout error names and messages.

## Message precedence (one extractor)

A single pure extractor (no UI imports — safe on the server) resolves any error shape to user text: backend body message first (any key, nested bodies, validation maps, stringified JSON, HTML error pages), then status text (statuses the backend actually emits; unknown codes name themselves), then network text, then the caller fallback. Never a hardcoded guess — a fixed string ("Already exists") shown on every 500 lies to the user.

```ts
const getApiErrorMessage = (error: unknown, fallback: string): string => {
  const body = pickBody(error) // walks response/data/error fields, parses stringified JSON
  const direct = firstString(body, ['message', 'error', 'msg', 'detail'])
  if (direct) return direct
  if (isValidationMap(body)) return joinUnique(flattenValues(body)) // {name: ['Name is required']}
  if (hasNestedBody(body)) return getApiErrorMessage(body.data, fallback)
  if (hasStatus(error)) return STATUS_TEXT[error.status] ?? `Request failed with status ${error.status}`
  if (isNetworkFailure(error)) return NETWORK_ERROR_MESSAGE // includes timeout aborts
  return fallback
}
```

## Single toast (identity dedupe)

```ts
const toasted = new WeakSet<object>()

const markToasted = (error: unknown) => {
  if (error !== null && typeof error === 'object') toasted.add(error)
}
const wasToasted = (error: unknown) =>
  error !== null && typeof error === 'object' && toasted.has(error)

// Transport layer: the one place failures become visible
const showGlobalErrorToast = (error: unknown) => {
  if (wasToasted(error)) return
  if (isAuthError(error)) return // logout/refresh ladder owns the UX
  if (isCanceled(error)) return // unmount, superseded request, client timeout
  if (error?.config?.skipGlobalErrorMessage) return
  toast.error(getApiErrorMessage(error, FALLBACK))
  markToasted(error)
}
```

Local handlers add context only when the owner stayed silent; window-level handlers (`unhandledrejection`, `error`) check the same set — background bursts dedupe by identity plus a short time window. Toast keys replace instead of stack: same key = same incident.

```ts
} catch (error) {
  if (!wasToasted(error)) toast.error(getApiErrorMessage(error, LOCAL_FALLBACK))
}
```

## Resolved-error trap

Data layers may deliver failures as a resolved value carrying an error field instead of rejecting. Branch on it before the empty-state check — otherwise a 500 renders as "No data found". Reserve empty-state copy for verified success with zero rows.

```ts
// Wrong: a resolved failure flows into the empty branch → "No data found"
const res = await trigger()
if (res.data?.rows.length) renderRows(res.data.rows)
else showEmptyState()

// Right: branch on the error field first; transport already toasted it
const res = await trigger()
if (res.error) return
if (res.data?.rows.length) renderRows(res.data.rows)
else showEmptyState()
```

## Tests that pin it

- Failure (500/timeout) → failure message shown, empty-state text never.
- Success with zero rows → empty-state text shown.
- Global + local catch on the same failure → exactly one toast.
