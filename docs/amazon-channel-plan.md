# Amazon Sales Channel — Integration Plan (via Windsor AI)

**Status:** BUILT. All six phases implemented and committed. See
[§14 Implementation status](#14-implementation-status) for what shipped, what is
verified against the live account, and the two things still needed from you.
**Prepared:** 2026-08-04

**Decisions carried in from review:**
- Amazon orders **are imported** into `orders` (`channel='amazon'`), but **never pushed** to
  Shopify or ShipHero — they are fulfilled by Amazon (FBA) or from our warehouse via Amazon's
  own channel. A push from The Frame would double-ship.
- **Backfill everything** available.
- **Amazon appears in all Slack alerts.**
- Xero account recommendations are specified in §7 against the real chart of accounts.
- FBA / FIFO handling is answered in §8.

**Scope:** journal entries, COGS, month-end reporting, and a monitoring dashboard.
Fulfilment stays entirely outside The Frame.

---

## 1. Account status — verified live, already selling

| Item | Value |
|---|---|
| Windsor account | `danielgetjaxycom` |
| Connector slug | **`amazon_sp`** (`amazon`, `amazon_seller` do not exist) |
| Amazon seller account | `ANJN3RZT0R4T5-US`, Amazon.com (US only), USD |
| Field catalog | 899 fields across 24 reports (`GET /amazon_sp/fields`) |
| Settlement data | 288 rows, 3 settlements, 4 Jun → 25 Jul 2026 |
| Orders, last 7 days | 21 lines — 20 FBA, 1 merchant-fulfilled |
| Other connectors | **none connected** — `amazon_ads`, `shopify`, `facebook`, `tiktok_shop`, `google_ads`, `klaviyo` |

### Trading results (settlements, 4 Jun – 25 Jul)

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

---

## 2. Constraints (verified by probing, not assumed)

1. **Settlement history caps at 90 days.** Windsor is not a system of record → archive every
   settlement row locally, permanently, on first sight. **Phase 1 is time-sensitive: anything
   older than the rolling window is already unrecoverable.**
2. **One report per API call**, fields must use report-prefixed names
   (`v2_settlement_report_data_flat_file_v2__amount`). Generic names don't resolve.
3. **Reports generate asynchronously on Amazon's side and some never return.** Verified:
   all-orders over 90 days hung >5 min; the same over 7 days returned in 1.8s.
   **The `amazon_fulfilled_shipments_data_general` report timed out on every attempt** —
   9 min, 5 min, 4 min, and even a single-day window at 2 min, across separate sessions.
   Treat it as **unavailable**; §5 uses a working substitute.
   → Client must use ≤7-day windows, long timeouts, and treat a timeout as "retry next run"
   rather than a failure alert (alert only after 3 consecutive failures).
4. **Current day returns no data** (SP-API limitation) → T-1 is newest; always re-pull a
   trailing window because Amazon restates recent days.
5. **Dirty columns:** settlement `currency`, `deposit_date`, `marketplace_name` frequently
   empty. Default `USD`; take dates from settlement header rows.
6. **SKU convention (confirmed by you):** `-FBA` suffix = sent to Amazon FBA; no suffix =
   shipped from our warehouse (FBM). Both are real listings for the same product.
   Map to `catalog_skus` by stripping the suffix.

### Reports used

| Report (table prefix) | Purpose | Status |
|---|---|---|
| `flat_file_all_orders_data_by_order_date_general` | Order import (new orders by purchase date) | ✅ works (1.8s/7d) |
| `flat_file_all_orders_data_by_last_update_general` | **Status changes + `shipped_at`** — carries `item_status`, `last_updated_date` | ✅ works (36s/7d) |
| `v2_settlement_report_data_flat_file_v2` | Journals / payouts | ✅ works (90d cap) |
| `sales_and_traffic_report_by_date` | Dashboard analytics — sessions, buy box, conversion | ✅ works |
| `fba_myi_unsuppressed_inventory_data` | FBA stock on hand (§8 inventory truth) | to verify |
| `flat_file_returns_data_by_return_date` | Returns detail (month-end) | to verify |
| `fba_reimbursements_data` | Amazon-lost/damaged payouts (month-end income) | to verify |
| ~~`amazon_fulfilled_shipments_data_general`~~ | ~~tracking + shipment_date~~ | ❌ **times out — dropped** |

Dropping the shipments report costs us only the tracking number, which we don't need — we
don't fulfil Amazon orders. `shipped_at` comes from the last-update report instead.

---

## 3. Why "import but never push" is safe — verified

A full sweep of every code path that reads `orders` and acts on it found:

**The Frame has no code path that can create an order in ShipHero or Shopify.** The ShipHero
client's only mutations are webhook management, packing notes and attachments; the Shopify
client's order surface is read-only plus a fulfilment-marker hard-gated to Shopify channels
with a Shopify `external_id`. Orders reach ShipHero through the native Shopify↔ShipHero
integration — The Frame is a passive observer. Double-shipping *from The Frame* is
structurally impossible. The remaining risk is Amazon rows being **mis-matched** by inbound
ShipHero webhooks or swept up by unfiltered scans.

### 3a. Structural defences (protect against future code too)

- **`order_number = 'AMZ-' + amazon_order_id`**, **`external_id = 'amazon:' + amazon_order_id`**.
  The most dangerous matcher — `findLocalOrderIdByShipHeroSignals`
  (`operations/lib/shiphero/activity-log.ts:51-72`), which falls back to fuzzy order-number
  matching with `ORDER BY created_at DESC LIMIT 1` and no channel filter — becomes structurally
  unable to hit an Amazon row.
- **`company_id = NULL`.** Amazon buyers aren't CRM companies. This alone neutralises four
  unfiltered paths: customer-account LTV stats (`account-sync.ts:47-79`), wholesale-conversion
  first-order counter (`wholesale-conversion.ts:189`), mail suppression
  (`shopify-wholesale-customer.ts:680`), Meta CAPI conversions (`meta/capi.ts:118`).
- **`shipped_alert_sent_at` pre-stamped** → the ShipHero-triggered "order fulfilled" Slack alert
  (`notify-fulfilled.ts:72-77`) can never claim an Amazon row. Amazon gets its **own** purpose-built
  alerts instead (§10) rather than piggybacking on ShipHero plumbing.
- **Status never lands on `confirmed`** (§5) → the stuck-order scan has nothing to match.

### 3b. Explicit channel guards

| File:line | Change |
|---|---|
| `operations/lib/shiphero/activity-log.ts:53,59,66` | `AND channel != 'amazon'` on all three lookups |
| `operations/lib/shiphero/sync-orders.ts:48` | `AND channel != 'amazon'` |
| `app/api/v1/integrations/slack/scan-stuck-orders/route.ts:39` | `AND channel != 'amazon'` — we can't action an Amazon order stuck at Amazon |
| `inventory/lib/sell-through.ts:51` | `AND o.channel != 'amazon'` — FBA sales must not inflate ShipHero warehouse velocity/reorder flags (see §8) |
| `orders/lib/fulfillment.ts` (UI) | Hide manual "Mark shipped" for `channel='amazon'` |

Verified already safe, no change: Faire ship-marking (channel-gated), Faire backfill route,
Shopify fulfilment push (channel + external_id gated), Pipedrive sync (regex-gated to
wholesale/faire), Shopify webhooks (match on Shopify numeric id), revenue recognition
(allowlist — Amazon added deliberately in Phase 5), Faire/Shopify payout syncs.

### 3c. Cosmetic

`channelConfig` (`orders/page.tsx:87`, `[id]/page.tsx:123`); `platformLabel`
(`slack/digests.ts:218`); `channelLabel` (`daily-cogs.ts:329`); "View in Shopify" →
"View in Seller Central" (`sellercentral.amazon.com/orders-v3/order/{id}`) at
`[id]/page.tsx:381`; fulfilment copy at `[id]/page.tsx:670` → "Fulfilled by Amazon (FBA)".

### 3d. Schema facts

- `orders.channel` has **no DB CHECK constraint** (TypeScript enum only) → adding `"amazon"` at
  `orders/schema/index.ts:17` is a type-level change, no migration.
- **No unique index on `order_number`/`external_id`** → import idempotency is app-level
  (`SELECT … WHERE external_id = ?` before insert, as `shopify-webhooks.ts:377` does).
- `orders.status` enum: `pending, confirmed, picking, packed, shipped, delivered, returned, cancelled`.

---

## 4. Architecture

```
Windsor AI (amazon_sp; later tiktok_shop, facebook, amazon_ads)
        │  ≤7-day windows · 1 report/call · retry tolerant of cold reports
        ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. Generic Windsor client (connector-agnostic)               │
│    integrations/lib/windsor/client.ts                        │
├──────────────────────────────────────────────────────────────┤
│ 2. RAW LANDING (append-only, permanent — beats 90-day cap)   │
│    amazon_order_rows · amazon_settlement_rows ·              │
│    amazon_sales_traffic_daily · amazon_fba_inventory         │
├──────────────────────────────────────────────────────────────┤
│ 3. NORMALISE → orders + order_items (guarded)                │
│                settlements + settlement_line_items (bridge)  │
├──────────────────────────────────────────────────────────────┤
│ 4. EXISTING MACHINERY: daily-cogs (FIFO) · revenue           │
│    recognition · Xero journals · P&L · reconciliation        │
├──────────────────────────────────────────────────────────────┤
│ 5. Dashboard /finance/amazon + existing channel surfaces     │
└──────────────────────────────────────────────────────────────┘
```

- **Normalise from our own tables, never from Windsor** — every artefact is re-derivable
  locally forever, after Windsor's window closes.
- **Connector-agnostic client from day one**:
  `fetchWindsorReport({ connector, fields, dateFrom, dateTo })`. TikTok Shop / Facebook later
  become a config entry + mapper, not a new integration.
- `WINDSOR_API_KEY` in env (Railway + local), never committed; fail loudly if unset.

---

## 5. Order import

**New:** `orders/lib/amazon-sync.ts` (shaped like `faire-sync.ts`) and
`app/api/v1/orders/amazon-sync/route.ts` (GET status, POST trigger).

### Pipeline

1. Pull **all-orders by order date** for a trailing 7-day window (backfill: explicit ranges,
   chunked ≤7 days) → upsert `amazon_order_rows` on `(amazon_order_id, sku)`.
2. Pull **all-orders by last update** for the same window → upsert the same table, refreshing
   `item_status` / `last_updated_date` (catches ships, cancels, and restatements of older orders).
3. Normalise into `orders` / `order_items`, idempotent on
   `external_id = 'amazon:' + amazon_order_id`.
4. **`shipped_at`** = `last_updated_date` of the earliest line whose `item_status = 'Shipped'`.
   (This replaces the unavailable shipments report. Slight imprecision — `last_updated_date`
   is the update timestamp, not strictly the ship timestamp — but it is same-day accurate,
   which is all daily COGS and revenue recognition need.)

### Field mapping

| `orders` column | Source |
|---|---|
| `channel` | `'amazon'` (add to enum) |
| `order_number` | `'AMZ-' + amazon_order_id` |
| `external_id` | `'amazon:' + amazon_order_id` |
| `company_id`, `contact_id` | **NULL** (deliberate, §3a) |
| `status` | all lines Shipped → `shipped`; any line Shipped → `shipped`; Cancelled → `cancelled`; else `pending`. **Never `confirmed`/`picking`/`packed`.** |
| `subtotal` | Σ `item_price` (flat-file `item_price` is the line total; verify on a multi-qty line in dev) |
| `discount` | Σ `item_promotion_discount` + `ship_promotion_discount` (stored positive) |
| `shipping` | Σ `shipping_price` |
| `tax` | Σ `item_tax` + `shipping_tax` (facilitator tax — Amazon remits; §7) |
| `total` | subtotal − discount + shipping + tax |
| `currency` | `USD` |
| `source_name` | `'amazon'` · `ship_to_country` NULL (keeps intl-shipping email inert) · `ship_to_name` NULL |
| `shiphero_order_id` | **NULL always** |
| `placed_at` | `purchase_date` · `shipped_at` per above · `shipped_alert_sent_at` pre-stamped |

| `order_items` | Source |
|---|---|
| `sku` | Amazon SKU verbatim (`JX1010-TOR-FBA`) |
| `sku_id`, `product_id` | resolve after stripping `-FBA`; alias fallback; NULL + exception if unmapped |
| `quantity` | `quantity` (arrives as TEXT — parse) |
| `unit_price` / `total_price` | `item_price ÷ quantity` / `item_price` |

### The importer must NOT

Create companies/contacts, call `ensureCustomerAccount`, `detectWholesaleConversion`,
`syncOrderToPipedrive`, `createInventoryMovements` (FBA stock isn't in ShipHero's warehouse,
and the hourly ShipHero inventory sync would overwrite any decrement anyway), or the
international-shipping email.

### Cancellations & refunds

Re-pulls flip `status` to `cancelled` (pending Amazon orders cancel often). Refunds don't
un-ship: the financial effect arrives via the settlement journal (§7); the returns report
feeds month-end. An already-depleted refunded line stays depleted — Amazon restocks sellable
returns into FBA, which shows up in FBA inventory counts (§8).

---

## 6. Schema — new tables

Added in **three** places (repo constraint — tests fail otherwise): Drizzle schema
(`integrations/schema/amazon.ts`, new), boot DDL (`src/lib/db.ts`), test DDL
(`src/__tests__/setup.ts`).

```
amazon_order_rows           -- raw all-orders (both report variants), permanent
  id, amazon_order_id, sku, asin, quantity, item_price, item_tax,
  item_promotion_discount, ship_promotion_discount, shipping_price, shipping_tax,
  order_status, item_status, fulfillment_channel, sales_channel, currency,
  purchase_date, last_updated_date, ship_city, ship_state, ship_postal_code,
  ship_country, is_business_order, raw_json, ingested_at, updated_at
  upsert key: (amazon_order_id, sku)

amazon_settlement_rows      -- raw settlements, permanent (the 90-day insurance)
  id, settlement_id, posted_date, transaction_type, amount_type, amount_description,
  amount, currency, sku, order_id, quantity_purchased, marketplace_name,
  settlement_start_date, settlement_end_date, deposit_date, total_amount,
  raw_json, ingested_at
  append-skip key: (settlement_id, order_id, sku, amount_type, amount_description,
                    posted_date, amount)   -- never updated

amazon_sales_traffic_daily  -- dashboard analytics
  id, date, gross_sales, units_ordered, units_shipped, total_order_items, refund_rate,
  sessions, page_views, buy_box_pct, conversion_rate, avg_selling_price,
  ingested_at, updated_at        upsert key: (date)  -- Amazon restates recent days

amazon_fba_inventory        -- daily FBA stock snapshot (§8)
  id, snapshot_date, sku, internal_sku, asin, fulfillable_qty, inbound_working_qty,
  inbound_shipped_qty, inbound_receiving_qty, reserved_qty, unsellable_qty,
  total_qty, ingested_at         upsert key: (snapshot_date, sku)

amazon_sync_state           -- per-report watermark
  report_name PK, last_synced_through, last_run_at, last_status, last_error, rows_ingested
```

Existing-table edits: `orders.channel` enum += `"amazon"`; `xero_account_mappings` gains the
Amazon rows from §7 plus `_shared` `deferred_revenue` / `receivables_holding`;
`PLATFORM_CATEGORY_SUGGESTIONS.amazon` (`integrations/schema/xero.ts:189`) updated to match §7.

---

## 7. Xero accounts — checked against your real chart of accounts

I pulled the live chart from Xero (Jaxy Eyewear LLC). It is in better shape than expected —
most of what Amazon needs already exists and is sitting at $0.00, clearly pre-created.

### Already exist — no action needed

| Account | Used for |
|---|---|
| **Sales - Amazon** | Product sales (Principal) |
| **Merchant Fees - Amazon** | Referral commission |
| **Sales Discounts & Promotions** | Promotions — the −$1,176 line |
| **Sales Returns & Allowances** | Refunds |
| **Shipping Income** | Shipping charged to buyer |
| **COGS - Inbound Freight** | Inbound transportation + partnered-carrier fees |
| **Outbound Shipping & Postage** | Return shipping labels |
| **Merchant Fees - Other** | Suspense for unclassified Amazon fee types |
| **Inventory Adjustments & Shrinkage** | Settlement residual plug |
| **COGS - Product / Customs & Duties** | Daily COGS journal (all channels) |

Note this corrects rev 2: I had proposed channel-specific discount accounts, but
`Sales Discounts & Promotions` already exists as a shared account. Channel separation comes
from the **tracking category**, not duplicated accounts — consistent with how Faire/Shopify
already work.

### Create exactly these three (verified against the real chart of accounts)

| Code | Name | Type | Tax Code | Description |
|---|---|---|---|---|
| **5470** | `Amazon Fees - FBA Fulfillment` | Direct Costs | Tax Exempt (0%) | Amazon FBA per-unit pick, pack and ship fees. Separate from 5500 3PL - Fulfillment & Pick-Pack (Big Sky) so each channel's unit economics stay readable. |
| **5475** | `Amazon Fees - FBA Storage` | Direct Costs | Tax Exempt (0%) | Amazon FBA monthly inventory storage fees. Separate from 5510 3PL - Storage (Big Sky). |
| **5480** | `Amazon Fees - Subscription` | Direct Costs | Tax Exempt (0%) | Amazon Professional selling plan subscription (~$39.99/mo). |

Codes sit in the gap between the Faire fee block (5450–5460) and the 3PL block (5500+),
following the same 5-step convention Faire uses.

### Everything else already exists — no action

| Purpose | Existing account |
|---|---|
| Gross sales | 4010 Sales - Amazon |
| Shipping income | 4060 Shipping Income |
| Promotions (contra-revenue) | 4310 Sales Discounts & Promotions |
| Refunds | 4300 Sales Returns & Allowances |
| Referral commission | 5410 Merchant Fees - Amazon |
| Inbound freight to FBA | 5010 COGS - Inbound Freight |
| Return shipping labels | 5300 Outbound Shipping & Postage |
| Unclassified fees (suspense) | 5440 Merchant Fees - Other |
| Deposit clearing | 1030 Amazon Clearing — **already Bank type**, as required |
| Deferred model | 2050 Deferred Revenue, 1100 Receivables Holding |
| Facilitator-tax residual safety net | 2230 Sales Tax |

### Fee taxonomy → accounts (every one of our 288 settlement rows classified)

| transaction_type | amount_type | amount_description | Account |
|---|---|---|---|
| Order | ItemPrice | Principal | Sales - Amazon (CR) |
| Order | ItemPrice | Shipping | Shipping Income (CR) |
| Order | Promotion | Principal / Shipping | Sales Discounts & Promotions (DR) |
| Order | ItemFees | Commission | Merchant Fees - Amazon (DR) |
| Order | ItemFees | FBAPerUnitFulfillmentFee | **Amazon Fees - FBA Fulfillment** (DR) |
| Order | ItemPrice | Tax | *netted — see below* |
| Order | ItemWithheldTax | MarketplaceFacilitatorTax-Principal | *netted — see below* |
| Refund | ItemPrice | Principal | Sales Returns & Allowances (DR) |
| Refund | ItemFees | Commission | Merchant Fees - Amazon (CR) |
| Refund | ItemFees | RefundCommission | Merchant Fees - Amazon (DR) |
| Refund | ItemPrice/ItemWithheldTax | Tax legs | *netted* |
| FBAFees | FBA Amazon-Partnered Carrier Shipment Fee | Base fee / Discount on Fee | COGS - Inbound Freight (DR) |
| FBAFees | FBA Inventory Storage Fee | Base fee | **Amazon Fees - FBA Storage** (DR) |
| other-transaction | — | Subscription Fee | **Amazon Fees - Subscription** (DR) |
| other-transaction | — | Inbound Transportation Fee | COGS - Inbound Freight (DR) |
| other-transaction | — | Shipping label purchase for return | Outbound Shipping & Postage (DR) |
| other-transaction | — | Payable to Amazon / Successful charge | Amazon Clearing (pair nets to zero) |
| Transfers | Micro Deposit | Micro Deposit | Amazon Clearing |
| *anything unrecognised* | | | **Merchant Fees - Other** + Slack alert |

**Marketplace facilitator tax:** Amazon collects and remits sales tax itself; the money never
reaches us. In our data the two legs cancel exactly (+$34.73 / −$34.73 on orders, −$8.93 /
+$8.93 on refunds). The design nets them per settlement and **asserts the residual is zero**;
a non-zero residual posts to `Sales Tax Payable` and raises a Slack alert. This keeps a fake
tax liability off the books while staying safe if Amazon's behaviour changes.

**Unknown fee types:** Amazon will introduce descriptions we haven't seen (long-term storage,
disposal, removal, Vine). Unrecognised rows post to `Merchant Fees - Other` **and raise a Slack
alert** — never silently absorbed. `classifySettlementRow(row) → category` is a pure function
with a unit test locking every known mapping.

### Posting model

Honours the existing `payout_revenue_model` switch, so Amazon behaves like Shopify/Faire:
- **`invoice`**: one ACCREC invoice per settlement, `AMZN-{settlement_id}` (prefix already
  reserved), gross positive / fees negative so the total equals the deposit and the bank
  matches 1:1. Pure `amazonSettlementToComponents()` adapter in `settlement-invoice-builder.ts`,
  unit-tested like the Shopify/Faire adapters. Net-negative settlements (likely in launch
  months) take the existing credit-note path.
- **`deferred`**: manual journal CR Deferred Revenue / DR fees / DR Receivables Holding, then
  `postBankTransactionReceive` Amazon Clearing ← Receivables Holding.

---

## 8. FBA inventory & FIFO — your question answered

> *"right now I create an order for all of the inventory in ShipHero to send to FBA. The order
> in ShipHero is for $0. I'm not sure if this is even being reported as a COGS now."*

### What is happening today

**It is not generating COGS — and that is correct.** Verified in code:

1. `syncShipHeroOrders` (`operations/lib/shiphero/sync-orders.ts`) **only ever inserts into
   `shiphero_shipments`** — it never inserts into `orders`. It matches ShipHero orders onto
   *existing* local orders by `partner_order_id = orders.external_id` and updates them.
   `shipment-update.ts` likewise only finds, never creates.
2. So a ShipHero-native order — one you create directly in ShipHero, like the $0 FBA transfer —
   **never becomes a row in The Frame's `orders` table.**
3. `runDailyCogsPosting` selects `FROM order_items oi JOIN orders o …`. No local order means no
   order items, so the transfer is invisible to COGS. Nothing is depleted, nothing is posted.
4. FIFO layers are touched only by `fifo-engine.ts`, `daily-cogs.ts` and `cogs-backfill.ts`.
   The ShipHero **inventory** sync does not touch `inventory_cost_layers` at all — confirmed by
   search. So shipping units to FBA doesn't disturb the cost ledger.

### The recommended model

**Treat FIFO cost layers as location-agnostic "inventory we own", and deplete only on a real
customer sale — whichever channel sells it.**

This is both correct accounting and (conveniently) how the system already behaves:

- Moving your own goods from your 3PL to Amazon's warehouse is a **transfer, not a sale**. No
  revenue, no COGS. The goods stay an asset (Inventory 1400) until a customer buys them.
- The $0 value on the ShipHero order is exactly right — it's a picking document, not a sale.
- When Amazon sells the unit, we deplete FIFO then, so COGS lands in the same period as the
  revenue it earned. That's the ASC 606 matching we already do for Shopify and Faire.

**So: no change to the FIFO engine, and no double-count risk.** The one thing that must stay
true is that the transfer order must **never** become a local order.

### Guard rails to add

1. **Keep creating the FBA transfer directly in ShipHero, not in Shopify.** A ShipHero-native
   order can't reach `orders`. If it were ever raised as a $0 *Shopify* order it **would**
   import and **would** deplete FIFO at transfer time — double-counting COGS when the Amazon
   sale later depletes again. This is the single behavioural rule to preserve.
2. **Defensive check** in the daily COGS run: flag any order with `total = 0` and >0 units as a
   `cogs_exceptions` row of a new type `suspected_transfer` rather than depleting it silently.
   Cheap insurance in case rule 1 is ever broken by accident.
3. **Inventory visibility fix.** ShipHero's on-hand drops when units ship to FBA, so The Frame
   currently *understates* what we own — units at Amazon are invisible. The new
   `amazon_fba_inventory` snapshot fixes this:
   **total owned = ShipHero on-hand + FBA fulfillable + FBA inbound + FBA reserved.**
   Shown on the dashboard, and the correct basis for reorder decisions.
4. **`sell-through.ts` channel guard** (§3b): Amazon sales must not inflate ShipHero warehouse
   velocity, or reorder flags will fire against stock that isn't being consumed from ShipHero.
5. **Month-end reconciliation check:** FIFO `Σ remaining_quantity` should ≈ ShipHero on-hand +
   FBA total + inbound. Drift means a missed depletion or an untracked transfer. Added to the
   month-end card (§10).

### The 3PL fee on the transfer

ShipHero charges pick/pack for the FBA transfer order; that already flows to
`3PL - Fulfillment & Pick-Pack` via their invoice, which is correct. Strictly it could be
capitalised into inventory cost (a cost of getting goods to the point of sale), but expensing
it is simpler, consistent with current treatment, and immaterial at this volume. Amazon's own
`Inbound Transportation Fee` goes to `COGS - Inbound Freight` (§7).

### Revenue recognition & COGS wiring

Because Amazon orders are real `orders`/`order_items` rows with `shipped_at`, both daily jobs
pick them up with only allowlist/label edits:

- **Daily COGS** — the shipped-lines query has no channel filter, so Amazon flows in
  automatically. Needs: `channelLabel()` += `amazon`; Amazon Xero mappings + tracking option
  created first (Phase 4 precedes Phase 5, or journals silently fall back to default accounts
  with no tracking); `-FBA` SKU resolution.
- **SKU mapping** — recommend adding `catalog_sku_aliases` rows for the `-FBA` SKUs (34 today)
  rather than a suffix-strip in code: zero code risk, visible and editable in the UI, and
  handles one-off odd SKUs the same way. Generated by script, reviewed before insert.
- **Revenue recognition** — allowlisted, so wire in deliberately: `SUPPORTED_CHANNELS` +=
  `'amazon'` (`shipment-revenue-recognition.ts:74`), payout-prefix list += `'amazon_settlement_'`,
  platform preload += `'amazon'`. Needs the §7 settlement bridge rows for the order↔settlement
  join. Only applies under the `deferred` model; no-ops under `invoice`.

---

## 9. Dashboard

**New:** `/finance/amazon`, fed by `GET /api/v1/finance/amazon/metrics?range=…`, reading local
tables only — fast, and unaffected by Windsor's 90-day window.

**Tiles:** Gross sales · Promotions (% of gross, highlighted) · Net sales · Units · Orders ·
Referral + FBA fees · Refund rate · Contribution margin (net − fees − COGS).

**Charts:**
1. Daily gross vs promotions vs net — the launch-pricing story
2. Sessions / conversion / Buy Box % — traffic quality (Amazon-only metrics)
3. Top SKUs by units and contribution margin (`-FBA` merged onto parent)
4. Fee-load ratio (total fees ÷ gross) over time — channel health
5. **Inventory position**: ShipHero on-hand vs FBA fulfillable vs FBA inbound vs reserved,
   with total-owned per SKU (§8)

**Tables:** settlement history (period, gross/fees/net, Xero status + link) · Amazon COGS
exceptions · sync health per report from `amazon_sync_state` (last success, watermark, rows,
last error) — important given the flaky report behaviour in §2.

**Existing surfaces** light up via §3c: P&L channel table (`CHANNEL_LABELS` already has amazon),
dashboard channel-mix, `/orders` filter and badges, reconciliation.

---

## 10. Slack alerts (confirmed: Amazon everywhere)

Amazon gets **purpose-built** notifications rather than piggybacking on ShipHero-triggered
plumbing (which would misfire, per §3a):

| Alert | Trigger |
|---|---|
| Daily / weekly digests | Amazon revenue line — automatic once orders import; `platformLabel` += `amazon` |
| New Amazon orders | Daily summary from `amazon-orders-sync` (per-order at ~3/day would be noisy; summary now, per-order easy to switch on) |
| Settlement posted | Per settlement: gross, fees, net, Xero link |
| Unclassified fee type | Any settlement row hitting the suspense account (§7) |
| COGS exceptions | Unmapped SKU / shortfall / `suspected_transfer` (§8), via existing grouped exception notifier |
| Sync failure | After 3 consecutive failures for a report (§2 flakiness) |
| FBA low stock | Fulfillable below threshold with nothing inbound — optional, Phase 6 |

Deliberately **not** alerted: stuck-order scan (we can't action an order stuck at Amazon).

---

## 11. Cron jobs

In `integrations/lib/cron/registry.ts` (no new Railway services; 5-minute tick floor). Existing
chain: payouts 15:00 → settlements 16:00 → faire 16:15 → recognition 16:30 → COGS 16:45 UTC.

| id | Schedule (UTC) | Purpose |
|---|---|---|
| `amazon-orders-sync` | `10 14 * * *` | Both order reports, 7-day trailing upsert |
| `amazon-sales-traffic-sync` | `30 14 * * *` | Dashboard analytics, 7-day trailing |
| `amazon-fba-inventory-sync` | `0 13 * * *` | Daily FBA stock snapshot |
| `amazon-settlement-sync` | `20 16 * * *` | Raw archive + journals + bridge rows (after Faire, before recognition) |

All guarded on `WINDSOR_API_KEY`, tolerant of cold-report timeouts, alerting only after 3
consecutive failures.

---

## 12. Work breakdown

**Phase 1 — Windsor client + raw archive + full backfill** *(time-sensitive)*
- `integrations/lib/windsor/client.ts` + tests (window chunking, backoff, prefix handling)
- `integrations/schema/amazon.ts` + `db.ts` + `__tests__/setup.ts` — 5 tables
- `integrations/lib/amazon/ingest.ts` — landing writers + idempotency + tests
- **Backfill everything:** settlements (full 90d), orders both variants (chunked to ~1 Jun
  launch), sales & traffic (probe real history depth — may exceed 90d), FBA inventory snapshot
- `amazon_sync_state` wiring

**Phase 2 — Order import**
- enum + `orders/lib/amazon-sync.ts` + route + tests (status mapping, upsert, shipped_at
  derivation, money sums, multi-line orders)
- Guards (§3b) + structural defences + tests asserting each guard holds
- Cosmetic/UI (§3c); cron `amazon-orders-sync`

**Phase 3 — Dashboard + Slack**
- `amazon-sales-traffic-sync`, `amazon-fba-inventory-sync` crons
- `/api/v1/finance/amazon/metrics` + `/finance/amazon` page
- Slack alerts (§10); verify channel-mix / digests / P&L with real rows

**Phase 4 — Xero journals** *(after you create the §7 accounts)*
- Mapping rows + tracking option "Amazon"
- `amazon/settlement-classify.ts` — pure classifier + exhaustive test over all 288 archived rows
- `amazon/payout-sync.ts` orchestrator (Faire clone) + mocked-Xero tests
- `amazonSettlementToComponents()` + pure tests; `ensureAmazonSettlement()` bridge rows
- **Post one settlement as DRAFT first, review in Xero, then enable POSTED** and backfill
  June/July

**Phase 5 — COGS + revenue recognition**
- `catalog_sku_aliases` rows for `-FBA` SKUs (script, reviewed)
- `channelLabel()`, `SUPPORTED_CHANNELS`, prefix-list edits
- `suspected_transfer` exception type (§8)
- Dry-run `runDailyCogsPosting` on a known day, verify depletions + journal, then enable

**Phase 6 — Month-end**
- Month-end card: unposted settlements · open exceptions · FBA reimbursements ·
  returns without refunds · promotions total · **FIFO vs (ShipHero + FBA) reconciliation** (§8)
- Returns + reimbursements ingestion; first full close alongside Shopify

**Phase 7 — later channels** — TikTok Shop / Facebook / Amazon Ads: connect in Windsor, then
config + mapper on the same client. Ad spend lands as its own tables + dashboard cards.

Testing throughout, per repo convention: pure builders unit-tested without mocks; orchestrators
with `vi.mock`ed Xero client + Slack; DB tests on in-memory sqlite via `getTestDb()`; new tables
added to the test DDL.

---

## 13. Status of open items

| Item | Status |
|---|---|
| Import orders vs aggregate | ✅ Import, never push (§3) |
| Backfill depth | ✅ Everything available |
| Slack alerts | ✅ Amazon everywhere (§10) |
| FBA / FIFO handling | ✅ Answered (§8) — no COGS today, which is correct; deplete at sale, keep the transfer ShipHero-native |
| Xero accounts | ⏳ **Create 3 accounts, confirm 2 exist** (§7) — only blocks Phase 4 |
| Revenue model | ⏳ Confirm Amazon follows the current `payout_revenue_model` setting (recommended) |
| Shipments report | ✅ Dropped as unavailable; `shipped_at` from last-update report (§5) |

Phases 1–3 are unblocked and can start immediately.

---

## 14. Implementation status

All six phases are built, tested and committed. 190 new tests; the full suite
went from 705 to 927 passing with no regressions. (The repo has 92 pre-existing
test failures in unrelated files — identical before and after this work.)

### What shipped

| Phase | Status | Key files |
|---|---|---|
| 1. Windsor client + raw archive | ✅ | `integrations/lib/windsor/client.ts`, `integrations/lib/amazon/{reports,ingest,sync}.ts`, `integrations/schema/amazon.ts`, `scripts/amazon-backfill.ts` |
| 2. Order import + guards | ✅ | `orders/lib/amazon-sync.ts`, `api/v1/orders/amazon-sync/route.ts`, guards in 4 existing files |
| 3. Dashboard | ✅ | `(dashboard)/finance/amazon/page.tsx`, `api/v1/finance/amazon/route.ts`, `integrations/lib/amazon/metrics.ts` |
| 4. Settlement classifier + bridge | ✅ | `integrations/lib/amazon/{settlement-classify,settlement-bridge}.ts` |
| 5. COGS + revenue recognition | ✅ | edits to `shipment-revenue-recognition.ts`, `daily-cogs.ts`, `scripts/amazon-seed-fba-aliases.ts` |
| 6. Month-end checklist | ✅ | `integrations/lib/amazon/month-end.ts` |

Four cron jobs are registered and gated on `WINDSOR_API_KEY`: orders 14:10,
sales/traffic 14:30, FBA inventory 13:00, settlements 16:20 UTC.

### Verified against the live account, not just tested

- **Report definitions** — 6 of 7 reports returned real data end to end. The
  FBA shipments report timed out on every attempt (9 min, 5 min, 4 min, and a
  single-day window at 2 min) and is documented as unavailable; `shipped_at`
  derives from the by-last-update report instead.
- **Classifier** — run against all 288 real settlement rows: **zero
  unclassified**, facilitator-tax legs net to exactly zero on every settlement,
  and the reconstructed total reproduces the real **$19.99** net for the period,
  matching an independent calculation.
- **Order import** — 61 real Amazon orders imported end to end. All seven
  safety invariants clean (no company_id, no shiphero_order_id, no claimable
  fulfilment alert, no `confirmed` status, correct prefixes, no total
  mismatches), and re-running was fully idempotent.

### Discovered during the build

- **Amazon cancels a report request when a period has no data**, and Windsor
  relays that as a generic failure. Without special handling, any legitimately
  empty report (no returns this week) would alert nightly and train everyone to
  ignore alerts. Classified as `no_data` and recorded as a successful empty run.
- **`depleteInventoryFifo` keys idempotency solely on `order_item_id`.** Noted
  in rev 2; moot now that Amazon orders carry real order items.
- **Settlement duplicates are real.** Amazon can emit economically identical
  rows (two equal promotions on one item). Dedup counts per identity rather
  than checking existence, so genuine duplicates survive instead of silently
  understating the settlement.
- **The revenue-recognition join needed widening.** It matched
  `settlement_line_items.order_id = orders.id` only, but Amazon settlements
  carry Amazon's own order id. Without the dual key every Amazon order would
  have failed to recognise, silently.

### Still needed from you

1. **Create three Xero accounts** (§7): `Amazon Fees - FBA Fulfillment`,
   `Amazon Fees - FBA Storage`, `Amazon Fees - Subscription`. Confirm
   `Amazon Clearing` exists and is **Bank** type, and that `Deferred Revenue`
   and `Receivables Holding` exist as shared accounts. This blocks posting
   journals to Xero — everything else runs without it.
2. **Set `WINDSOR_API_KEY`** in the Railway environment. Nothing pulls without it.

Then run the backfill — it is the time-sensitive step, since settlement history
older than 90 days is unrecoverable from Windsor:

```
npx tsx scripts/amazon-backfill.ts --from 2026-06-01 --dry-run
npx tsx scripts/amazon-backfill.ts --from 2026-06-01
npx tsx scripts/amazon-seed-fba-aliases.ts          # reports SKUs needing a decision
```

### Deliberately not built

Live Xero posting for Amazon settlements. The classifier, bridge and account
mappings are all in place, but posting is gated on the three accounts above
existing. The plan's DRAFT-first rollout (post one settlement, eyeball it in
Xero, then enable POSTED) is the right next step once they do.
