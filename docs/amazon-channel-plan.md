# Amazon Sales Channel — Integration Plan (via Windsor AI)

**Status:** Rev 2 — for review before development starts.
**Prepared:** 2026-08-04
**Decision made in review:** Amazon orders **will be imported** into The Frame's `orders` table
(`channel='amazon'`), but must **never** be pushed to Shopify or ShipHero — they are fulfilled by
Amazon (FBA) or already reach ShipHero through Amazon's own channel, and a push from The Frame
would double-ship. Rev 1's "aggregate-only" option is dropped.

**Scope:** Connect to the Amazon Seller account through Windsor AI; replicate the Shopify
channel's finance capabilities — daily journal entries, COGS, month-end reporting — and add a
dashboard to monitor Amazon sales. Fulfilment stays entirely outside The Frame.

---

## 1. Account status — verified live, already selling

Probed directly against the Windsor API (not assumed from docs):

| Item | Value |
|---|---|
| Windsor account | `danielgetjaxycom` |
| Connector slug | **`amazon_sp`** (`amazon`, `amazon_seller` etc. do not exist) |
| Amazon seller account | `ANJN3RZT0R4T5-US`, Amazon.com (US only), USD only |
| Field catalog | 899 fields across **24 reports** (`GET /amazon_sp/fields`) |
| Settlement data | 288 rows, 3 settlements, 4 Jun → 25 Jul 2026 |
| Orders, last 7 days | 21 lines — 20 FBA, 1 Merchant-fulfilled |
| Other connectors | **None connected** (`amazon_ads`, `shopify`, `facebook`, `tiktok_shop`, `google_ads`, `klaviyo` all return "no account") |

### Trading results so far (settlements, 4 Jun – 25 Jul)

| Line | Amount |
|---|---|
| Product sales (Principal) | **$1,652.00** |
| Promotions | **−$1,176.00** (71% of gross — launch discounting) |
| FBA fulfilment fees | −$205.32 |
| Referral commission | −$36.40 |
| Refunds (principal) | −$112.00 |
| Subscription fee | −$79.98 |
| Inbound transportation | −$21.30 |
| **Net settled** | **$19.99** |

The promotions ratio is the story of this channel right now, and the dashboard is designed
around making it visible (gross vs promo vs net, per day and per SKU).

---

## 2. Hard constraints (verified by probing)

1. **Settlement history is capped at 90 days.** Older requests return an explicit error.
   Windsor is *not* a system of record → every settlement row must be archived locally,
   permanently, on first sight. **This makes Phase 1 time-sensitive: data older than the rolling
   window is unrecoverable.**
2. **One report per API call**; every field must use its report-prefixed name
   (`v2_settlement_report_data_flat_file_v2__amount`). Generic names don't resolve.
3. **Reports are generated asynchronously on Amazon's side.** A 90-day all-orders request hung
   past 5 minutes; the same request over 7 days returned in 1.8s. First-ever requests for a
   report type can time out even on narrow windows while Amazon generates the report, then
   succeed later from cache. → The client must use **≤7-day windows, long timeouts, and
   retry-with-backoff that tolerates cold-report generation** (treat a timeout as "try again
   next run", not as failure).
4. **The current day has no data** (SP-API limitation) → T-1 is the newest day; always re-pull a
   trailing window because Amazon restates recent days.
5. **Dirty columns:** settlement `currency`, `deposit_date`, `marketplace_name` are often empty.
   Default currency `USD`; derive dates from the settlement header rows.
6. **SKU format:** ours plus optional `-FBA` (`JX1010-TOR-FBA`, `JX4006-BLK`). Strip suffix →
   `catalog_skus`, fall back to `catalog_sku_aliases`; unmapped SKUs raise `cogs_exceptions`.

### Reports we will use

| Windsor report (table prefix) | Purpose | Key fields |
|---|---|---|
| `flat_file_all_orders_data_by_order_date_general` | **Order import** | amazon_order_id, sku, asin, quantity, item_price, item_tax, item_promotion_discount, order_status, item_status, fulfillment_channel, purchase_date, last_updated_date, ship_city/state/postal/country, currency |
| `amazon_fulfilled_shipments_data_general` | **shipped_at + tracking** for FBA lines | amazon_order_id, amazon_order_item_id, sku, quantity_shipped, shipment_date, tracking_number, fulfillment_center_id |
| `v2_settlement_report_data_flat_file_v2` | **Journals / payouts** | settlement_id, posted_date, transaction_type, amount_type, amount_description, amount, sku, order_id, quantity_purchased, settlement_start/end_date, deposit_date, total_amount |
| `sales_and_traffic_report_by_date` | **Dashboard analytics** | orderedProductSales, unitsOrdered/Shipped, sessions, pageViews, buyBoxPercentage, unitSessionPercentage, refundRate |
| `flat_file_returns_data_by_return_date` | Returns detail (month-end) | order_id, merchant_sku, return_reason, refunded_amount, resolution |
| `fba_reimbursements_data` | Amazon-lost/damaged inventory payouts (month-end income) | reimbursement_id, reason, sku, amount_total, quantity_reimbursed_* |
| `fba_myi_unsuppressed_inventory_data` | FBA stock on hand (dashboard + inventory qn) | sku, afn_fulfillable/inbound/reserved/unsellable_quantity |

Not used initially: seller-performance, VAT, brand analytics, restock recommendations, ledger
views, estimated-fees, open listings (available later if wanted).

---

## 3. Why "import but never push" is safe — verified, not assumed

A full sweep of every side-effect path that reads `orders` found:

**The Frame has no code path that can create an order in ShipHero or Shopify.** The ShipHero
client's only mutations are webhook management, packing notes, and attachments; the Shopify
client's order surface is read-only plus fulfilment marking that is hard-gated to
`shopify_dtc`/`shopify_wholesale` with a Shopify `external_id`. Orders reach ShipHero via the
native Shopify↔ShipHero integration — The Frame is a passive observer on that leg. So
double-shipping *from The Frame* is structurally impossible; what remains is preventing Amazon
rows from being **mis-matched by inbound webhooks** or picked up by unfiltered scans/alerts.

### 3a. Structural defence (cheap, covers unknown future code)

- **`order_number = 'AMZ-' + amazon_order_id`** (e.g. `AMZ-111-9094194-1536224`) and
  **`external_id = 'amazon:' + amazon_order_id`**. The most dangerous matcher —
  `findLocalOrderIdByShipHeroSignals` (`src/modules/operations/lib/shiphero/activity-log.ts:51-72`),
  which falls back to fuzzy `order_number` matching with `ORDER BY created_at DESC LIMIT 1` —
  becomes structurally unable to hit an Amazon row, since no ShipHero `partner_order_id` will
  ever carry those prefixes.
- **`company_id = NULL`** on all Amazon orders. Amazon buyers are not CRM companies. This single
  choice makes four unfiltered paths inert: customer-account LTV stats
  (`account-sync.ts:47-79`), wholesale-conversion first-order counter
  (`wholesale-conversion.ts:189`), mail-suppression scan
  (`shopify-wholesale-customer.ts:680`), and Meta CAPI conversion events (`meta/capi.ts:118`).
- **`shipped_alert_sent_at` pre-stamped** at import → the "order fulfilled" Slack alert's atomic
  claim (`notify-fulfilled.ts:72-77`) can never fire for Amazon rows.
- **Status mapping never lands on `confirmed`** (see §5), so the stuck-order scan
  (`scan-stuck-orders/route.ts:39`, alerts on `confirmed` >48h) has nothing to match even
  before its guard is added.

### 3b. Explicit channel guards (exact edit list)

| File:line | Change |
|---|---|
| `src/modules/operations/lib/shiphero/activity-log.ts:53,59,66` | `AND channel != 'amazon'` on all three lookups (webhook → local order matcher) |
| `src/modules/operations/lib/shiphero/sync-orders.ts:48` | `AND channel != 'amazon'` (ShipHero order matching scan) |
| `src/app/api/v1/integrations/slack/scan-stuck-orders/route.ts:39` | `AND channel != 'amazon'` |
| `src/modules/inventory/lib/sell-through.ts:51` | `AND o.channel != 'amazon'` — FBA sales must not inflate ShipHero warehouse velocity / reorder flags |
| `src/modules/orders/lib/fulfillment.ts` (via UI) | Hide manual "Mark shipped" actions for `channel='amazon'` in `/orders` UI — harmless today (pushes nothing) but confusing |

Already safe, no change needed (verified gates): Faire ship-marking (`channel` gated), Faire
backfill route, Shopify fulfilment push (`channel` + `external_id` gated), Pipedrive sync
(regex-gated to wholesale/faire), Shopify webhooks (match on Shopify numeric `external_id`),
revenue recognition (`SUPPORTED_CHANNELS` allowlist — amazon added deliberately in Phase 5),
Faire/Shopify payout syncs.

### 3c. Cosmetic/UI updates

`channelConfig` in `orders/page.tsx:87` and `[id]/page.tsx:123` (badge + filter option);
`platformLabel` in `slack/digests.ts:218`; `channelLabel` in `daily-cogs.ts:329`; the
"View in Shopify" link branch in `[id]/page.tsx:381` → "View in Seller Central"
(`https://sellercentral.amazon.com/orders-v3/order/{amazon_order_id}`); the "Fulfilment is
managed in ShipHero/Shopify" copy at `[id]/page.tsx:670` → "Fulfilled by Amazon (FBA)".

### 3d. Schema facts that matter

- `orders.channel` has **no DB CHECK constraint** (TypeScript enum only) — adding `"amazon"` to
  the enum in `src/modules/orders/schema/index.ts:16-18` is a type-level change; no migration.
- **No unique index on `order_number` or `external_id`** — import idempotency must be app-level
  (`SELECT … WHERE external_id = ?` before insert, the same pattern as `shopify-webhooks.ts:377`).
- `orders.status` enum already includes `pending` — used for Amazon's Pending state.

---

## 4. Architecture

```
Windsor AI (amazon_sp connector; later: tiktok_shop, facebook, amazon_ads)
        │  ≤7-day windows · 1 report/call · retry w/ cold-report tolerance
        ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. Generic Windsor client (connector-agnostic)                 │
│    src/modules/integrations/lib/windsor/client.ts              │
├────────────────────────────────────────────────────────────────┤
│ 2. RAW LANDING (append-only, permanent — beats the 90-day cap) │
│    amazon_settlement_rows · amazon_order_rows ·                │
│    amazon_shipment_rows · amazon_sales_traffic_daily           │
├────────────────────────────────────────────────────────────────┤
│ 3. NORMALISE                                                   │
│    orders + order_items (channel='amazon', guarded)            │
│    settlements + settlement_line_items (external bridge)       │
├────────────────────────────────────────────────────────────────┤
│ 4. EXISTING MACHINERY (rides for free once channel wired)      │
│    daily-cogs (FIFO) · revenue recognition · Xero journals ·   │
│    P&L · reconciliation · Slack digests                        │
├────────────────────────────────────────────────────────────────┤
│ 5. Dashboard  /finance/amazon  +  existing channel surfaces    │
└────────────────────────────────────────────────────────────────┘
```

Principles:

- **Normalise from our own tables, never from Windsor.** Raw rows land append-only with natural
  idempotency keys; every downstream artefact (orders, journals, dashboards) is re-derivable
  locally forever, even after Windsor's window closes.
- **The Windsor client is connector-agnostic from day one** —
  `fetchWindsorReport({ connector, fields, dateFrom, dateTo })` handling auth, prefixed fields,
  window chunking, backoff, and cold-report timeouts. Amazon is the first caller; TikTok Shop /
  Facebook ads later become a config entry + mapper, not a new integration.
- `WINDSOR_API_KEY` as env var (Railway + local) — never committed. Fail loudly if unset.

---

## 5. Order import — detailed design

**New lib:** `src/modules/orders/lib/amazon-sync.ts` (mirrors `faire-sync.ts` in shape).
**New route:** `src/app/api/v1/orders/amazon-sync/route.ts` (GET = status, POST = trigger),
called by cron like `shopify-orders-sync` is.

### Pipeline per run

1. **Pull** `flat_file_all_orders_data_by_order_date_general` for a trailing window
   (default 7 days; backfill mode accepts explicit ranges, chunked ≤7 days per call).
2. **Land** rows into `amazon_order_rows` (upsert on `(amazon_order_id, sku)` — later pulls
   update status/last_updated_date).
3. **Pull** `amazon_fulfilled_shipments_data_general` for the same window → land into
   `amazon_shipment_rows` (upsert on `(shipment_id, amazon_order_id, sku)`).
4. **Normalise** into `orders` / `order_items`:
   - Idempotency: `SELECT id FROM orders WHERE external_id = 'amazon:'+amazon_order_id`;
     insert or update.
   - One `orders` row per Amazon order; one `order_items` row per SKU line.
5. **Set `shipped_at`**: FBA lines from `amazon_shipment_rows.shipment_date` (earliest shipment
   for the order); Merchant-fulfilled lines fall back to `last_updated_date` when
   `item_status='Shipped'`. Tracking number from the shipments report where present.

### Field mapping

| `orders` column | Source |
|---|---|
| `channel` | `'amazon'` (add to enum) |
| `order_number` | `'AMZ-' + amazon_order_id` |
| `external_id` | `'amazon:' + amazon_order_id` |
| `company_id` / `contact_id` | **NULL** (deliberate — §3a) |
| `status` | Pending→`pending` · Shipped (all lines)→`shipped` · partially→`shipped` when any line shipped · Cancelled→`cancelled`. **Never `confirmed`/`picking`/`packed`.** |
| `subtotal` | Σ item_price (flat-file item_price is the line total, i.e. unit×qty — verify against a multi-qty line during dev) |
| `discount` | Σ item_promotion_discount + ship_promotion_discount (stored positive) |
| `shipping` | Σ shipping_price |
| `tax` | Σ item_tax + shipping_tax (facilitator tax — Amazon remits; see §7) |
| `total` | subtotal − discount + shipping + tax |
| `currency` | `USD` default |
| `source_name` | `'amazon'`; `ship_to_name` NULL; `ship_to_country` NULL (keeps intl-shipping email path inert); ship city/state kept on the raw row only |
| `shiphero_order_id` | **NULL, always** |
| `placed_at` | purchase_date · `shipped_at` per above · `shipped_alert_sent_at` pre-stamped at import |

| `order_items` column | Source |
|---|---|
| `sku` | Amazon SKU verbatim (e.g. `JX1010-TOR-FBA`) |
| `sku_id`/`product_id` | resolve after stripping `-FBA`; alias fallback; NULL + exception if unmapped |
| `quantity` | quantity (note: arrives as TEXT — parse) |
| `unit_price` | item_price ÷ quantity |
| `total_price` | item_price |

### What the importer must NOT do

No `company_id` (no `findOrCreateCompany`), no `ensureCustomerAccount`, no
`detectWholesaleConversion`, no `syncOrderToPipedrive`, no `createInventoryMovements`
(FBA stock isn't in ShipHero's warehouse; the hourly `shiphero-inventory-sync` would overwrite
any decrement anyway), no international-shipping email, no `order.created` Slack noise
(emit the event-bus activity row only — there are zero registered listeners today, verified).

### Cancellations & refunds

- Re-pulls flip `status` to `cancelled` when Amazon cancels (pending orders cancel often).
- Refunds do **not** un-ship an order: financial effect arrives via the settlement journal
  (§7) and the returns report feeds month-end reporting. If a refunded line was already
  COGS-depleted, it stays depleted (goods are gone or come back via FBA returns — Amazon
  restocks sellable returns into FBA; reflected in FBA inventory counts, not ShipHero).

---

## 6. Schema — new tables

All new tables must be added in **three** places: the Drizzle schema file
(`src/modules/integrations/schema/amazon.ts`, new), the boot DDL in `src/lib/db.ts`, and the
test DDL in `src/__tests__/setup.ts`. (Established repo constraint — tests fail otherwise.)

```
amazon_order_rows            -- raw all-orders report, permanent
  id, amazon_order_id, sku, asin, quantity, item_price, item_tax,
  item_promotion_discount, ship_promotion_discount, shipping_price, shipping_tax,
  order_status, item_status, fulfillment_channel, sales_channel, currency,
  purchase_date, last_updated_date, ship_city, ship_state, ship_postal_code,
  ship_country, is_business_order, raw_json, ingested_at, updated_at
  UNIQUE app-level: (amazon_order_id, sku) — upsert

amazon_shipment_rows         -- raw FBA shipments report, permanent
  id, shipment_id, shipment_item_id, amazon_order_id, amazon_order_item_id, sku,
  quantity_shipped, shipment_date, estimated_arrival_date, carrier, tracking_number,
  fulfillment_center_id, item_price, item_promotion_discount, raw_json, ingested_at
  UNIQUE app-level: (shipment_id, amazon_order_id, sku)

amazon_settlement_rows       -- raw settlement report, permanent (the 90-day insurance)
  id, settlement_id, posted_date, transaction_type, amount_type, amount_description,
  amount, currency, sku, order_id, quantity_purchased, marketplace_name,
  settlement_start_date, settlement_end_date, deposit_date, total_amount,
  raw_json, ingested_at
  UNIQUE app-level: (settlement_id, order_id, sku, amount_type, amount_description,
                     posted_date, amount)  -- settlement re-pulls are append-skip, never update

amazon_sales_traffic_daily   -- sales & traffic analytics (dashboard)
  id, date, gross_sales, units_ordered, units_shipped, total_order_items,
  refund_rate, sessions, page_views, buy_box_pct, conversion_rate, avg_selling_price,
  ingested_at, updated_at
  UNIQUE: (date) — upsert (Amazon restates recent days)

amazon_sync_state            -- per-report watermark
  report_name PK, last_synced_through, last_run_at, last_status, last_error, rows_ingested
```

Existing-table edits:
- `orders.channel` enum += `"amazon"` (`src/modules/orders/schema/index.ts:17`)
- `xero_account_mappings`: add `_shared` rows for `deferred_revenue` (2050) and
  `receivables_holding` (1100) — required by loaders, absent from the suggestion catalog
- `PLATFORM_CATEGORY_SUGGESTIONS.amazon` (`src/modules/integrations/schema/xero.ts:189`) +=
  the new fee categories from §7 (promo contra, FBA fees, storage, subscription)

---

## 7. Daily journal entries — settlement pipeline & fee taxonomy

**New lib:** `src/modules/integrations/lib/amazon/payout-sync.ts`, cloned from the Faire
orchestrator (`faire/payout-sync.ts`) — the proven second-channel pattern:

1. Open `xero_sync_runs` row (`kind:'amazon_settlements'`, `source_platform:'amazon'`).
2. `loadAmazonConfig()` — resolve required account mappings from
   `xero_account_mappings` (`['amazon','_shared']`, platform wins) + tracking option; throw a
   helpful error listing missing categories ("add them under Settings → Integrations → Xero").
3. Pull settlement rows (≤90-day window) → append-skip into `amazon_settlement_rows`.
4. Group by `settlement_id`. A settlement is **postable when its period has closed**
   (`settlement_end_date` past) and all rows are present (`total_amount` header row seen).
5. Idempotency: `xero_payout_syncs (source_platform='amazon', source_payout_id=settlement_id)`
   — checked before posting, inserted **only after** success, so failures retry next run.
6. Build journal/invoice from the taxonomy below → post → `xero_journal_log` every attempt →
   synthetic `settlements` + `settlement_line_items` bridge rows
   (`external_id='amazon_settlement_'+id`, `channel='amazon'`, line items linked to local
   orders via `external_id='amazon:'+order_id`) → Slack summary → 1.1s throttle between posts
   (Xero ~60 req/min).

### Fee taxonomy → account mapping (observed in our real data, all 288 rows classified)

| transaction_type | amount_type | amount_description | Meaning | Account |
|---|---|---|---|---|
| Order | ItemPrice | Principal | Gross product sales | 4010 Sales – Amazon (CR) |
| Order | ItemPrice | Tax | Sales tax collected | 2230 Sales Tax (CR) |
| Order | ItemWithheldTax | MarketplaceFacilitatorTax-Principal | Tax withheld/remitted by Amazon | 2230 (DR) — legs net to zero, post both |
| Order | ItemPrice | Shipping | Shipping income | 4060 Shipping Income (CR) |
| Order | Promotion | Principal | Launch/coupon discounts | **4020 Sales Discounts – Amazon (DR, contra-revenue — 71% of gross, must be its own line)** |
| Order | Promotion | Shipping | Shipping promo | 4060 (DR) |
| Order | ItemFees | Commission | Referral fee | 5410 Merchant Fees – Amazon (DR) |
| Order | ItemFees | FBAPerUnitFulfillmentFee | FBA pick/pack/ship | **5415 FBA Fulfilment Fees (DR)** |
| Refund | ItemPrice | Principal | Refunded sales | 4300 Sales Returns (DR) |
| Refund | ItemPrice | Tax / ItemWithheldTax | Tax legs reversed | 2230 (net zero) |
| Refund | ItemFees | Commission | Referral credited back | 5410 (CR) |
| Refund | ItemFees | RefundCommission | Refund admin fee | 5410 (DR) |
| FBAFees | FBA Amazon-Partnered Carrier Shipment Fee | Base fee / Discount | Inbound freight (currently nets to 0) | 5010 COGS Freight (DR) |
| FBAFees | FBA Inventory Storage Fee | Base fee | Monthly storage | **5420 FBA Storage Fees (DR)** |
| other-transaction | — | Subscription Fee | Pro seller subscription | **5430 Amazon Subscription (DR)** |
| other-transaction | — | Inbound Transportation Fee | Freight to FBA | 5010 (DR) |
| other-transaction | — | Shipping label purchase for return | Return label | 5300 Outbound Shipping (DR) |
| other-transaction | — | Payable to Amazon / Successful charge | Card charge covering negative balance | 1030 Amazon Clearing (pair nets to 0) |
| Transfers | Micro Deposit | Micro Deposit | Bank verification penny | 1030 Amazon Clearing |

**Unknown-type handling:** Amazon will introduce descriptions we haven't seen (storage
overage, LTSF, disposal, removal, Vine enrolment…). Unmapped rows post to a suspense line
(5460-equivalent "Amazon – Unclassified", config category `unclassified`) **and raise a Slack
alert**, never silently absorbed. The classifier is a pure function
(`classifySettlementRow(row) → category`) with a unit test locking every known mapping.

**Accounts in bold need creating in Xero** (or mapping onto existing codes) — decision item.

### Posting model — honour the existing `payout_revenue_model` switch

- **`invoice` (settlement-date):** one ACCREC invoice per settlement, number
  `AMZN-{settlement_id}` (prefix already reserved in `settlement-revenue.ts`), gross sales
  positive lines, every fee negative, invoice total = deposit → 1-click bank match. Implemented
  as a pure `amazonSettlementToComponents()` adapter in
  `settlement-invoice-builder.ts`, unit-tested like the Shopify/Faire adapters. Net-negative
  settlements (possible in launch months) → credit-note path, same guard the builder already has.
- **`deferred`:** manual journal — CR 2050 deferred revenue gross, DR fee accounts, DR 1100
  receivables holding net; then `postBankTransactionReceive` 1030 ← 1100 (Xero forbids manual
  journals on BANK accounts). Stage-2 recognition then handles per-order sales posting (§8).

Whichever model Shopify/Faire currently run is what Amazon uses — consistency across the P&L.

---

## 8. COGS & revenue recognition — rides existing machinery

Because Amazon orders are real `orders`/`order_items` rows with `shipped_at`, both daily
finance jobs pick them up with only allowlist/label edits:

**Daily COGS** (`runDailyCogsPosting`, cron 16:45 UTC) — its shipped-lines query has **no
channel filter**, so Amazon lines flow in automatically the day they ship. Required before
enabling (sequencing matters — the Xero mappings must exist first or journals fall back to
default accounts with no tracking):
- `channelLabel()` in `daily-cogs.ts:329` += `amazon` case
- Amazon Xero account mappings + tracking option created (Phase 4 precedes Phase 5)
- SKU resolution: `resolveDepletionTarget` handles pack-size + aliases already; add `-FBA`
  suffix stripping either as `catalog_sku_aliases` rows (no code change, one row per FBA SKU —
  34 today) **or** a suffix-strip in the resolver. **Recommend alias rows**: zero code risk,
  visible in the UI, and handles one-off weird SKUs the same way.
- Idempotency is free: depletions key on real `order_item_id`s (the Rev 1 synthetic-key
  workaround is obsolete).

**Revenue recognition** (`runShipmentRevenueRecognition`, cron 16:30 UTC) — deliberately
allowlisted; wire Amazon in by:
- `SUPPORTED_CHANNELS` += `'amazon'` (`shipment-revenue-recognition.ts:74`)
- payout-prefix `REPLACE()` list += `'amazon_settlement_'`
- platform mappings preload loop += `'amazon'`
- Requires the settlement bridge rows from §7 step 6 (order ↔ settlement join), matching via
  `external_id='amazon:'+order_id` — same dual-key join the reconciliation view already does.
- Only relevant under the `deferred` model; no-ops under `invoice` (existing guard).

### ⚠️ Open decision: FBA stock vs ShipHero FIFO layers

20 of 21 orders are FBA — fulfilled from Amazon's warehouse. Stock gets there via ShipHero →
FBA replenishment shipments. Our FIFO cost layers live against received PO stock and deplete at
sale time; physical warehouse counts come from ShipHero hourly.

- COGS at Amazon sale time is correct **as long as the ShipHero→FBA transfer is not itself
  recorded as a depletion/write-off anywhere.** I found no code path that depletes FIFO on
  ShipHero outbound transfers, so this *should* already be safe — but how that transfer is
  operationally recorded (in ShipHero, in Xero, or not at all) needs confirming with you before
  Phase 5 goes live.
- FBA on-hand (`fba_myi_unsuppressed_inventory_data`) will be shown on the dashboard as a
  separate location; it deliberately does **not** feed the `inventory` table (whose `warehouse`
  quantity is authoritatively ShipHero's).
- `sell-through.ts` gets the channel guard (§3b) so FBA sales don't trip ShipHero reorder flags.
  FBA replenishment planning ("restock FBA") is a natural later feature from the same data —
  out of scope for this plan.

---

## 9. Dashboard

**New route:** `/finance/amazon` (tab pattern consistent with `/finance`), fed by
`GET /api/v1/finance/amazon/metrics?range=…` reading `amazon_sales_traffic_daily`,
`amazon_order_rows`, `amazon_settlement_rows`, `inventory_cost_depletions` — all local, no
live Windsor calls, so it's fast and works regardless of Windsor's window.

**Headline tiles (range-selectable, default 30d):**
Gross sales · Promotions (with % of gross, highlighted) · Net sales · Units · Orders ·
Referral + FBA fees · Refund rate · Contribution margin (net − fees − COGS from depletions)

**Charts:**
1. Daily stacked: gross vs promotions vs net — the launch-pricing story at a glance
2. Sessions / conversion (unit-session %) / Buy Box % — traffic quality (Amazon-only metrics)
3. Top SKUs by units and by contribution margin (with `-FBA` SKUs merged onto the parent)
4. Fee-load ratio over time (total fees ÷ gross) — channel health metric
5. FBA inventory: fulfillable / inbound / reserved / unsellable units by SKU

**Tables:** settlement history (id, period, gross/fees/net, Xero status + deep link) ·
COGS exceptions for `channel='amazon'` · sync health per report (from `amazon_sync_state`:
last success, watermark, rows, last error).

**Existing surfaces that light up via §3c edits:** P&L channel table (`pnl.ts` —
`CHANNEL_LABELS` already has amazon), dashboard channel-mix widget, `/orders` filter +
badges, reconciliation view, Slack daily/weekly digests.

**Slack digest note:** revenue in digests comes from `orders` — once Amazon orders import,
digests include them automatically (correct, no double-count: settlements feed journals, not
digests).

---

## 10. Month-end reporting

- **P&L:** Amazon appears as a channel row in `calculatePnl()` — revenue from `orders`, COGS
  from depletions, fees from `settlements` — with the existing `hasFullCostData` coverage flag.
- **Reconciliation:** existing view works once bridge rows exist (settlement gross vs linked
  orders' totals, >2% flagged). Amazon-specific wrinkle: settlements span two weeks and
  include orders from before the period → expected-vs-received uses the line-item join
  (already the fixed pattern, not date-range scans).
- **Month-end checklist additions** (surfaced on the dashboard as a "Month-end" card):
  unposted settlements · unmapped SKUs / open `cogs_exceptions` (channel amazon) ·
  FBA reimbursements this month (income; easy to miss) · returns without matching refunds ·
  promotions total vs plan · FBA storage fee trend.
- **Period close:** rides `xero_period_lock_date` + the reverse-and-repost correction pattern
  (`correctCogsForDate`) unchanged. Settlement restatements (rare) follow the Faire
  issue-credit pattern: drift detected on re-pull → clawback bill + Slack, never edit-in-place.

---

## 11. Cron jobs

Entries in `src/modules/integrations/lib/cron/registry.ts` (no new Railway services; note the
5-minute tick floor). The existing chain: payouts 15:00 → settlements 16:00 → faire 16:15 →
recognition 16:30 → COGS 16:45 UTC. Amazon slots in so its data is in place before the shared
jobs run:

| id | Schedule (UTC) | Handler | Notes |
|---|---|---|---|
| `amazon-orders-sync` | `10 14 * * *` | POST `/api/v1/orders/amazon-sync` | Orders + shipments reports, 7-day trailing upsert. After `shopify-orders-sync` (14:00), well before recognition. |
| `amazon-sales-traffic-sync` | `30 14 * * *` | `syncAmazonSalesTraffic()` | Dashboard analytics, 7-day trailing upsert (restatements) |
| `amazon-settlement-sync` | `20 16 * * *` | `syncAmazonSettlements()` | Raw archive + journals + bridge rows. After faire (16:15), before recognition (16:30). |
| `amazon-fba-inventory-sync` | `0 13 * * *` | `syncAmazonFbaInventory()` | Daily FBA stock snapshot |

All four: `fireAndForget: false`, guarded by `WINDSOR_API_KEY` presence, tolerant of
cold-report timeouts (log + retry next tick, no alert until 3 consecutive failures — then
Slack via the existing notification lib).

---

## 12. Work breakdown

**Phase 1 — Windsor client + raw archive + backfill** *(time-sensitive: settlement data is
aging out of the 90-day window as we wait)*
- `integrations/lib/windsor/client.ts` — generic client + tests (mock fetch; window chunking,
  backoff, prefix handling)
- `integrations/schema/amazon.ts` + `db.ts` + `__tests__/setup.ts` DDL — 5 tables
- `integrations/lib/amazon/ingest.ts` — landing writers with idempotency keys + tests
- One-off backfill: settlements (full 90d), orders + shipments (chunked to launch date
  ~1 Jun), sales & traffic (since launch — verify actual history depth; report may allow more
  than 90d)
- `amazon_sync_state` wiring

**Phase 2 — Order import**
- `orders` enum + `orders/lib/amazon-sync.ts` + route + tests (status mapping, upsert,
  shipped_at merge, SKU line handling, money sums)
- Guard edits (§3b) + structural defences (prefixes, NULL company, pre-stamped alert) + tests
  asserting each guard (e.g. stuck-order scan ignores amazon; activity-log matcher misses
  `AMZ-` rows)
- Cosmetic/UI (§3c)
- Cron: `amazon-orders-sync`

**Phase 3 — Dashboard**
- `amazon-sales-traffic-sync` + `amazon-fba-inventory-sync` crons
- `/api/v1/finance/amazon/metrics` + `/finance/amazon` page
- Channel-mix / digests / P&L visual checks with real rows

**Phase 4 — Xero journals** *(needs sign-off on §7 accounts first)*
- Xero: create/decide the bold accounts; add mapping suggestion rows + `_shared`
  deferred/receivables rows; tracking option "Amazon"
- `integrations/lib/amazon/settlement-classify.ts` — pure classifier + exhaustive test
- `integrations/lib/amazon/payout-sync.ts` — orchestrator (Faire clone) + mocked-Xero tests
- `amazonSettlementToComponents()` in `settlement-invoice-builder.ts` + pure tests
- Bridge rows (`ensureAmazonSettlement()`) + reconciliation verification
- Cron: `amazon-settlement-sync`; backfill-post June/July settlements after review in
  DRAFT status first (post one settlement end-to-end, eyeball in Xero, then enable POSTED)

**Phase 5 — COGS + revenue recognition** *(needs §8 FBA-transfer answer)*
- 34 `catalog_sku_aliases` rows for `-FBA` SKUs (script; verify against `catalog_skus`)
- `channelLabel()` + `SUPPORTED_CHANNELS` + prefix-list edits
- Dry-run `runDailyCogsPosting` on a known day; verify depletions + journal shape; enable
- `sell-through` guard live check

**Phase 6 — Month-end**
- Month-end card (checklist queries) + returns/reimbursements ingestion (2 more raw tables or
  fold into the card queries live from raw reports monthly)
- First full month-end run alongside the existing Shopify close

**Phase 7 — later channels** — TikTok Shop / Facebook / Amazon Ads: connect in Windsor
onboarding, then config + mapper per connector on the same client. Ad-spend lands as its own
small tables + dashboard cards (no orders, no journals initially).

Testing conventions throughout (established repo patterns): pure builders unit-tested without
mocks; orchestrators with `vi.mock`ed Xero client + Slack; DB tests on the in-memory sqlite
from `getTestDb()`; new tables added to test DDL.

---

## 13. Decisions needed before the relevant phase

1. **§7 account mapping** *(blocks Phase 4)* — approve the taxonomy table, and: create
   4020/5415/5420/5430 as new Xero accounts, or map onto existing codes?
2. **§8 FBA transfers** *(blocks Phase 5)* — how is the ShipHero → Amazon FBA replenishment
   currently recorded (ShipHero order? manual? nothing)? Determines whether sale-time FIFO
   depletion is already correct (I believe it is — no depleting code path found — but want
   operational confirmation).
3. **Revenue model** — confirm Amazon follows the current `payout_revenue_model` setting
   (recommended; keeps channels consistent).
4. **Backfill depth** — everything available now (recommended), or from a clean month boundary?
5. **Digest noise** — should Amazon appear in daily Slack digests immediately, or only after
   journals go live? (It will appear automatically once orders import; easy to exclude if
   too noisy at ~3 orders/day.)

Everything else in this plan I consider settled and ready to build.
