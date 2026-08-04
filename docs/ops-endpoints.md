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
| GET | `/api/admin/ops/amazon?view=status\|health\|month-end\|xero\|settlements` | Amazon channel diagnostics (read-only) |
| POST | `/api/admin/ops/amazon?confirm=1` | Amazon operations — see below |

The shared logic behind these lives in libs (`address-backfill.ts`,
`geocoding.ts`, `order-lookup.ts`) and is also used by the session-guarded
`/api/v1/*` equivalents the UI calls — one implementation, two front doors.

## Amazon channel operations

The Amazon UI and API live under `/api/v1/*`, which sits behind the login
middleware, so tooling cannot drive them. `/api/admin/ops/amazon` exposes the
same libraries through the token-guarded door.

```
GET  /api/admin/ops/amazon?view=status        archive + import counts, headline, unmapped SKUs
GET  /api/admin/ops/amazon?view=health        per-report sync health
GET  /api/admin/ops/amazon?view=xero          are the Xero mappings complete?
GET  /api/admin/ops/amazon?view=month-end&month=2026-07
GET  /api/admin/ops/amazon?view=settlements

POST /api/admin/ops/amazon?confirm=1
  { "action": "backfill", "from": "2026-06-01" }   full pull + import + bridge
  { "action": "sync-orders" }                       daily orders + import
  { "action": "sync-settlements" }                  settlements + bridge
  { "action": "sync-traffic" | "sync-inventory" }
  { "action": "import-only" }                       re-normalise from the archive
  { "action": "bridge-only" }                       re-derive settlements
  { "action": "post-xero", "dryRun": true }         build journals, post nothing
```

`import-only` and `bridge-only` re-derive from the local archive without
touching Windsor — the fast path after fixing a SKU alias or fee mapping.

**Posting to Xero is deliberately harder to trigger than anything else here:**
it needs `confirm=1` AND an explicit `"dryRun": false`. A journal is not easily
unpicked — the correction path is a reversing journal, not a delete — so the
safe outcome is what happens when a parameter is forgotten. Recommended
sequence: dry run → `"status": "DRAFT", "limit": 1` → review in Xero →
`"status": "POSTED"`.

## Reachability from Claude Code's sandbox

The sandbox has open outbound internet (Shopify, Faire, Nominatim, Railway API
all reachable). The **only** unreachable target is the app's custom domain
`theframe.getjaxy.com`. It resolves straight to Railway (69.46.46.67 — **not
Cloudflare**), and requests to that Host **hang** (TLS completes, then zero
response bytes). The proxy IP is NOT edge-blocked: a request to a
`*.up.railway.app` Host on the same IP returns instantly, so the hang is
specific to Railway's routing of the custom domain — not a WAF/bot block. To let
tooling reach these endpoints, do ONE of:

- **R2 (preferred):** use the service's Railway-generated `*.up.railway.app`
  public domain (Railway → service → Settings → Networking → Public Networking).
  Use the domain for THIS service — a stale/wrong one returns
  `{"message":"Application not found"}`. This origin skips the custom-domain path
  that hangs.
- **R3:** a project-scoped Railway token for server-side execution (`railway
  run`), bypassing the edge entirely.

(There is no Cloudflare in front of this domain, so a Cloudflare rule is not the fix.)

## Setup checklist / status

1. ✅ `OPS_TOKEN` is set as a **Railway env var** (server checks against it).
2. ✅ `OPS_TOKEN` is set in the **Claude Code environment** variables, so it's
   available to Claude sessions as `$OPS_TOKEN` (never printed/committed/chatted).
3. ✅ **Reachability is solved (Aug 2026).** Both routes work from the sandbox:
   - **R2:** `https://the-frame-production.up.railway.app` — the service's
     Railway-generated domain, discoverable from the Railway GraphQL API using
     the `RAILWAY_TOKEN` project token already present in the Claude Code
     environment (`Project-Access-Token` header, not `Bearer`).
   - The custom domain `theframe.getjaxy.com` **also responds now** — the hang
     documented below has resolved. The Railway domain is still preferred as it
     skips the custom-domain path entirely.

   Historical note (kept for context): the endpoints previously
   could only be driven from the browser. Preferred: R2 (the service's real
   `*.up.railway.app` public domain).
4. Verify once a route exists: from a Claude session,
   `curl --cacert /root/.ccr/ca-bundle.crt -H "x-ops-key: $OPS_TOKEN" <origin>/api/admin/ops`
   should return `{ ok: true, ... }`.

## For future Claude sessions

`AGENTS.md` → "Running things against production (ops endpoints)" is the
canonical pointer. The short version: reference `$OPS_TOKEN` from the shell,
call `/api/admin/ops/*` with `x-ops-key`, add `?confirm=1` for writes, and
route curl through `/root/.ccr/ca-bundle.crt`. Put new ops logic in a lib and
expose it from both the `/api/v1/*` (session) and `/api/admin/ops/*` (token)
routes.
