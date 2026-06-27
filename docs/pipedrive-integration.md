# Pipedrive integration — spec & rollout plan

**Status:** Draft for review · **Owner:** CRM / Sales · **Last updated:** 2026-06-27

This document specifies how the-frame will sync high-potential leads into
[Pipedrive](https://www.pipedrive.com/). It is a **plan**, not yet an
implementation — see [Open items](#11-open-items--prerequisites) for what's
needed before code lands.

---

## 1. Guiding principle — what Pipedrive is (and isn't)

The frame holds *all* prospects and runs *all* outreach automation. **Pipedrive
is not an outreach tool** — it is the **qualified-deal board** for the sales
team. A lead crosses into Pipedrive at exactly one of two moments:

1. **It shows interest** — asks for a catalog or "tell me more" in response to a
   cold email (Instantly) or call (PhoneBurner). → enters an outreach pipeline
   at the **Interested** stage.
2. **It places a wholesale order.** → a deal in the **Customers** pipeline.

Nothing earlier in the funnel ever reaches Pipedrive. Cold prospecting, cold
email, and cold calling all stay in the frame.

### The three buckets

| # | Bucket | Frame definition | Pipedrive pipeline | Enters at |
|---|--------|------------------|--------------------|-----------|
| 1 | **AJ Morgan reactivation** | Former AJM wholesale buyers (`source = 'ajm_2025_import'`) who respond to reactivation outreach | *AJM Reactivation* | Interested |
| 2 | **Catalog-interested** | Cold (non-AJM) leads who say they want a catalog via Instantly/PhoneBurner | *Catalog Interested* | Interested |
| 3 | **Customers** | **B2B wholesale** accounts who place an order (Shopify; Faire flows through Shopify) | *Customers* | Order placed |

### Decisions locked in (2026-06-27)

- **Pipedrive = qualified deals only.** Entry at *Interested* or *Order*, never
  during cold outreach.
- **All automation stays in the frame.** Cold + nurture email via Instantly; all
  calling via PhoneBurner. Pipedrive reflects stage and holds rep follow-up
  tasks — it does not send.
- **B2B wholesale only.** "Wholesale" = order `channel = 'shopify_wholesale'`
  (already detected on every order — see §6). DTC consumers are excluded.
- **Three separate pipelines** (above).
- **Two-way sync** — push deals out; pull stage/deal changes back into the frame.
- **One deal per order**, each backdated to the real order date; historical
  orders are backfilled. The **Customers pipeline is the single source of
  revenue truth** so a sale isn't double-counted against the nurture deal.

The frame remains the **system of record** for the full prospect universe.

---

## 2. How this maps to what already exists

Most of the spine is already built. Pipedrive is a **third fan-out target**
alongside Instantly and PhoneBurner, not new plumbing.

- **One lead table.** All leads live in `companies`
  ([`src/modules/sales/schema/index.ts`](../src/modules/sales/schema/index.ts))
  with a forward-only `status` pipeline:
  `prospect → qualified_lead → interested → catalog_sent → customer`
  (plus terminals `not_qualified / not_interested / ghosted / revisit_later`).
  Rules in [`status-progression.ts`](../src/modules/sales/lib/status-progression.ts).
- **Interest is already detected.** Instantly's `lead_interested` webhook and
  PhoneBurner's "Set Appointment" disposition both flip a company to
  `status = 'interested'` and fire the #sales-leads Slack alert. **This forward
  edge is the trigger to create the Pipedrive deal.**
- **Fan-out layer exists.** [`status-sync.ts`](../src/modules/sales/lib/status-sync.ts)
  mirrors status changes to Instantly + PhoneBurner with loop prevention via a
  `source` tag. Pipedrive slots in here.
- **An internal deal/stage model already exists.**
  [`pipeline.ts`](../src/modules/sales/schema/pipeline.ts) defines `deals` with
  stages `interested → catalog_sent → order_placed` (+ terminals), kept in sync
  by `status-progression.ts`. Pipedrive stages mirror this 1:1 so the two never
  disagree.
- **Orders already land in the frame.** Shopify webhooks
  ([`shopify-webhooks.ts`](../src/modules/orders/lib/shopify-webhooks.ts)) write
  the `orders` table with the real order date in `placedAt`, fire
  `eventBus.emit("order.created", …)`, and call `ensureCustomerAccount()`. This
  is the hook for creating (and backdating) Pipedrive order-deals.
- **Wholesale vs DTC is already detected.** Every order gets
  `channel = 'shopify_wholesale' | 'shopify_dtc'` (from the connected store's
  channel, or `wholesale`/`b2b` tags). This *is* the B2B filter — no new flag.
- **AJM import already exists.** [`ajm-import.ts`](../src/modules/sales/lib/ajm-import.ts),
  `/api/admin/sales/import-ajm`, the `ajm_*` columns, and
  `scripts/prep-ajm-import.py` turn an AJM spreadsheet into frame rows. Bucket
  #1's prerequisite is largely just *running* this with the real sheet.
- **A reorder engine already exists.** `customers/lib/reorder-engine.ts` plus
  `reorderDueAt` / `nextReorderEstimate` drive ongoing-customer follow-up.

---

## 3. Pipeline & stage design

Outreach pipelines start at **Interested** (everything before lives in the
frame). Stages mirror the internal `deals` model.

### Pipeline 1 — AJM Reactivation

| Stage | Enters when | Frame-driven automation (not Pipedrive) |
|---|---|---|
| **Interested** | AJM lead replies positively / asks for catalog (Instantly/PB) | Slack alert (exists); Pipedrive task "send catalog" created for Christina |
| **Catalog Sent** | Catalog emailed | Instantly follow-up sequence (day 3 / 7 / 14) + recurring PB call task |
| **Following Up** | Post-catalog, no order yet | Follow-up cadence continues until order or Lost |
| **Won** | First wholesale order | Deal Won; order also recorded in Customers pipeline (see §6) |
| **Lost** | Not interested / DNC | Sequences stop; blocklist (exists) |

> AJM cohort note: the reactivation message ("we're the new brand behind AJ
> Morgan") and the decision to call *all* of them is an Instantly/PhoneBurner
> campaign in the frame. Pipedrive only sees the ones who bite.

### Pipeline 2 — Catalog Interested (cold, non-AJM)

Identical stages to AJM (`Interested → Catalog Sent → Following Up → Won`, +
Lost); different cohort. Entry strictly at Interested.

### Pipeline 3 — Customers (revenue ledger + reorders)

- **Each order → one Won deal**, value = order total, dated to `placedAt`.
- Ongoing marketing/reorders are **activity-driven, not stage-driven**: the
  reorder engine drops a "reorder due — reach out" Pipedrive **activity** on the
  customer Organization (optionally plus a win-back email from the frame).
- No multi-stage funnel here by default. *(Open: could add Order Placed →
  Fulfilled → Delivered if an ops view is wanted — §11.)*

---

## 4. Pipedrive entity mapping

| Frame entity | Pipedrive entity | Notes |
|--------------|------------------|-------|
| `companies` row | **Organization** | Name, domain, address; ICP tier as custom field |
| `contacts` row | **Person** | Linked to the Org; email + phone |
| Interested lead | **Deal** | In the bucket's pipeline at the Interested stage |
| Order | **Deal** | One per order, Won, in the Customers pipeline, backdated |

Custom fields on Org/Deal (mirrors what we send to Instantly/PhoneBurner):
`frame_company_id`, `icp_tier`, `icp_score`, `industry`,
`estimated_yearly_sales`, `lead_bucket` (`ajm` | `catalog_interested` |
`customer`), `frame_status`. We do **not** use Pipedrive "Leads" — qualified
entries go straight to Deals.

---

## 5. Selection logic — who/what reaches Pipedrive

```
Outreach deal (event-driven, on the forward edge into 'interested'):
  companies.status transitions to 'interested'
    AND source = 'ajm_2025_import'   → AJM Reactivation pipeline
    ELSE                              → Catalog Interested pipeline

Order deal (event-driven, on order.created + backfill):
  order.channel = 'shopify_wholesale'   → Customers pipeline (Won, backdated)
  (DTC orders are ignored)
```

**Dedup:** never create a duplicate. Resolve by stamped `pipedrive_org_id` /
`pipedrive_person_id` first, then domain/email, then phone — same cascade as
[`lead-resolution.ts`](../src/modules/sales/lib/lead-resolution.ts) and the
PhoneBurner "never override a contact" rule.

---

## 6. Order → deal (live + backfill)

**Live.** Subscribe to `order.created` on the event bus. On a
`shopify_wholesale` order:
1. Resolve/create the Organization + Person (dedup first).
2. Create a **Won** Deal in the Customers pipeline, value = `total`,
   `won_time` / `add_time` = `placedAt`.
3. Stamp `pipedrive_deal_id` on the order; mark the company `customer`.
4. If the company had an open outreach deal, mark it **Won** too (its value
   stays 0 / excluded from revenue so we don't double-count — Customers pipeline
   is the revenue source of truth).

**Backfill.** One-time job iterating existing `orders` rows
(`channel = 'shopify_wholesale'`, non-cancelled): create one backdated Won deal
each via the same path. Pipedrive's API accepts `add_time` / `won_time`, so
historical revenue lands on the correct dates. Idempotent — skip orders already
carrying a `pipedrive_deal_id`.

**Faire:** Faire orders pipe through Shopify, so we rely on the Shopify order
webhook. **Verify** Faire orders arrive tagged wholesale (store channel or a
`wholesale`/`b2b` tag) so they classify as `shopify_wholesale` and aren't
dropped as DTC.

---

## 7. Two-way sync (Pipedrive → frame)

Pipedrive [webhooks](https://developers.pipedrive.com/docs/api/v1/Webhooks)
(HTTP basic auth) post deal changes to `/api/webhooks/pipedrive`. The handler
maps Pipedrive deal state back via
`progressCompanyStatus(..., { source: "pipedrive" })` — forward-only, and the
`source` tag stops an echo back out to Pipedrive:

| Pipedrive change | Frame effect |
|-----------------|--------------|
| Deal → **Catalog Sent** stage | `status = 'catalog_sent'` |
| Deal **Won** | `status = 'customer'`; `ensureCustomerAccount()` |
| Deal **Lost** | `status = 'not_interested'` (terminal; won't downgrade a customer) |
| Person/Org edits | Log to `activity_feed`; optionally backfill contact info |

A safety-net **poll cron** (like `phoneburner-call-poll`) reconciles missed
webhooks — idempotent on deal id.

---

## 8. Where automation runs (division of labor)

| Concern | Engine | Notes |
|---|---|---|
| Cold email sequences | **Instantly** (frame) | AJM "new brand" intro; cold prospecting |
| All calling cadences | **PhoneBurner** (frame) | Christina calls the AJM cohort, etc. |
| Interest detection | **Frame** | Instantly interest event / PB "Set Appointment" → status `interested` → **create Pipedrive deal** |
| Catalog send + follow-up nurture | **Instantly / PhoneBurner** (frame) | Frame advances the matching Pipedrive stage + creates rep tasks |
| Order capture | **Frame** | Shopify webhook → create/backdate Pipedrive order-deal |
| Reorder follow-up | **Frame reorder engine** | Drops Pipedrive activities on the customer Org |
| Deal board / pipeline view / rep tasks | **Pipedrive** | The qualified-deal workspace for the sales team |

Pipedrive never sends cold email or places calls — it shows the board and the
next action.

---

## 9. Architecture (mirrors Instantly / PhoneBurner)

New files under `src/modules/sales/lib/`:

| File | Responsibility |
|------|----------------|
| `pipedrive-client.ts` | API client: token (`env.PIPEDRIVE_API_KEY` → `settings.pipedrive_api_key`), rate limit, retry/backoff, auth probe. Base `https://{company}.pipedrive.com/api/v2`. |
| `pipedrive-sync.ts` | `createDealForInterested(companyId)`, `createDealForOrder(orderId)`, `backfillOrderDeals()`. Ensures Org → Person → Deal; dedups; stamps IDs. |
| `pipedrive-webhooks.ts` | Inbound deal-change handling → `progressCompanyStatus`. Self-registers with the dispatcher. |

Schema additions (`campaigns.ts` or a new `pipedrive.ts`):

```ts
// stamped Pipedrive IDs (on companies / orders as appropriate)
pipedriveOrgId:    text("pipedrive_org_id"),
pipedrivePersonId: text("pipedrive_person_id"),
pipedriveDealId:   text("pipedrive_deal_id"),
pipedrivePipeline: text("pipedrive_pipeline"),   // ajm | catalog_interested | customer

pipedrive_webhook_events  // audit log, idempotent on event hash
```

Hooks: subscribe to `order.created` (order-deal); extend `status-sync.ts` so the
forward edge into `interested` calls `createDealForInterested`.

Routes (existing conventions):
- `POST /api/admin/pipedrive/register-webhook` — mint secret, register webhook.
- `POST /api/admin/pipedrive/backfill-orders` — one-time historical backfill.
- `POST /api/v1/integrations/pipedrive/preview` — dry-run counts before pushing.
- `POST /api/webhooks/pipedrive` — inbound (add `pipedrive` to the `[provider]`
  dispatcher + side-effect import).

---

## 10. Scheduled jobs

Add to `CRON_JOBS` in
[`registry.ts`](../src/modules/integrations/lib/cron/registry.ts)
(per [docs/scheduled-jobs.md](./scheduled-jobs.md) — **no** new Railway service):

```ts
{
  id: "pipedrive-deal-poll",
  schedule: "*/30 * * * *",   // safety net for missed inbound webhooks
  description: "Poll recent Pipedrive deal changes; reconcile stage → frame status. Idempotent on deal id.",
  handler: () => pullPipedriveDealChanges({ sinceMinutes: 60 }),
},
{
  id: "pipedrive-order-deal-sweep",
  schedule: "15 * * * *",     // catch any wholesale order that missed the event hook
  description: "Create Pipedrive deals for wholesale orders lacking a pipedrive_deal_id.",
  handler: () => sweepUnsyncedOrderDeals(),
},
```

---

## 11. Open items / prerequisites

- [ ] **AJM spreadsheet** — file or Drive link. Confirms column mapping; unblocks
      bucket #1 (Phase 0).
- [ ] **Pipedrive API token + company subdomain.**
- [ ] **Three pipelines + their stage IDs** — you create them in Pipedrive (or
      confirm we create via API) and provide the pipeline/stage IDs.
- [ ] **Confirm Customers-pipeline shape** — recommended: revenue ledger of Won
      deals + reorder activities (§3). Alternative: Order Placed → Fulfilled →
      Delivered ops view. *(Was "not sure" on 2026-06-27.)*
- [ ] **Verify Faire-via-Shopify orders classify as wholesale** (§6).
- [ ] **Catalog-interest precision:** confirm both Instantly interest events and
      PB "Set Appointment" count as "wants a catalog," or whether a distinct
      catalog-request signal is needed.

### Resolved since last revision
- ~~B2B-vs-DTC flag for customers~~ → `channel = 'shopify_wholesale'` already on orders.
- ~~Sync direction~~ → two-way.
- ~~Where automation runs~~ → all in the frame; Pipedrive is the deal board only.
- ~~Order/deal double-count~~ → one deal per order; Customers pipeline is revenue truth.

---

## 12. Rollout phases

1. **Phase 0 — AJM into the frame.** Run the spreadsheet through
   `prep-ajm-import.py` → `/api/admin/sales/import-ajm`; verify counts. (No
   Pipedrive code.)
2. **Phase 1 — Client + schema + settings.** `pipedrive-client.ts`, ID columns,
   credential settings, auth probe. No writes yet.
3. **Phase 2 — Order-deals + backfill.** `order.created` hook + historical
   backfill into the Customers pipeline. Highest data volume, fully automatable.
4. **Phase 3 — Interested-deals.** Wire the `interested` forward edge to create
   AJM / Catalog-Interested deals; create rep follow-up tasks.
5. **Phase 4 — Two-way pull.** Inbound webhooks + reconcile poll
   (catalog-sent / won / lost → frame status).

---

## 13. Risks & notes

- **Don't leak the funnel into Pipedrive.** Event-driven gates on *interested*
  and *wholesale order* are the safeguard; a dry-run preview guards bulk steps.
- **Echo loops.** Reuse the `source`-tag loop prevention from `status-sync.ts`.
- **Dedup across tools.** A lead may already exist in Pipedrive from manual
  entry — always dedup by domain/email/phone before create.
- **Revenue truth.** Report revenue from Customers-pipeline order-deals only;
  keep nurture-deal values at 0 to avoid double counting.
