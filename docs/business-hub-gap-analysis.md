# The Frame as the business operating hub — gap analysis & roadmap

_Audit date: July 2026. Basis: 117 tables, ~250 v1 API routes, 60+ pages across 13 modules._

---

## 1. Where we actually are

The Frame is already well past "a CRM with some extras." Nine domains are genuinely operational:

| Domain | Covered | Depth |
|---|---|---|
| **Sales / CRM** | Prospects, ICP scoring, segments, campaigns, Pipedrive as deal system-of-record, PhoneBurner calls, Instantly email, Meta lead ads | Deep |
| **Catalog** | Products, SKUs, images + pipelines, SEO/copy generation, tags, Amazon listings, Shopify metafield sync | Deep |
| **Orders** | Shopify DTC + Wholesale, Faire, international shipping requests | Deep |
| **Fulfilment** | ShipHero inventory/orders/shipments, Faire packing slips, ship-mark automation | Deep |
| **Inventory** | Stock, demand forecast v2, reorder plan, POs, QC inspections, FIFO landed cost | Deep |
| **Finance** | P&L, FIFO COGS, Xero journals, settlements, payouts, expenses, cash-flow trajectory | Deep |
| **Customers** | Accounts, RFM health scoring, churn analysis, reorder prediction | Medium |
| **Marketing** | Email campaigns, video studio, social posts, influencers, SEO keywords, ad campaigns, calendar | Medium (uneven) |
| **Platform** | Cron scheduler, integrations, notifications, RBAC, AI/MCP, activity feed | Deep |

**The honest summary:** we are excellent at *recording what happened* and increasingly good at *predicting what to buy*. We are weak at *stating what we intended*, *closing the loop on spend*, and *managing risk*.

---

## 2. The gaps, ranked by business impact

### Tier 1 — Costing money or creating risk today

#### 1.1 There is no plan to measure against
Every metric in the hub is an actual, compared to a prior period. Nowhere in 117 tables is there a revenue target, a unit goal, a rep quota, or a category plan. The only budget field that exists is `expense_categories.budget_monthly`.

**Consequence:** the dashboard can tell you revenue is $84k and up 12%, but not whether that is a good month. Nobody can be held to a number, and no variance conversation is possible.

**Fix:** a `targets` table (`metric`, `scope` — company/channel/rep/product — `period`, `value`) plus target overlays on the dashboard KPI tiles, the revenue trend line, and the P&L. Small build, disproportionate impact — it converts the hub from a mirror into a management tool.

#### 1.2 Ad spend never enters the system → no CAC, no ROAS, no payback
`marketing_ad_campaigns` has `spend`, `impressions`, `clicks`, `conversions`, `revenue` and `monthly_budget` — but it is **manual entry**, not synced. Meanwhile we just built the Conversions API to push conversions *to* Meta. Data flows out; money spent never flows in.

**Consequence:** we cannot compute blended CAC, channel-level CAC, LTV:CAC, or payback period. We are optimising ad delivery while flying blind on ad efficiency. For a brand actively running Meta lead ads, this is the single biggest analytical hole.

**Fix:** pull spend from the Meta Ads API (same app/token we already registered) on a daily cron; join to `meta_leads` → `companies` → `orders` for true cost-per-lead and cost-per-acquired-door. Extend to Google/TikTok later. Then a marketing-efficiency widget: CAC by channel, LTV:CAC by cohort, payback months.

#### 1.3 No resale certificate / sales-tax exemption tracking
Zero hits across the codebase for `resale`, `tax_exempt`, `exemption`, `w9`.

**Consequence:** every US wholesale account should have a valid resale certificate on file, with an expiry. Without it, an auditor can assess uncollected sales tax against us for those sales. This is a real, quantifiable liability that grows with every new door we open.

**Fix:** `tax_documents` (company, type, state, number, issued/expires, file) + a required-doc flag on `customer_accounts` + expiry alerting + a "missing/expiring certificates" list. Pair with a document store (§2.10).

#### 1.4 Returns are a stub, so quality is invisible
The `returns` table has `reason`, `status`, `refund_amount` — and there is one API route. There is no RMA workflow, no reason taxonomy, no defect-rate rollup by SKU or factory, and no link to `inventory_qc_inspections`.

**Consequence:** for eyewear, returns *are* the quality signal — hinge failures, coating defects, lens separation. Right now a bad production run surfaces as vague customer complaints, not as a number attached to a factory and a PO.

**Fix:** RMA flow (request → approve → receive → disposition → refund/replace), a structured reason taxonomy, and a return-rate-by-SKU/factory/PO metric feeding §1.5.

#### 1.5 No supplier scorecard
We have `inventory_factories` (lead times, MOQ) and `inventory_qc_inspections` (defect rates), but nothing joins them into a performance view: on-time delivery %, promised vs actual lead time, defect trend, unit-price drift, landed cost per unit over time.

**Consequence:** we just committed **$75,732 across 5 POs and 4 factories** on relationship and gut feel. We have the raw data to know which factory actually delivers on time and defect-free — we just never compute it.

**Fix:** a factory scorecard page: on-time %, avg lead-time variance, defect rate, price trend, total spend, return rate of their goods. Then let it influence the reorder plan (prefer the reliable factory when both can make a style).

---

### Tier 2 — Structural leverage

#### 2.6 Two parallel purchase-order systems
`catalog_purchase_orders` / `catalog_purchase_order_items` **and** `inventory_purchase_orders` / `inventory_po_line_items` both exist. The forecast and FIFO engines read the inventory pair.

**Consequence:** ambiguity about which is authoritative; risk that a PO entered in one is invisible to the forecast (exactly the failure mode we hit before importing the current POs).

**Fix:** pick `inventory_purchase_orders` as canonical, migrate and drop the other, or explicitly document the catalog pair as intake-only.

#### 2.7 No inbound logistics or landed-cost-per-shipment tracking
POs carry `tracking_number`, `freight_cost`, `duties_cost`, `shipping_method`, but there are no shipment milestones (factory → port → vessel → customs → 3PL), no HTS codes, no duty rates per product.

**Consequence:** with China-sourced goods and volatile tariffs, duty is a first-order margin variable we treat as a single number typed in after the fact. We cannot answer "what will this container actually cost to land?" before it ships.

**Fix:** an inbound `shipments` object with milestones and ETA, HTS code + duty rate on the product, and a landed-cost estimate at PO time that reconciles to actual on receipt.

#### 2.8 Cash forecast ignores PO commitments
`finance/cash-flow` and `finance/trajectory` exist, but the $75k of POs shipping Aug 5–22 is not modelled as future cash out.

**Consequence:** the cash view is optimistic by exactly the amount we have already committed. For an inventory-heavy business, that is the number that matters most.

**Fix:** feed open-PO value + expected payment dates into the cash forecast; add a runway figure and a "committed vs available cash" line.

#### 2.9 No AR aging or collections
Wholesale means net terms. `customer_accounts.payment_terms` exists, but there is no invoice aging, no overdue list, no dunning.

**Consequence:** collections risk is managed in Xero (or in someone's head) rather than where the customer relationship lives.

**Fix:** pull AR aging from Xero into a customers view; overdue badge on the account; automated reminder sequence.

#### 2.10 No document store
Contracts, factory agreements, W-9s, resale certificates, insurance certificates, tech packs, commercial invoices — none have a home.

**Fix:** a generic `documents` table (entity type/id, category, file, expiry, uploaded_by) reusable by companies, factories, POs and products. This unlocks §1.3 and §2.7.

#### 2.11 No customer-service surface
No tickets, no shared inbox (the campaign inbox was retired). Support lives in email and Slack.

**Consequence:** a store's complaint history is invisible on their account page, so health scoring and reorder outreach are blind to dissatisfaction.

**Fix:** at minimum, a lightweight interaction log on the company record (type, channel, summary, resolved) — even manually entered — so support history is part of the customer picture. A full helpdesk is probably better bought than built.

---

### Tier 3 — Growth and scale

- **2.12 No product-development pipeline.** We just launched ~23 new styles; the process (concept → tech pack → sample rounds → approval → production) happened entirely outside the hub. No sample tracking, no approval record, no launch checklist.
- **2.13 No rep / agency performance.** AJM is an agency and Christina/Sandra own pipelines, but there is no territory, quota, commission calculation, or rep scorecard.
- **2.14 No event/trade-show ROI.** Faire Market generated a large lead batch; there is no event object to attribute cost against resulting orders.
- **2.15 No pricing or promotion governance.** No price lists, no MAP policy, no promo calendar with measured lift. Only a per-account `discount_rate`.
- **2.16 Content performance loop is open.** The video studio *produces* posts and `marketing_social_posts` exists, but engagement is never pulled back, so we cannot learn which hooks, products or creators actually perform.
- **2.17 No compliance or lot traceability.** Eyewear carries real obligations (FDA impact-resistance record-keeping, Prop 65, CE/UKCA for any EU/UK sales). There is no lot/batch chain from PO → shipment → order, so a recall would be a manual archaeology project.
- **2.18 Forecast accuracy is never measured.** We have a good forecast; nothing compares forecast to actual, so it cannot improve systematically.

---

### Tier 4 — Making the hub the operating system

- **2.19 No management rhythm.** `generateReport()` exists but is not wired to a cadence. There is no auto-delivered Monday business review with variance-to-target commentary.
- **2.20 Alerting is rule-based, not anomaly-based.** We alert on known events (out of stock, payout, webhook flood). Nothing detects "revenue down 30% week-over-week", "this SKU's return rate tripled", or "a channel stopped syncing."
- **2.21 No data-quality dashboard.** `cogs_exceptions` is good but narrow. There is no single view of unmapped SKUs, orders without a company, products missing cost, stale integration syncs.
- **2.22 RBAC is not enforced server-side.** Role helpers (`requireRoleForRoute`, `canAccessRoute`) exist and are tested but are called almost nowhere; gating is client-side nav filtering plus the few endpoints hardened recently. Two divergent permission maps exist (`auth-middleware.ts` vs `sidebar.tsx`).

---

## 3. Recommended roadmap

Sequenced by value-per-effort, not by tier number.

### Phase 1 — Make the hub manageable (2–3 weeks)
1. **Targets & variance** (§1.1) — `targets` table, dashboard overlays, P&L plan column.
2. **Marketing efficiency** (§1.2) — Meta Ads spend sync, CAC/LTV:CAC/payback, marketing-ROI widget.
3. **Data-quality dashboard** (§2.21) + **server-side RBAC** (§2.22) — trust the numbers and the access model.

**Outcome:** every number has a target, marketing has a cost, and the data can be trusted.

### Phase 2 — Close the risk gaps (2–3 weeks)
4. **Document store** (§2.10) then **resale certificates** (§1.3) — compliance exposure closed.
5. **RMA / returns workflow** (§1.4) with reason taxonomy and defect rollup.
6. **Supplier scorecard** (§1.5) — fed by §1.4 plus QC and PO history.
7. **PO consolidation** (§2.6).

**Outcome:** we know which factories perform, quality is measurable, and audit exposure is closed.

### Phase 3 — Cash and supply chain (3–4 weeks)
8. **PO commitments in cash forecast + runway** (§2.8).
9. **AR aging + collections** (§2.9).
10. **Inbound shipment tracking + HTS/duty and landed-cost estimation** (§2.7).
11. **Forecast accuracy tracking** (§2.18).

**Outcome:** we can answer "can we afford this buy, and what will it actually land at?"

### Phase 4 — Growth systems (ongoing)
12. Product-development pipeline (§2.12), rep/commission tracking (§2.13), content performance loop (§2.16), pricing & promo governance (§2.15), event ROI (§2.14).
13. Weekly auto-delivered business review (§2.19) and anomaly alerting (§2.20).

---

## 4. Three habits that would change how the business runs

Tools only matter if they change behaviour. Concretely:

1. **Monday variance review.** An auto-generated pack in Slack: revenue/units/margin vs target, top 3 movers, reorder risks, pipeline changes, cash runway. Requires Phase 1 only.
2. **Buy decisions made from the scorecard, not the relationship.** Before each PO round, open the reorder plan next to the supplier scorecard: quantities from the forecast, factory choice from performance. Requires Phase 2.
3. **Every channel carries a cost.** Once ad spend, call time and mail cost sit next to the orders they produced, the question shifts from "how many leads did we get?" to "what did a paying door cost us, and which channel is cheapest?" Requires Phase 1 (§1.2) plus modest instrumentation on calls and mail.

---

## 5. What I would do first, if only one thing

**Targets (§1.1).** It is the smallest build in the list and it changes every screen we already have: each KPI, chart and report gains a benchmark, and management conversations move from "here is what happened" to "here is the gap and why." Everything else is more valuable once there is a plan to measure against.
