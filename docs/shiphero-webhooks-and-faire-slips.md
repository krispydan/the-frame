# ShipHero Webhooks & Faire Packing Slip Workflow

Two-fer integration spec. Captures (1) how the-frame consumes ShipHero
webhooks and (2) the Faire-packing-slip-to-ShipHero attachment flow
that piggybacks on the same plumbing.

Audience: anyone debugging the Faire/ShipHero/Shopify hand-off, or
extending the webhook handlers later.

---

## TL;DR

```
Faire order  →  Shopify wholesale (via Faire→Shopify channel)
              →  ShipHero (via Shopify→ShipHero integration)
              →  ShipHero fires webhook (Order Allocated)
              →  the-frame receives webhook
              →  Detects Faire-sourced order
              →  GET Faire packing-slip PDF
              →  ShipHero mutation: attach PDF to order
              →  Warehouse prints Faire-branded slip with the picklist

Then when fulfillment happens:
ShipHero ships  →  fires Shipment Update webhook  →  the-frame
              →  Updates local orders.status = 'shipped', tracking, etc.
```

## Why we do this

Faire requires sellers to include Faire-branded packing slips when
shipping to retailers (so the unboxing experience stays Faire-branded).
ShipHero is our 3PL. Without this integration, the warehouse picks
from ShipHero's default packing slip — which is fine for DTC but
wrong for Faire orders.

Manual workaround would be: human downloads Faire's PDF from the
brand portal, uploads to ShipHero per order. Doesn't scale.

## Faire endpoint (verified working)

```
GET https://www.faire.com/external-api/v2/orders/{order_id}/packing-slip-pdf
Headers:
  X-FAIRE-ACCESS-TOKEN: <FAIRE_API_TOKEN>
Response:
  200 application/pdf
  Title metadata reads "Faire_Packing_Slip_<display_id>"
  ~60 KB typical
```

Faire order IDs are `bo_xxx` format (where `bo_` = "brand order").
The `display_id` is the human-readable code like `X4ECZ86SZT`.

There is **no `/payouts` endpoint at v2** — Faire embeds payout
data per-order under `payout_costs`. See `docs/faire-payout-sync.md`
(TBD) for the corresponding Xero journal pattern.

There is **no `/orders` list endpoint** for v1 — Faire deprecated v1
entirely. Hitting `/api/v1/products` returns 403 with
"v1 of the API is not available."

## ShipHero side

ShipHero exposes a GraphQL API at `https://public-api.shiphero.com/graphql`.
Auth is a long-lived JWT in the `Authorization: Bearer <token>` header.
The token is provisioned per-user in the ShipHero admin under
"My Account → Public API." Lifetime ~28 days; refresh tokens supported.

Webhook subscriptions are created via the `webhook_create` mutation,
not declaratively in a config file. They survive token rotation.

### Webhook topics we subscribe to

| Topic | When it fires | What we do |
|---|---|---|
| `Order Allocated` | Stock reserved, order ready to fulfill | Attach Faire packing slip (if applicable) |
| `Shipment Update` | Carrier label generated / scanned | Update local `orders.status = 'shipped'`, write tracking |
| `Order Canceled` (optional) | Order canceled in ShipHero | Mark local order canceled |

We intentionally skip:
- `Inventory Update` — too noisy; we rely on direct Shopify pulls for stock
- `Tote Complete` / pick events — operationally irrelevant to the-frame
- `PO Update` — purchase orders live in Frame, not ShipHero

### HMAC verification

ShipHero signs webhook bodies with HMAC-SHA256 using a shared secret
returned by `webhook_create`. Header is `x-shiphero-hmac-sha256`. Our
receiver verifies before dispatching to handlers; mismatches return
401 and are logged in `shiphero_webhook_events` with `hmac_valid = 0`.

### Attaching the slip

```graphql
mutation attachSlip($data: AttachDocumentInput!) {
  order_document_create(data: $data) {
    request_id
    complexity
  }
}
```

Where `data` includes the base64-encoded PDF, filename, and the
ShipHero order ID (the base64 GraphQL ID like `T3JkZXI6MTIzNDU=`).

The mutation name above is provisional; the exact mutation will be
confirmed via GraphQL introspection during Phase 1B and this doc
updated.

## Data model

Two new tables, both idempotent migrations in `src/lib/db.ts`:

### `shiphero_webhook_events`

Mirror of `shopify_webhook_events`. Every received webhook lands here
before dispatch — including invalid HMAC ones — so we can observe
what ShipHero is actually firing in production.

```
id              text PK
topic           text       -- "Order Allocated", "Shipment Update", etc.
shiphero_id     text       -- order ID extracted from payload (when present)
external_id     text       -- the shopify order # for cross-reference
triggered_at    text       -- ShipHero's timestamp if provided
received_at     text       -- our server clock
hmac_valid      integer
handler_ok      integer
handler_message text
payload_size    integer
payload_preview text       -- first 500 chars of the body for debugging
```

### `shiphero_webhook_subscriptions`

Tracks which webhooks we've registered with ShipHero. Populated by
the registration script (Phase 4). Used by the settings UI to show
"Subscribed to: Order Allocated, Shipment Update."

```
id             text PK     -- the ShipHero webhook UUID from their response
topic          text
url            text
shared_secret  text        -- encrypted/hashed; we just store enough to verify
created_at     text
deactivated_at text
```

### Existing tables we'll write to

| Table | Field | When |
|---|---|---|
| `orders` | `status`, `tracking_number`, `tracking_carrier`, `shipped_at` | on Shipment Update webhook |
| `shiphero_attachment_logs` (NEW) | order_id, faire_order_id, filename, status, attached_at | every packing-slip attach attempt; idempotency key prevents double-attach |

## Phased build plan

### Phase 1 — Foundation (sequential)

1. **Schema** — migrations + Drizzle types
2. **ShipHero GraphQL client extensions** — `webhookCreate()`, `webhookList()`, `orderDocumentCreate()`
3. **Webhook receiver** — POST `/api/v1/webhooks/shiphero`, HMAC verify, log, dispatch

### Phase 2 — Parallel modules (independent new files)

| Agent | File | Responsibility |
|---|---|---|
| A | `src/modules/integrations/lib/faire/packing-slip.ts` | `fetchFairePackingSlip(faireOrderId)` |
| B | `src/modules/integrations/lib/faire/order-matching.ts` | `findFaireOrderId(shipheroOrderId)` |
| C | `src/app/(dashboard)/settings/integrations/shiphero/page.tsx` | Settings UI |

### Phase 3 — Handlers (sequential)

- `order_allocated` → attach Faire packing slip
- `shipment_update` → update local order status

### Phase 4 — Onboarding + test

- `scripts/register-shiphero-webhooks.ts` (one-time setup + admin button)
- End-to-end test on a real order through staging

## Identifying Faire-sourced orders inside ShipHero

When Faire pushes an order through the Shopify channel, the resulting
Shopify order ends up with:

- A `tags` field containing `faire` (set by Faire's Shopify channel)
- A `source_name` of `faire` or similar
- The Faire `display_id` in the Shopify order `name` field, prefixed by `#`

In ShipHero, this propagates as the `order_number` field. The order
matcher's strategy:

```
ShipHero webhook arrives → has order_number like "#X4ECZ86SZT"
                        → strip "#"
                        → call GET /external-api/v2/orders?filter=display_id&value=X4ECZ86SZT
                        → 1 hit = our Faire order, return id "bo_xxx"
                        → 0 hits = not a Faire order, skip slip attach
```

This is robust to Shopify-channel ordering quirks because we identify
purely on the display_id match, not on any tag heuristic.

## Idempotency

ShipHero retries webhooks on non-2xx responses. Our handlers must be
idempotent:

- **Slip attach:** before uploading, check `shiphero_attachment_logs` for
  a successful row matching `(shiphero_order_id, faire_filename)`. If
  present, return 200 without re-uploading.
- **Shipment update:** target `UPDATE orders SET status='shipped'` is
  inherently idempotent; setting tracking twice with the same value
  is a no-op. The `eventBus.emit('order.shipped')` is the only side
  effect we should guard — emit only if `status` was not already
  `shipped` on the row.

## Ordering edge case

ShipHero may fire `Order Allocated` before Shopify finishes writing
all line items into our local `orders` table (since Shopify→Frame is
webhook-driven and asynchronous). Two layers of defense:

1. The order matcher calls Faire's API directly using the Shopify
   order_number from ShipHero's payload — doesn't depend on local
   `orders` table at all.
2. If the Faire match fails, the handler returns 200 anyway and logs
   `handler_message = "no Faire match"` to `shiphero_webhook_events`.
   ShipHero won't retry on 200, so we don't loop, but the event is
   visible in the settings UI for manual investigation.

## Environment

```
SHIPHERO_API_TOKEN     # JWT, ~28d expiry — refresh via SHIPHERO_REFRESH_TOKEN
SHIPHERO_REFRESH_TOKEN # used by api-client.ts to auto-refresh
FAIRE_API_TOKEN        # long string, no expiry — provisioned per brand in Faire portal
```

Set in Railway's `the-frame` service env vars. Not in repo.

## Operational checklist

When something looks broken:

1. **Settings → Integrations → ShipHero** — confirm subscriptions exist and recent events show up.
2. If subscriptions are missing: click "Register webhooks" or run
   `npm run shiphero:register-webhooks` locally.
3. If events arrive but handler errors: check `handler_message` column
   in `shiphero_webhook_events`. Common causes: Faire token expired
   (rotate in Faire portal), ShipHero token expired (refresh), Faire
   API rate-limited (back off, retry later).
4. If slip didn't attach despite handler_ok=1: verify Faire portal
   shows the order as shipped/processing (not pending review).
   Faire delays slip PDF generation until the order is in the right
   state.

## See also

- `docs/scheduled-jobs.md` — for any periodic backfill jobs
- `src/modules/operations/lib/shiphero/api-client.ts` — existing ShipHero client
- `src/app/api/v1/webhooks/shopify/route.ts` — pattern we're mirroring for Shopify
- `src/modules/integrations/schema/shopify.ts` — the events-table pattern we're cloning
