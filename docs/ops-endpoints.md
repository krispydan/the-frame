# Operator / recovery endpoints (`/api/admin/ops/*`)

Token-guarded endpoints for one-off data recovery and diagnostics, callable by
tooling **without a browser session**. They exist so operations like geocoding,
address backfill, and order diagnostics can be run directly (e.g. from Claude
Code) instead of pasting `fetch()` snippets into the browser console.

## Auth

- Middleware exempts `/api/admin/*` from the NextAuth session gate
  (`src/middleware.ts`), so these routes gate on a shared secret instead.
- Send `x-ops-key: <OPS_TOKEN>` (or `?ops_key=`). `OPS_TOKEN` is a Railway env
  var — never commit it, never log it. Rotate/revoke by changing the env var.
- **Mutations** (POST) additionally require `?confirm=1`, so a write is always an
  explicit act. Read-only GETs need only the token.
- Implemented in `src/lib/ops-auth.ts` (`requireOpsToken`), constant-time compare.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/ops` | Index / token check — lists operations |
| GET | `/api/admin/ops/geocode?mode=count\|diag\|failures` | Geocode status / Nominatim reachability / failure breakdown |
| POST | `/api/admin/ops/geocode?confirm=1` | Run one geocode batch `{ limit, force, retryFailed, customersOnly }` |
| POST | `/api/admin/ops/backfill-addresses?confirm=1` | Fill blank company addresses from Shopify `{ stores, maxPages }` |
| GET | `/api/admin/ops/order-lookup?number=&accountId=` | Where an order actually lives vs. the account |

The shared logic behind these lives in libs (`address-backfill.ts`,
`geocoding.ts`, `order-lookup.ts`) and is also used by the session-guarded
`/api/v1/*` equivalents the UI calls — one implementation, two front doors.

## Reachability from Claude Code's sandbox

The sandbox has open outbound internet (Shopify, Faire, Nominatim, Railway API
all reachable). The **only** blocked host is `theframe.getjaxy.com` —
**Cloudflare in front of `getjaxy.com` drops the proxy's datacenter IP** (verified:
tunnel + TLS complete, then zero response bytes; every other host answers). To
let tooling reach these endpoints, do ONE of:

- **R1 (recommended):** Cloudflare rule — requests to `/api/admin/ops/*` carrying
  the `x-ops-key` header skip Bot Fight Mode / the IP filter.
- **R2:** provide the service's real `*.up.railway.app` domain (Railway →
  service → Settings → Domains) if it isn't Cloudflare-fronted.
- **R3:** a project-scoped Railway token for server-side execution (broadest).

## Setup checklist

1. Generate a strong random `OPS_TOKEN`; set it as a Railway env var.
2. Pick a reachability route (R1/R2/R3) above.
3. Verify: `GET /api/admin/ops` with the header returns `{ ok: true, ... }`.
