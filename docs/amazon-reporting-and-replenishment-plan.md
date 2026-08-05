# Amazon reporting & FBA replenishment — plan

Two deliverables, one shared data layer. Written after probing the live Windsor
catalog, so every field named here is confirmed available on **this** account —
nothing below is aspirational except where explicitly marked ⛔.

---

## 0. What the account can actually serve

`GET /api/admin/ops/amazon?view=catalog` — 23 reports, 899 fields on
`amazon_sp`. We currently use 7 of the 23.

| Need | Report | Status |
|---|---|---|
| Per-ASIN sessions, page views, CVR, buy box | `get_sales_and_traffic_report` | ✅ available, **not yet pulled** (we take 11 of 115 fields, by date only) |
| Restock recommendations | `get_restock_inventory_recommendations_report` | ✅ available, not pulled |
| Days of cover, excess, sell-through, storage fees | `get_fba_inventory_planning_data` | ✅ available, not pulled |
| Per-SKU FBA fee estimates | `get_fba_estimated_fba_fees_txt_data` | ✅ available, not pulled |
| Product titles for readable reports | `get_merchant_listings_all_data` | ✅ available, not pulled |
| Search query performance | `get_brand_analytics_search_query_performance_report` | ✅ available, not pulled |
| **Ad spend / ACOS / TACOS** | connector `amazon_ads` | ⛔ **connector exists, no account linked** |

### ⛔ The one blocker — read this first

Windsor answered `amazon_ads` with *"No amazon_ads account for user … was
found"*, not *"We don't have this connector yet"* (which is what `amazon` and
`amazon_dsp` returned). **The connector is supported; your Amazon Ads account
just isn't linked in Windsor.**

Until it is, **ACOS, TACOS, ad spend and net profit after advertising cannot be
produced** — which is most of what your reference reports lead with. Everything
else below works today.

This is a five-minute job in the Windsor dashboard and it gates the highest-value
half of the reporting work. `tiktok_shop`, `facebook` and `google_ads` returned
the same "no account" message, so the same one action unlocks those later.

### Two places we're already ahead of the reference reports

1. **Their COGS is a flat $5.00/unit, operator-entered, applied to every ASIN
   and every month.** Their own footnote flags it. We have real FIFO landed cost
   per unit including freight and duties, per layer. Our per-ASIN margins will be
   correct where theirs are indicative.
2. **Vine.** 38% of your units shipped for zero consideration. Any report built
   on gross sales counts those at list price. Ours won't — the seeding split
   already exists.

---

## Part A — Reports

Three artifacts, mirroring the three you sent, in build order.

### A1. Account summary, month over month

The single most useful thing you sent. Metric rows × month columns + a change
column.

| Metric | Source | Blocked on ads? |
|---|---|---|
| Gross sales (list) | order rows | no |
| **Seeding / Vine giveaway** | order rows, discount split | no |
| **Net sales (paid)** | gross − giveaway | no |
| Units / orders / AOV | order rows | no |
| Referral + FBA fees | settlements | no |
| COGS (real landed) | FIFO depletions | no |
| **Contribution margin** | net sales − fees − COGS | no |
| Ad spend / ACOS / TACOS | `amazon_ads` | ⛔ yes |
| **Net profit / net margin** | contribution − ad spend | ⛔ yes |

Note the extra row theirs doesn't have. On an account where 38% of units are
giveaways, "Total Sales" without a giveaway line is the number that misleads.

**Ship contribution margin now, net profit when ads land.** Contribution margin
is honest and complete on its own; presenting a "net profit" that silently
excludes advertising would be worse than not showing it.

### A2. "How to read it" — auto-generated

Their report has a written narrative under the table, and it is why the report
is digestible. It's also the most automatable part, because it's a small number
of deterministic observations:

- Direction and size of the biggest mover, in plain words.
- The single worst line item, named. *("The drag is one ASIN: B0CRMSLPLH…")*
- Whether added spend was accretive at the account level.
- **A provenance/accuracy paragraph.** Theirs says which date the data is
  reliable from and that COGS is a flat estimate. Ours should say: settlement
  data only exists from *(90-day window start)*, ad spend from *(connector link
  date)*, and Amazon's own reports run T-2.

Rules, so it stays trustworthy rather than becoming filler:

- Only state a comparison when both periods have data. A month with three days
  in it does not get a trend sentence.
- Name the SKU/ASIN, never "some products".
- Say when something **cannot** be computed and why, rather than omitting it.
  A missing number that isn't explained reads as a zero.

### A3. Per-ASIN profitability, month over month

Their per-ASIN sheet, with real costs. One row per child ASIN, grouped under
parent, three month-blocks of Sales / ACOS / Profit / Margin, sorted by latest
month sales, red where profit or margin is negative.

Additions worth making:

- **Paid units vs seeded units** as separate columns. An ASIN can look like a
  strong seller and be 90% Vine.
- **Sessions and CVR per ASIN** (`trafficByAsin-sessions`,
  `trafficByAsin-unitSessionPercentage`) — this is how you tell a traffic problem
  from a conversion problem, and it's in a report we already have access to.
- **Real landed cost per unit**, shown, so a margin can be traced.

### A4. Live dashboard

The third screenshot: weekly YoY trend charts, a daily breakdown with heatmap
colouring, and an ASIN performance table.

Realistic scope note: **YoY needs a prior year.** Amazon's settlement window is
90 days and this account started selling in June. The YoY charts in your
reference are only possible because that account has years of history. We should
build the same charts but render **weekly this-year with a rolling 4-week
average**, and let the YoY series appear automatically once there's a prior year
to draw. Building an empty YoY chart is worse than not building it.

The daily heatmap table works today: date, units, gross, giveaway, paid, sessions,
CVR, ASP, and fee load — coloured by percentile so outliers pop.

### Delivery format

Build once, render three ways:

- **In The Frame** — the finance/amazon page, the live version.
- **Scheduled Slack digest** — Monday morning, the A1 table plus the A2
  narrative. This is what actually gets read.
- **Export** — CSV/XLSX matching the per-ASIN sheet layout, so it drops into
  the spreadsheets you already use.

---

## Part B — FBA replenishment

### B1. Don't rebuild forecasting — Amazon already gives us the answer

`get_restock_inventory_recommendations_report` returns, per SKU:
`Recommended replenishment qty`, `Recommended ship date`, `Alert`,
`Recommended action`, `Days of Supply at Amazon Fulfillment Network`,
`Total Days of Supply (including units from open shipments)`,
`Units Sold Last 30 Days`, `Inbound`, `Working`, `Receiving`, `Available`.

`get_fba_inventory_planning_data` adds `healthy-inventory-level`,
`weeks-of-cover-t7/t30/t90/t180`, `sell-through`, `estimated-excess-quantity`,
`recommended-removal-quantity`, inventory-age buckets and
`projected-ltsf-6-mo/12-mo` (long-term storage fee exposure).

**Amazon's recommendation is the baseline. The Frame's job is the three things
Amazon cannot know.**

### B2. The three corrections only we can make

**1. Amazon doesn't know what's in your warehouse.**
Its recommended qty is demand-side only. Constrain every proposal by ShipHero
available stock, and show the shortfall explicitly — "Amazon wants 400, we hold
150, short 250" is a purchasing signal, not an error.

**2. ⚠️ Amazon's velocity is inflated by Vine.**
`Units Sold Last 30 Days` counts giveaways. On this account that has been up to
90% of units in a month. Replenishing to Amazon's number would ship stock to FBA
to meet demand that **doesn't pay**.

This is the single most important thing in this plan. We compute paid-only
velocity from our own order rows and surface both:

```
Amazon says:     28 units/30d  →  recommends 220
Paid velocity:    6 units/30d  →  suggests    45
Difference is Vine (22 units). Recommend 45 + Vine plan.
```

Vine is a deliberate spend, so seeded units should be planned separately and
explicitly, not smuggled into a demand forecast.

**3. Amazon doesn't know your margins.**
Rank proposals by contribution per unit (real landed cost, real fees) × paid
velocity, so limited warehouse stock goes to the SKUs that earn. Amazon ranks by
its own revenue.

### B3. The other direction — what NOT to send

Equally valuable and usually ignored. `estimated-excess-quantity`,
`recommended-removal-quantity`, `no-sale-last-6-months` and
`projected-ltsf-6-mo` identify stock that is costing storage fees and should be
removed or discounted. A replenishment report that only ever says "send more" is
half a report.

### B4. Creating the transfer order

Today you create a $0 ShipHero order manually to move stock to FBA. Automate the
generation, not the sending:

1. **Proposal** — reviewable table, per SKU: Amazon recommends / paid-velocity
   suggests / warehouse available / **proposed qty** (editable) / contribution
   per unit / days of cover after.
2. **Confirm** — you adjust and approve. Never auto-sent.
3. **Generate** — produce the ShipHero transfer order and an FBA shipment plan
   CSV.
4. **Record** — write the expected FBA inbound so days-of-cover reflects
   in-flight stock immediately rather than waiting for Amazon to acknowledge it.

Two hard guards, both already true and both worth a regression test so they stay
true:

- **The $0 transfer must never generate COGS.** Moving stock between your own
  locations isn't a sale. It's safe today only because the ShipHero sync updates
  orders and never inserts them.
- **The transfer must never be pushed to Amazon as an order**, and the existing
  `channel != 'amazon'` guards must cover it.

---

## Build order

| Phase | Work | Blocked? |
|---|---|---|
| **1** | Pull per-ASIN sales & traffic + merchant listings (titles). Foundation for everything. | no |
| **2** | A1 account MoM + A2 narrative, contribution margin only. Slack digest. | no |
| **3** | Restock + inventory planning reports; the replenishment proposal with all three corrections. | no |
| **4** | Transfer order generation + FBA shipment CSV. | no |
| **5** | A3 per-ASIN profitability with real landed cost. | no |
| **6** | A4 dashboard: weekly trend + daily heatmap. | no |
| **7** | Ad spend: ACOS, TACOS, true net profit. Backfill A1/A3 with the ad columns. | ⛔ needs `amazon_ads` linked |
| **8** | Excess/removal recommendations + long-term storage fee exposure. | no |

Phases 1–6 and 8 are unblocked and can start now. Phase 7 is the one that needs
you.

---

## Open questions

1. **Link Amazon Ads in Windsor?** Gates ACOS/TACOS/net profit. Nothing else
   in this plan depends on it.
2. **Target days of cover for FBA** — 60 is a common default. Drives every
   replenishment quantity.
3. **Should Vine units be excluded from replenishment demand entirely, or
   planned as a separate line?** I'd plan them separately: it keeps the paid
   forecast clean while still shipping the units Vine needs.
4. **Slack digest cadence** — Monday weekly, or first-of-month?
