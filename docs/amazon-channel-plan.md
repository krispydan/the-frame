# Amazon Sales Channel — Integration Plan (via Windsor AI)

**Status:** Draft for review. No code written yet.
**Prepared:** 2026-08-04
**Scope:** Connect The Frame to the Amazon Seller account through Windsor AI, replicate the
finance/reporting capabilities we have for Shopify, and give us a dashboard to monitor Amazon sales.

**Explicitly out of scope** (per instruction): importing Amazon orders for operational use, and
anything touching fulfilment. ShipHero remains the fulfilment system and The Frame will not create,
route, or track Amazon shipments.

---

## 1. What we found — the account is already live

This is not a greenfield connection. Windsor is already connected to Amazon and returning real data.

| Item | Value |
|---|---|
| Windsor account | `danielgetjaxycom` |
| Connector slug | **`amazon_sp`** (not `amazon_seller` / `amazon` — those don't exist) |
| Amazon seller account | `ANJN3RZT0R4T5-US` |
| Marketplace | Amazon.com (US only) |
| Field catalog | 899 fields across **24 reports** |
| Settlement data on hand | 288 rows, 3 settlements, **4 Jun 2026 → 25 Jul 2026** |
| Orders (last 7 days) | 21 order lines, 20 FBA + 1 Merchant, all USD |

**Yes — we have started selling.** Trading began early June 2026.

### The numbers so far (settlements, 4 Jun – 25 Jul)

| Line | Amount |
|---|---|
| Product sales (Principal) | **$1,652.00** |
| Promotions | **−$1,176.00** |
| FBA fulfilment fees | −$205.32 |
| Referral commission | −$36.40 |
| Refunds (principal) | −$112.00 |
| Subscription fee | −$79.98 |
| Inbound transportation | −$21.30 |
| **Net settled** | **$19.99** |

Promotions are running at **71% of gross**. That is launch pricing (coupons / Vine / launch
discounts) and it is why the account nets out to roughly break-even. This is the single most
important thing the dashboard needs to make visible — gross sales alone would tell us nothing
useful right now.

### Other Windsor connectors — none are connected yet

`amazon_ads`, `shopify`, `facebook`, `tiktok_shop`, `google_ads`, `klaviyo`, `amazon_vendor` all
returned *"No account for user danielgetjaxycom"*. Only `amazon_sp` is live. Relevant for the
later TikTok Shop / Facebook ad-spend phase — those are Windsor onboarding steps, not code.

---

## 2. Hard constraints discovered by probing the API

These drive the architecture. Each was verified against the live endpoint, not assumed.

1. **Settlement reports are capped at 90 days.** Requesting anything older returns
   `"Please choose a date that is within the last 90 days from today."`
   → **This is the number-one design driver. Windsor is not a system of record.** If we do not
   persist settlement rows ourselves, our accounting history silently evaporates on a rolling
   90-day window. Every settlement row must be stored permanently on first sight.

2. **One report per API call.** Fields cannot be mixed across reports; each call resolves to a
   single Amazon report. Generic field names (`date`, `amount`, `sku`) do not resolve at all —
   every field must use its report-prefixed name, e.g.
   `v2_settlement_report_data_flat_file_v2__amount`.

3. **The all-orders report times out on wide windows.** A 90-day request hung past 5 minutes;
   a 7-day request returned in 1.8s. Amazon generates these reports asynchronously.
   → Ingestion must use **narrow windows (≤7 days), chunked, with retry and generous timeouts**.
   A naive "sync last 90 days" call will fail in production.

4. **The current day returns no data** (documented Amazon SP-API limitation). All jobs must treat
   **T-1 as the newest available day**, and ideally re-pull a trailing window since Amazon
   restates recent data.

5. **Data quality gaps in settlement rows:** `currency`, `deposit_date` and `marketplace_name`
   come back empty on many rows. We must default currency to USD (safe today — US-only account)
   and derive deposit dates from the settlement header rather than trusting the column.

6. **SKU format:** Amazon SKUs are our internal SKU plus an optional `-FBA` suffix —
   `JX1010-TOR-FBA`, `JX4006-BLK`. Of 34 distinct settlement SKUs, most are `-FBA`; a handful are
   merchant-fulfilled. **COGS mapping must strip the `-FBA` suffix** to reach `catalog_skus`.
   Both variants of the same product exist simultaneously (`JX1001-TOR` and `JX1001-TOR-FBA`).

---

## 3. The good news — the codebase is already ~60% ready

The Frame was built channel-generic, and Faire proved the pattern for a non-Shopify channel.
Already in place for Amazon, with no work needed:

- `settlements.channel` enum **already includes `"amazon"`**
- `PLATFORM_CATEGORY_SUGGESTIONS.amazon` already exists — sales 4010, tax 2230, refunds 4300,
  fees 5410, outbound shipping 5300, clearing 1030
- `settlement-revenue.ts` already maps Amazon: `SALES_ACCOUNT` 4010, `FEE_ACCOUNT` 5410,
  contact "Amazon", invoice prefix `AMZN-`
- `CHANNEL_LABELS` (P&L), reconciliation labels, the Xero mappings settings UI
  (`PLATFORMS` list) and `humanPlatformForBank()` all already list `amazon`
- The generic `xero_*` tables are keyed by `source_platform` — no schema change needed
- **Faire added zero new finance tables.** It reused `orders`, synthetic `settlements`, and the
  generic Xero tables. Amazon can do the same.

⚠️ **Do not confuse with existing code:** `src/modules/catalog/lib/amazon/`,
`/api/v1/integrations/amazon/*` and `/settings/integrations/amazon/*` already exist but are
**catalog/listing-generation only** (keywords, listing copy). Nothing to do with sales or finance.

---

## 4. Decision #1 — how Amazon sales enter the ledger (needs your sign-off)

This is the one genuine architectural fork, and it follows directly from "don't import orders."

Everything downstream in The Frame — the P&L engine, the dashboard channel-mix widget, Slack
digests, reconciliation — reads from the `orders` table. Shopify and Faire both recognise revenue
per-order at shipment, and deplete COGS per `order_item`. If Amazon has no rows in `orders`, it
appears in **none** of those surfaces by default. So we either create order rows, or we teach the
read-layer about a new aggregate source.

### Option A — Aggregate-only *(recommended)*

Never write to `orders`. Store Amazon sales as **daily SKU-level aggregates** in a new
`amazon_sales_daily` table, and teach the four read paths (P&L, channel-mix, digests,
reconciliation) to union it in.

- ✅ Honours the instruction exactly — no orders, no fulfilment coupling, no risk of an Amazon
  order accidentally reaching ShipHero or a stuck-order alert
- ✅ Honest data model: FBA orders are fulfilled from Amazon's warehouse, never touch ShipHero,
  and have no meaningful `shipped_at` in our world. Synthetic order rows would misrepresent that.
- ✅ No pollution of the `/orders` list with ~20 rows/week of untouchable records
- ❌ Requires ~4 bounded read-path edits so Amazon shows up in reporting

### Option B — Synthetic order rows

Write Amazon order lines into `orders`/`order_items` with `channel='amazon'`, excluded from all
fulfilment paths by a guard list.

- ✅ Maximum reuse — P&L, dashboards, reconciliation, COGS all work with near-zero new code
- ❌ Contradicts the stated instruction
- ❌ Requires a hard exclusion list (ShipHero sync, stuck-order alerts, shipping alerts, packing
  slips). Every future feature touching `orders` must remember Amazon is special — a standing
  footgun.

**Recommendation: Option A.** The read-path edits are bounded and one-time; the Option B exclusion
list is a permanent maintenance tax, and it would put rows in `orders` that we can never fulfil,
cancel, or reconcile the way every other row in that table behaves.

---

## 5. Architecture

```
Windsor AI (amazon_sp)
        │  narrow windows, 1 report per call, retry+backoff
        ▼
┌─────────────────────────────────────────────────┐
│ 1. Generic Windsor client  (multi-connector)    │  ← reused later for TikTok/Facebook
├─────────────────────────────────────────────────┤
│ 2. RAW LANDING TABLES  (append-only, permanent) │  ← beats the 90-day cliff
│    amazon_settlement_rows / amazon_order_rows   │
├─────────────────────────────────────────────────┤
│ 3. Normalise → settlements + settlement_line_items
│                amazon_sales_daily               │
├─────────────────────────────────────────────────┤
│ 4. Journals → Xero (existing xero-client)       │
│ 5. COGS → existing FIFO engine, channel='amazon'│
│ 6. Dashboard + month-end reporting              │
└─────────────────────────────────────────────────┘
```

**The raw landing layer is non-negotiable.** Ingest writes rows exactly as Windsor returns them,
append-only, keyed by a natural idempotency key. Normalisation reads from our own tables, never
from Windsor. This means we can re-derive journals, fix a mapping bug, or restate a month without
needing Windsor to still have the data — which after 90 days it will not.

### Build the client generic from day one

Per your note about TikTok Shop and Facebook later: `src/modules/integrations/lib/windsor/client.ts`
should be a **connector-agnostic** Windsor client —
`fetchWindsor(connector, report, fields, {dateFrom, dateTo})` — handling auth, the report-prefix
field convention, chunked date windows, retry/backoff, and timeouts. Amazon becomes the first
caller, not a special case. Adding TikTok Shop later is then a config entry plus a mapper, not a
new integration.

The API key goes in an env var (`WINDSOR_API_KEY`) — it must not be committed.

---

## 6. Schema changes

New tables (must be added in **all three** DDL locations — the Drizzle schema file,
`src/lib/db.ts` boot DDL, **and** `src/__tests__/setup.ts`, or tests will fail):

**`amazon_settlement_rows`** — permanent raw settlement archive
`id, settlement_id, posted_date, transaction_type, amount_type, amount_description, amount,
currency, sku, order_id, quantity_purchased, marketplace_name, settlement_start_date,
settlement_end_date, deposit_date, total_amount, raw_json, ingested_at`
Idempotency: unique on `(settlement_id, order_id, amount_type, amount_description, posted_date, amount)`.

**`amazon_order_rows`** — raw order-report archive
`id, amazon_order_id, purchase_date, sku, asin, quantity, item_price, item_tax,
item_promotion_discount, order_status, item_status, fulfillment_channel, currency, ship_state,
raw_json, ingested_at`
Idempotency: unique on `(amazon_order_id, sku)`, upsert on later pulls (status changes).

**`amazon_sales_daily`** — normalised daily aggregate powering the dashboard and COGS
`id, date, sku, internal_sku, units_ordered, units_shipped, gross_sales, promotions, net_sales,
tax, refunds, referral_fees, fba_fees, other_fees, sessions, page_views, buy_box_pct,
conversion_rate, created_at, updated_at`

**`amazon_sync_state`** — per-report watermark so each report tracks its own progress
`report_name, last_synced_through, last_run_at, last_status, last_error`

Existing-table edits: add `deferred_revenue` + `receivables_holding` as `_shared`
`xero_account_mappings` rows (required by the loaders but absent from the suggestion catalog), and
extend `PLATFORM_CATEGORY_SUGGESTIONS.amazon` with the Amazon-specific fee categories in §7.

---

## 7. Daily journal entries — the fee taxonomy

This is the complete transaction taxonomy **observed in our actual settlement data**, not a guess
from Amazon's docs. Every row type below has appeared in our 288 settlement rows.

| transaction_type | amount_type | amount_description | Meaning | Proposed account |
|---|---|---|---|---|
| Order | ItemPrice | Principal | Gross product sales | 4010 Sales – Amazon (CR) |
| Order | ItemPrice | Tax | Sales tax collected | 2230 Sales Tax (CR) |
| Order | ItemWithheldTax | MarketplaceFacilitatorTax-Principal | Tax withheld & remitted by Amazon | 2230 (DR) — nets to zero |
| Order | ItemPrice | Shipping | Shipping income | 4060 Shipping Income (CR) |
| Order | Promotion | Principal | Promotional discount | **4020 Sales Discounts – Amazon (DR, contra-revenue)** |
| Order | Promotion | Shipping | Shipping promo | 4060 (DR) |
| Order | ItemFees | Commission | Referral fee | 5410 Merchant Fees – Amazon (DR) |
| Order | ItemFees | FBAPerUnitFulfillmentFee | FBA pick/pack/ship | **5415 FBA Fulfilment Fees (DR)** |
| Refund | ItemPrice | Principal | Refund of sale | 4300 Sales Returns (DR) |
| Refund | ItemPrice | Tax | Tax refunded | 2230 (DR) |
| Refund | ItemWithheldTax | MarketplaceFacilitatorTax-Principal | Withheld tax reversed | 2230 (CR) |
| Refund | ItemFees | Commission | Referral fee credited back | 5410 (CR) |
| Refund | ItemFees | RefundCommission | Refund administration fee | 5410 (DR) |
| FBAFees | FBA Amazon-Partnered Carrier Shipment Fee | Base fee / Discount on Fee | Inbound freight (currently nets to zero) | **5010 COGS Freight (DR)** |
| FBAFees | FBA Inventory Storage Fee | Base fee | FBA storage | **5420 FBA Storage Fees (DR)** |
| other-transaction | — | Subscription Fee | Seller account subscription | **5430 Amazon Subscription (DR)** |
| other-transaction | — | Inbound Transportation Fee | Inbound freight to FBA | 5010 COGS Freight (DR) |
| other-transaction | — | Shipping label purchase for return | Return label | 5300 Outbound Shipping (DR) |
| other-transaction | — | Payable to Amazon / Successful charge | Card charge when settlement is negative | Clearing pair — nets to zero |
| Transfers | Micro Deposit | Micro Deposit | Bank verification penny | 1030 Amazon Clearing |

Accounts in **bold** do not exist in the current mapping suggestions and need adding — either as
new Xero accounts or mapped onto existing ones. **This table is the main thing I need you to
review**, since it determines how the P&L reads.

### Two structural points

**Marketplace facilitator tax nets to zero.** Amazon collects and remits sales tax on our behalf:
`ItemPrice/Tax` (+$34.73) and `ItemWithheldTax` (−$34.73) exactly offset. We must post both legs
rather than netting them silently, so the tax liability account shows the real gross flow and the
journal ties to the settlement.

**Promotions are contra-revenue, not a discount on the sale price.** At 71% of gross this is far
too material to net against revenue — it needs its own line so we can see true gross demand
separately from launch-discount cost.

### Posting model

Follow the existing `payout_revenue_model` switch, matching Shopify/Faire:
- **`invoice` (settlement-date)** — one ACCREC invoice per settlement, `AMZN-{settlement_id}`,
  fees as negative lines so the invoice total equals the deposit and the bank matches 1:1.
  Slots into the existing `settlement-invoice-builder.ts` as an `amazonPayoutToComponents()`
  adapter — a pure function, unit-testable with no DB, exactly like the Faire/Shopify adapters.
- **`deferred`** — manual journal deferring gross to 2050, bank sweep 1100 → 1030.

Idempotency: `xero_payout_syncs (source_platform='amazon', source_payout_id=<settlement_id>)`,
inserted **only after** a successful post, so failures retry on the next run. Plus a synthetic
`settlements` + `settlement_line_items` row (`external_id = amazon_settlement_{id}`) so
reconciliation and the P&L can join — the same bridge `ensureFaireSettlement()` provides.

---

## 8. COGS

Good news: **Amazon COGS rides the existing daily COGS journal for free.** I verified
`calculateCogs()` reads all rows from `inventory_cost_depletions` in a date range and groups by
`d.channel`, with no dependency on `orders` or `order_items`. So if we write depletions with
`channel='amazon'`, they flow into the existing consolidated daily journal automatically. The only
edit needed is an `amazon` case in `channelLabel()`.

**The trap.** `depleteInventoryFifo()` keys its idempotency guard *solely* on `order_item_id`:

```
if (opts.orderItemId) { ...skip if already depleted... }
```

With no `orderItemId` there is **no guard at all** — every re-run would deplete inventory again and
silently corrupt the FIFO layers and overstate COGS. Since Option A has no order items, we must
supply a **deterministic synthetic key**:

- `order_item_id = "amzn-{YYYY-MM-DD}-{internal_sku}"`
- `order_id = "amzn-{YYYY-MM-DD}"`

This reuses the existing guard exactly as designed, gets idempotency for free, and makes every
Amazon depletion traceable back to the day and SKU that caused it. No change to `fifo-engine.ts`.

**Depletion trigger.** Shopify/Faire deplete on `shipped_at`. For Amazon we use **units shipped per
SKU per day** from the sales-and-traffic report (`salesbydate_unitsshipped`, with per-SKU
attribution from the orders report) — that is the ASC 606-consistent point and it matches when
Amazon actually ships from FBA.

**SKU mapping.** Strip the `-FBA` suffix, then resolve against `catalog_skus`, falling back to
`catalog_sku_aliases`. Unmapped SKUs must raise a `cogs_exceptions` row of type `unmapped_sku`
(never silently cost at zero) — the existing exception machinery handles this.

### ⚠️ Open issue: FBA inventory is not ShipHero inventory

Worth flagging clearly, because it interacts with the "everything goes to ShipHero" assumption.
**20 of 21 recent orders were FBA** — fulfilled by Amazon from Amazon's warehouses, never touching
ShipHero. Units are sent from ShipHero to Amazon FBA in advance as an inbound shipment.

Accounting consequence: moving stock ShipHero → FBA is an **inventory transfer, not a sale**, and
our FIFO layers currently live against ShipHero stock. If we deplete FIFO at Amazon sale time
(correct for COGS) we must make sure the same units were not already written off when they left
ShipHero. I could not verify how ShipHero currently reports the outbound-to-Amazon movement.

**This needs a decision before we code COGS.** Options: treat FBA stock as a separate location in
the FIFO model, or treat the FBA inbound as a non-depleting transfer. I'd suggest confirming how
the ShipHero → FBA movement is currently recorded first — that determines which is correct.

---

## 9. Dashboard

New route `/finance/amazon` (or a tab on the existing `/finance`), fed by
`/api/v1/integrations/amazon/metrics`. Reads `amazon_sales_daily` — fast, no live Windsor calls.

**Headline tiles:** Gross sales · Promotions (with % of gross) · Net sales · Units · Referral fees ·
FBA fees · Net settled · Contribution margin after COGS and fees.

**Charts:**
- Daily net sales vs units, with promotions as a distinct contra band — the launch-discount story
- Sessions / conversion / Buy Box % from the sales-and-traffic report (Amazon-only metrics we get
  nowhere else; genuinely useful for merchandising)
- Top SKUs by units and by contribution margin
- Fee-load ratio over time (total Amazon fees ÷ gross) — the key health metric for the channel

**Tables:** settlement history with status and Xero link; unmapped-SKU / COGS exceptions;
sync health per report (last successful pull, row counts, errors).

Amazon also needs to appear in existing surfaces: P&L channel table, dashboard channel-mix widget,
Slack daily/weekly digests, reconciliation — the four Option A read-path edits.

---

## 10. Month-end reporting

Reuses the existing engine once Amazon revenue is visible to `pnl.ts`:
- `calculatePnl()` gains an Amazon channel row (revenue, COGS, gross margin, fees, `hasFullCostData`)
- Reconciliation view: settlement gross vs recognised revenue, flagging >2% discrepancies
- Period-close: Amazon rides the existing `xero_period_lock_date` and the reverse-and-repost
  correction pattern (`correctCogsForDate`) — never edit a posted journal in place
- Month-end checklist additions specific to Amazon: unreconciled settlements, unmapped SKUs, FBA
  reimbursements (`get_fba_reimbursements_data` — inventory Amazon lost or damaged and paid us
  for; these are income and easy to miss), and the promotions total

---

## 11. Cron jobs

Added to `src/modules/integrations/lib/cron/registry.ts` (never a new Railway service). The
existing daily finance chain runs 15:00 → 16:45 UTC; Amazon slots in after Faire and before
revenue recognition, so the downstream jobs pick it up the same day:

| id | Schedule (UTC) | Purpose |
|---|---|---|
| `amazon-sales-sync` | `0 14 * * *` | Pull orders + sales/traffic for T-1 and a 7-day trailing restatement window |
| `amazon-settlement-sync` | `20 16 * * *` | Pull settlement rows → raw archive → normalise → Xero journals |
| `amazon-cogs-depletion` | `40 16 * * *` | Deplete FIFO by SKU/day, just before `daily-cogs-posting` at 16:45 |

Note the 5-minute Railway tick floor — schedules finer than `*/5` fire less often than written.

---

## 12. Delivery phases

| Phase | Deliverable | Why this order |
|---|---|---|
| **1** | Generic Windsor client + raw landing tables + backfill of all 90 days available today | **Do this first and ship it.** Every day we wait, older settlement data ages out of the 90-day window permanently. This phase alone stops the bleeding. |
| **2** | Normalisation → `amazon_sales_daily` + `settlements`, sync-state tracking, cron jobs | Establishes the data spine |
| **3** | Dashboard + read-path edits (P&L, channel-mix, digests, reconciliation) | Gives you visibility early, before the accounting is finalised |
| **4** | Xero journals — account mapping, invoice/journal builder, idempotency, settlement bridge | Needs your sign-off on §7 first |
| **5** | COGS depletion + FBA/ShipHero inventory question resolved | Needs the §8 decision |
| **6** | Month-end reporting, reconciliation, exception handling | Completes parity with Shopify |
| **7** | *(Later)* TikTok Shop, Facebook/Amazon ads spend via the same Windsor client | Connector config + mapper only |

**Phase 1 is genuinely time-sensitive.** We are currently losing settlement history on a rolling
basis, and it is not recoverable from Windsor once it ages out.

---

## 13. Decisions I need from you

1. **Option A vs B** (§4) — aggregate-only, or synthetic order rows? I recommend A.
2. **The account mapping table** (§7) — particularly the new accounts: 4020 Sales Discounts,
   5415 FBA Fulfilment Fees, 5420 FBA Storage, 5430 Amazon Subscription. Create these in Xero, or
   map onto existing accounts?
3. **FBA vs ShipHero inventory** (§8) — how is the ShipHero → Amazon FBA movement recorded today?
   This determines whether FIFO depletion at Amazon sale time double-counts.
4. **Revenue model** — settlement-date `invoice` or `deferred`? Recommend matching whatever
   Shopify/Faire currently use, so the P&L stays consistent across channels.
5. **Backfill depth** — pull everything available in the 90-day window now (recommended), or start
   from a clean month boundary such as 1 July?

---

## 14. Notes for implementation

- `WINDSOR_API_KEY` in env — never committed
- All money as float dollars, `round2` convention, 0.01 tolerance (matches existing finance code)
- Keep payload builders **pure** (no DB, no fetch) and unit-test directly — the pattern used by
  `settlement-invoice-builder.test.ts`; mock `xero-client` and Slack for orchestrator tests
- New tables go in **three** DDL locations: Drizzle schema, `src/lib/db.ts`, `src/__tests__/setup.ts`
- Read `node_modules/next/dist/docs/` before writing route code — this Next.js version differs from
  what the model expects
