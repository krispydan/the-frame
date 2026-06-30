# Jaxy Eyewear — CRM Master Plan, Architecture & Action Plan

**Status:** v4 — approved-ready (review rounds 1–3 applied) · **Owner:** Daniel (CRM lead) · **Last updated:** 2026-06-27

Single source of truth for how Jaxy Eyewear runs its CRM: the operating model
(people + process), the system architecture (the frame + Pipedrive + Instantly +
PhoneBurner + Shopify), and the phased action plan to build it. Pipedrive
engineering detail lives in
[`pipedrive-integration.md`](./pipedrive-integration.md) (technical appendix —
this master plan supersedes it on any conflict).

> Two reading aids:
> - **Open prerequisites** are consolidated in [§13](#13-open-prerequisites).
> - **What must be newly built** (vs. reused) is itemised in
>   [§9.1](#91-what-already-exists-vs-what-must-be-built). The plan reuses a lot,
>   but three things earlier drafts assumed "already exist" actually require code.

### Locked decisions (the keystones everything else assumes)

1. **Pipedrive is the system of record for opportunities (deals + stage).** The
   frame's internal `deals` table is demoted to a read-only projection (§4.1).
2. **Revenue truth = the frame `orders` table** (net of refunds), never the sum
   of Pipedrive deals (§7).
3. **Account `customer` status is set only by a real wholesale order**
   (`order.created`) — never by a Pipedrive deal moving to Won (§5).
4. **Leads enter Pipedrive only on interest or a wholesale order** — never during
   cold outreach. All outreach automation stays in the frame.
5. **Three pipelines:** AJM Reactivation, Catalog Interested, Customers; B2B
   wholesale only; two-way sync.

---

## 0. TL;DR

- **The frame is the system of record and the engine.** Every prospect; all
  outreach automation (Instantly email, PhoneBurner calling); authoritative for
  identity, account status, and **revenue** (`orders`).
- **Pipedrive is the qualified-deal board and the SoR for opportunities.** Leads
  enter only on interest or a wholesale order. The frame keeps a *projection* of
  deals for in-app reporting (§4.1).
- **Account lifecycle (sticky) ≠ opportunities (recurring).** A customer can get
  new opportunities (reorder, upsell, reactivation) with no status change — how
  AJM reactivation is expressible (§3.1).
- **Every wholesale order becomes a Won deal**, backdated. **If the org has an
  open (non-closed) deal, the order is reported under that deal** (it wins it)
  instead of spawning a standalone deal; otherwise a new Won deal is created in
  Customers. History is backfilled; refunds/cancellations reconciled (§9.1).
- **Build = five phases.** Phase 0 (AJM import) and Phase 1 (foundations) can
  start first; Phase 2 depends on Phase 1.

---

## 1. Vision & operating principles

**Goal:** a clean, trustworthy commercial pipeline where the sales team spends
time only on leads with real potential, and where every order — wholesale or
reactivated — is captured, attributed, and followed up.

**Principles**

1. **One system of record per fact.** Frame: prospects, contacts, identity,
   account status, revenue (`orders`). Pipedrive: opportunities (deals) + stage.
   Each is authoritative for its own fact; everything else mirrors.
2. **Qualified-only CRM.** Nothing enters Pipedrive until it earns a place
   (interest or an order). Manually-created Pipedrive records reconcile back into
   the frame (§8.4).
3. **Automate the engine, not the judgement.** Cadences are automated; the call
   that a lead is genuinely "interested" stays human.
4. **Lifecycle ≠ engagement.** Account status (`prospect → customer`) is sticky
   and forward-only; *opportunities* (deals) recur and can re-open.
   Reactivation/upsell is a new opportunity, not a backward step (§3.1).
5. **No double truth.** Revenue = frame `orders`; account status = frame
   `companies`; deal stage = Pipedrive. The internal `deals` table is a
   read-projection of Pipedrive, not a second writer (§4.1).
6. **Build on what exists — but verify it.** Pipedrive is a third fan-out target
   beside Instantly and PhoneBurner. Most machinery is reusable; the exceptions
   are itemised in §9.1 so they don't masquerade as free.

---

## 2. System landscape

| System | Role | Authoritative for |
|--------|------|-------------------|
| **The Frame** | System of record + automation engine | Prospects, contacts, account status, identity, **revenue (`orders`)**, cron |
| **Instantly** | Cold + nurture **email** | Email sends/opens/replies/interest events |
| **PhoneBurner** | **Calling** | Dials, dispositions, call logs |
| **Shopify** (+ **Faire**) | Commerce | Orders, fulfilment, refunds; Faire pipes through Shopify |
| **Pipedrive** | **Qualified-deal board** | **Opportunities (deals) + stage** |
| StoreLeads / MillionVerifier | Enrichment / verification | Firmographics, deliverability |
| Slack | Notifications | #sales-leads alerts, digests |
| Xero | Finance | Accounting (out of scope) |

### Architecture (data flow)

```
        ┌──────────────────────────── THE FRAME (system of record) ──────────────────────────────┐
        │  companies · contacts · orders · deals(read-only projection) · campaign_leads · status   │
        └───┬───────────────┬────────────────────┬───────────────────────┬────────────────────────┘
            │ push leads     │ push leads          │ order/refund webhooks  │ create/sync deals (2-way)
            ▼                ▼                     ▲ (own Shopify route)     ▼  Pipedrive = deal writer
       ┌─────────┐      ┌────────────┐      ┌────────────┐           ┌────────────┐
       │Instantly│      │PhoneBurner │      │  Shopify   │           │ Pipedrive  │
       │ (email) │      │ (calling)  │      │ (+ Faire)  │           │(deal board)│
       └────┬────┘      └─────┬──────┘      └────────────┘           └─────┬──────┘
            │ interest/reply   │ disposition                                │ stage/deal changes
            └──────────────────┴───────────► status → interested ──────────┘
                                             (creates Pipedrive deal)
        Manual / off-channel leads (trade show, referral, inbound email)
            └────────► frame quick-add ──► fan-out to Pipedrive (§8.4)
```

---

## 3. The lead lifecycle (end-to-end)

| Phase | Frame account status | Where it happens | Enters Pipedrive? |
|-------|----------------------|------------------|-------------------|
| Sourced / imported | `prospect` | Frame (StoreLeads, CSV, AJM, chrome-ext, **manual**) | No |
| ICP-scored | `prospect` / `not_qualified` | Frame (LLM classifier) | No |
| Pushed to outreach | `qualified_lead` | Frame → Instantly / PhoneBurner | No |
| **Shows interest** | `interested` | Instantly event / PB disposition / manual | **Yes → outreach pipeline** |
| Catalog sent | `catalog_sent` | Frame (Instantly catalog-send event) | Stage update |
| Following up | `catalog_sent` | Frame (Instantly / PhoneBurner) | Stage = Following Up |
| **Orders** | `customer` | Shopify (+ Faire) | **Yes → Customers pipeline** |
| Negative | `not_interested` / `ghosted` / `revisit_later` | Instantly / PB | Lost (mapped by reason) |

### 3.1 Lifecycle vs opportunities — and the honest re-qualification story

`companies.status` is **forward-only** and records the furthest lifecycle stage
reached (`status-progression.ts`: ranks `prospect`=0 … `customer`=5; terminals
`not_interested`/`ghosted`/`revisit_later` all rank 4). **Opportunities are
modelled as deals in Pipedrive**, many over a company's life. Three cases, with
different implementation costs:

- **Reactivation / upsell of an existing `customer` — works with no status
  change (reuse).** AJM matched buyers and all existing customers are already
  `customer`. New campaign interest → **a new Pipedrive deal**; account stays
  `customer`. The forward-only gate is irrelevant. ✅ Implementable today.
- **Re-engaging a dead *non-customer* lead — requires NEW code.** A `ghosted` /
  `not_interested` lead (rank 4) who replies **cannot** move to `interested`
  (rank 2) — it is a strict forward gate with **no existing re-qualification
  path** (verified). We must build `reQualify()` (⚠️ build item, §9.1; spec in
  §3.1.1).
- **Net-new interest** — normal forward `qualified_lead → interested`.

**Idempotency — one open outreach deal per (company, pipeline).** Repeat interest
signals (a reply *and* a "Set Appointment") update the existing open deal in that
pipeline; they never create a second. Because **Pipedrive is the opportunity
SoR**, the key is checked against Pipedrive before create: an open deal on the Org
(`frame_company_id`) in that pipeline. The frame projection mirrors the result.
(Different pipelines may legitimately hold concurrent deals for the same company.)

#### 3.1.1 `reQualify()` spec (build item)

- **Signature:** `reQualify(companyId, reason, actor)` — performs the single
  sanctioned transition `terminal-4 → interested`, writing an audit row.
- **Authorization:** Daniel (or a rep with explicit permission) via a UI button
  on the prospect — not an automated path, to prevent laundering ghosted leads
  back into the funnel. Rate-guarded (one re-qualify per company per N days).
- **Effect:** flips status to `interested`, opens a **new** Pipedrive deal
  (prior Lost deal stays Lost for history), and re-enrolls in the appropriate
  nurture sequence. The prior terminal reason is preserved in the audit row.

### 3.2 The three import buckets

| # | Bucket | Definition | Pipeline | Gate |
|---|--------|-----------|----------|------|
| 1 | AJM reactivation | Curated AJM subset, tagged `ajm_pipedrive_push` (~1,173) | AJM Reactivation | **Seeded directly** (deliberate) |
| 2 | Catalog-interested | Cold non-AJM leads who want a catalog | Catalog Interested | Interest |
| 3 | Customers | B2B wholesale buyers (`channel = 'shopify_wholesale'`) | Customers | Order |

**AJM: full cohort in the frame, curated subset to Pipedrive.** The frame
imports *all* AJM contacts (`source = 'ajm_2025_import'`, ~13.6k) as the system of
record. Only the curated subset tagged `ajm_pipedrive_push` (~1,173) is **seeded
directly** into the AJM Reactivation pipeline (assigned to Christina) — this is
the one deliberate, non-interest-gated entry into Pipedrive, because importing
them *is* the decision to work them. The untagged remainder stays frame-only and
reaches Pipedrive only if it later shows interest via Instantly/PhoneBurner
(the normal Bucket-2-style gate). See [`ajm-import-plan.md`](./ajm-import-plan.md).

**AJM has two sub-cohorts** (verified in `ajm-import.ts`): rows with a verified
Jaxy match import as `customer`; unmatched rows import as `qualified_lead`. The
`customer` sub-cohort reactivates via the no-status-change path. The
`qualified_lead` sub-cohort behaves like a cold lead — and if it ends `ghosted`
then later responds, it needs `reQualify` (§3.1.1).

### 3.3 Backfill: existing interested leads (Instantly + PhoneBurner) → Pipedrive

**Work item (requested 2026-06-27):** push the *current* backlog of interested
leads into Pipedrive — not just go-forward. Today the frame already flips a
company to `status = 'interested'` from Instantly `lead_interested` events and
PhoneBurner "Set Appointment" dispositions; many such companies predate the
Pipedrive integration and have no deal yet. One-time backfill:

- **Selection:** `companies.status IN ('interested','catalog_sent')`. Channel
  attribution (Instantly vs PhoneBurner) comes from `campaign_leads`
  (`instantly_lead_id` vs `phoneburner_contact_id`).
- **Routing — and the AJM overlap (flagged by Daniel):** *some interested
  Instantly leads are also on the AJM list.* An interested company that is an AJM
  contact (`source = 'ajm_2025_import'` / `ajm_2025` tag) must **not** spawn a
  second org/deal. Resolve by `frame_company_id` first (the standard Pipedrive
  dedup): if it already has an AJM Reactivation deal (from the §3.2 seed),
  **advance that deal to Interested** rather than creating a Catalog-Interested
  one. Non-AJM interested leads → **Catalog Interested** pipeline.
  **Decision (locked 2026-06-27): an AJM contact that shows interest stays in AJM
  Reactivation** regardless of channel — keeps the cohort together; its existing
  deal advances to Interested.
- **Dedup is identity-based, not channel-based:** the same physical lead can be
  interested via *both* email and a call; one company → one open outreach deal
  (§3.1 idempotency key).
- Owner = Christina; this is part of Phase 3/4 (the two-way Pipedrive sync), and
  reuses the same push path as the go-forward interest edge.

---

## 4. Data model & identity

**Core tables (frame):** `companies` (account/lead), `contacts` (people),
`orders` + `order_items` + `returns`, `deals` (**read-only projection of
Pipedrive** — §4.1), `campaign_leads` (outreach tracking), `customer_accounts`
(LTV/tier/health).

**Account status (forward-only):**
`prospect → qualified_lead → interested → catalog_sent → customer` + terminals.
Logic in [`status-progression.ts`](../src/modules/sales/lib/status-progression.ts).

**Status lives on the company; signals come from contacts.** One account-level
status; per-person engagement on `contacts` / `campaign_leads`. When a buyer
leaves and a new contact arrives, status persists and a new opportunity can open.
Inbound "Person removed/replaced" from Pipedrive → log + mark contact inactive;
never deletes history.

**Cross-system identity.** Each record carries the external IDs it earns:
`instantly_lead_id`, `phoneburner_contact_id`, and (new) `pipedrive_org_id` /
`pipedrive_person_id` (on companies), `pipedrive_deal_id` (on orders + the deals
projection). Pipedrive deals carry custom fields `frame_order_id` (order-deals)
and `frame_company_id` (outreach deals) for independent dedup. Inbound resolution
cascade ([`lead-resolution.ts`](../src/modules/sales/lib/lead-resolution.ts)):
stamped ID → custom field → domain/email → phone.

**Dedup law:** resolve before create; never create a duplicate; never overwrite a
record we didn't create.

### 4.1 The internal `deals` kanban vs. Pipedrive deals (locked decision)

Today the frame **auto-creates and auto-advances an internal `deals` row** for
every company reaching `interested`+ via `syncDealStage`
(`status-progression.ts`), and its stage enum
(`interested → catalog_sent → order_placed → …` in `pipeline.ts`) mirrors the
statuses we want in Pipedrive. Left as-is, every opportunity has **three**
representations with **two independent writers** — guaranteed drift.

**Decision (locked — keystone #1):** Pipedrive is the SoR for opportunities; the
internal `deals` table is **demoted to a read-only projection** synced *from*
Pipedrive:

- **Retire the auto-writer.** `syncDealStage` no longer creates/advances internal
  deals on status change; the Pipedrive pull (and create paths) upsert the
  projection. Removes the two-writer conflict.
- **Extend the projection schema:** add `pipeline`, `is_open` (boolean),
  `pipedrive_deal_id`. (The one-open-deal key needs `pipeline` + `is_open`, which
  `deals` lacks today; `syncDealStage` also assumes a single oldest deal per
  company — both must change.)
- **Multiple concurrent opportunities** per company become possible (needed for
  reactivation/upsell), keyed by `pipedrive_deal_id`.
- **Existing kanban UI** reads the projection (keeps working) or is retired in
  favour of the Pipedrive board — a product call (§13).

---

## 5. Pipedrive design

### Pipelines & stages

| Pipeline | Stages | Entry | Frame-status link |
|----------|--------|-------|-------------------|
| **AJM Reactivation** | Interested → Catalog Sent → Following Up → Won / Lost | Interest | interested / catalog_sent / catalog_sent / customer |
| **Catalog Interested** | Interested → Catalog Sent → Following Up → Won / Lost | Interest | same |
| **Customers** | Won-deal ledger + reorder activities | Order | customer |

"Following Up" has no distinct frame status — it is the post-catalog nurture
sub-state of `catalog_sent`. Intentional; documented so the mapping isn't read as
lossy.

### Entity mapping

| Frame | Pipedrive |
|-------|-----------|
| `companies` | Organization |
| `contacts` | Person |
| Interested lead | Deal (outreach pipeline, Interested stage, `frame_company_id` set) |
| Order | Deal (Customers pipeline, Won, backdated, `frame_order_id` set) |

### Deal & activity ownership

The integration sets `owner_id` to **Christina's Pipedrive user** on every
created deal/activity — *not* the API token's user. Forward note: a second rep →
round-robin or territory by `companies.state` (config, not a rewrite).

### Custom fields on Org/Deal
`frame_company_id`, `frame_order_id`, `backfill_run_id`, `icp_tier`, `icp_score`,
`industry`, `estimated_yearly_sales`, `lead_bucket`, `frame_status`, `dnc`.

### Two-way status mapping & conflict resolution

| Change | Effect |
|--------|--------|
| Frame → interested | create/refresh open outreach deal (per company+pipeline), owner = Christina |
| Frame → catalog_sent (Instantly catalog-send event) | move deal to Catalog Sent |
| Frame → customer (real order) | **win the org's open deal if one exists** (report the order under it); else create a Won order-deal in Customers |
| Pipedrive → Catalog Sent stage | advisory; **authoritative `catalog_sent` is the Instantly send event** |
| **Pipedrive outreach deal Won** | **advisory / velocity only — does NOT set `customer`.** `customer` is reached solely via a real wholesale order (keystone #3) |
| Pipedrive deal Lost | map by **lost_reason** → `not_interested` / `ghosted` / `revisit_later` (default `not_interested`) |
| Pipedrive Person removed | log; mark contact inactive |

**Conflict resolution:** *deal stage* on pull → **Pipedrive authoritative**;
*account status, identity, revenue* → **frame authoritative**. Loop prevention via
`source` tag (fan-out skips originator). Poll and webhook are idempotent; the
later observed Pipedrive state wins for stage.

---

## 6. Automation map

| Stage / event | Trigger | Action | Owner system |
|---------------|---------|--------|--------------|
| Cold email | `qualified_lead` | Enroll in Instantly sequence | Frame → Instantly |
| Cold call | `qualified_lead` | PhoneBurner call task | Frame → PhoneBurner |
| Interest detected | Instantly `lead_interested` / PB "Set Appointment" / manual | status → interested (or `reQualify` if terminal; no-change if customer); **create/refresh outreach deal**; Slack alert; task "send catalog" | Frame |
| Catalog sent | Instantly catalog-send event | status → catalog_sent; move Pipedrive stage; start follow-up sequence (day 3/7/14) | Frame → Instantly |
| Follow-up | No order after catalog | Recurring email + call cadence until order/Lost | Frame |
| Order placed | Shopify `order.created` → read order row for channel | **see §7** (wholesale → Won order-deal; account → customer; win open outreach deal for velocity) | Frame |
| Order changed/refunded/cancelled | **NEW** `order.updated` / `order.refunded` / `order.cancelled` events (§9.1) | adjust order-deal display value; refresh `customer_accounts` | Frame |
| Reorder due | `reorderDueAt` reached | Pipedrive activity "reorder — reach out"; optional win-back email | Frame reorder engine |
| Negative reply / DNC | Instantly/PB negative or unsubscribe | status → terminal; blocklist; deal Lost; **suppress Pipedrive activities for DNC contacts** | Frame |

---

## 7. Order → deal & revenue

- **Live:** `order.created` fires with `{orderId, companyId, total}` only — **it
  does not carry channel**, so `createDealForOrder(orderId)` re-reads the order
  row (`orders.channel` is indexed). If `shopify_wholesale`, resolve/create Org +
  Person, then **either attach to an open deal or create a new one**:
  - **If the org has an open (non-closed) deal** (any pipeline — typically the
    AJM/Catalog outreach deal): **win that deal with the order** — set it Won,
    value = order total, `won_time = placedAt`, stamp `frame_order_id` +
    `pipedrive_deal_id`. The order is reported *under* that deal; no standalone
    deal is created. (If multiple are open, pick the most recently active
    outreach deal.)
  - **Else:** create a new **Won** deal in the Customers pipeline, value = total,
    dated to `placedAt`, `frame_order_id` + `pipedrive_deal_id` set.
  Either way the order is represented by exactly **one** Won deal. Revenue is
  still counted once from `orders` (deal value is display-only — keystone #2), so
  attaching vs. creating never double-counts.
- **Refunds/cancellations need new events.** The Shopify handlers for
  `orders/updated`, `refunds/create`, `orders/cancelled` currently mutate the
  `orders` row but **emit nothing** — only `order.created` and `order.shipped`
  exist on the event bus. Add `order.updated` / `order.refunded` /
  `order.cancelled` (or hook handlers directly) — **build item §9.1.** Also:
  `handleRefundCreate` today sets `status='cancelled'` on *any* refund including
  partial, and doesn't persist the refunded amount — Phase 2 must fix this
  (persist net/refunded amount; mark `cancelled` only on a full refund).
- **Order-deal value is display-only.** Post-keystone-#2, the Pipedrive order-deal
  value is cosmetic for the rep's view; the **canonical net revenue lives on
  `orders`**. So refund adjustments to the deal value are nice-to-have, not
  revenue-critical.
- **Backfill:** one-time job over historical wholesale, non-cancelled `orders` →
  backdated Won deals. **Idempotent on the Pipedrive `frame_order_id` custom
  field** (query Pipedrive before create), so a crash between create and frame
  stamp can't duplicate. Every backfilled deal is tagged with a distinct
  `backfill_run_id` custom field so a run is cleanly reversible. Staging-first,
  dry-run preview, Daniel sign-off (§9.3).
- **Revenue source of truth = frame `orders`** (net of refunds, once the partial-
  refund fix lands), never the sum of pipeline deals — so no double counting even
  though an outreach Won deal and an order-deal co-exist.
- **Faire:** relies on Shopify; classification verified as a **Phase-2 blocking
  acceptance** (reconcile Faire order count/revenue vs Faire's dashboard).

---

## 8. CRM operations & management (people + process)

### 8.1 Roles

| Role | Person | Responsibilities |
|------|--------|------------------|
| CRM lead / owner | Daniel | Strategy, pipeline config, data governance, reporting, escalation owner, `reQualify` authority |
| Sales / outreach | Christina | Works AJM + Catalog pipelines; calls; sends catalogs; classifies interest; default deal owner |
| System (automated) | The frame | Sourcing, ICP scoring, sequencing, sync, order capture |

### 8.2 Continuity / coverage (bus-factor)

The judgement layer rests on Christina. Coverage:
- **Backup classifier/sender:** Daniel covers interest classification + catalog
  send when she's out.
- **SLA behavior:** SLAs pause for ≤1 day single-person absence; planned PTO →
  deals reassigned in advance.
- **Escalation owner:** Daniel for unacknowledged alerts > 1 business day or
  breached SLAs.
- Tracked as a top risk (§12) until a second rep exists.

### 8.3 Lead ownership & assignment

Single owner today (Christina), set as default `owner_id`. Growth → round-robin or
territory by `companies.state`, configured in Pipedrive.

### 8.4 Manual / off-channel leads

Trade-show, referral, direct inbound-email leads are first-class:
- **Intake = the frame** (quick-add lead form/endpoint) → fans out to Pipedrive
  like any other, preserving one-system-of-record.
- **Rep creates a deal directly in Pipedrive** → inbound webhook + reconcile poll
  create/link the matching frame company (origin `pipedrive_manual`); frame
  becomes the record. Identity resolves by email/domain/phone; on a miss a new
  frame company is created.

### 8.5 Cadences

- **Daily:** Christina works Interested + Following-Up tasks; clears #sales-leads
  alerts.
- **Weekly:** pipeline review — conversion by stage, aging deals, reorder list,
  **SLA-breach report**, **duplicate audit** (owner: Daniel; remediation: merge in
  Pipedrive + relink in frame).
- **Monthly:** cohort review (AJM reactivation, catalog→order), data-hygiene
  sweep, KPI vs target.

### 8.6 SLAs (measured, not aspirational)

| SLA | Target | Measured by |
|-----|--------|-------------|
| Interested → catalog sent | 1 business day | Pipedrive activity due-date + `pipedrive-sla-breach` cron |
| Catalog → first follow-up | 3 days (then 7/14) | Sequence timestamps |
| Reorder-due → contact | 2 business days | Activity due-date |
| #sales-leads alert ack | 1 business day | Slack/activity log |

"Business day" = Mon–Fri, US Pacific, excl. US holidays. Breaches surface in the
weekly review; repeated breaches escalate to Daniel.

### 8.7 Data governance, security & PII

- PII now lives in Pipedrive too. **Access:** least-privilege seats; admin =
  Daniel; rep = Christina.
- **DNC propagation:** a blocklisted/unsubscribed contact is flagged `dnc` on the
  Pipedrive Org/Deal and its activities suppressed — no calling a DNC contact on
  the board.
- **Retention:** lost/dormant deals retained for reporting; verified deletion
  requests handled in the frame and propagated out.
- Email verification (MillionVerifier) before any send.

### 8.8 Reporting & dashboards

- **Owner:** Daniel. **Where:** the frame dashboard (single compute surface).
  Pipedrive native reports only for the rep's day-to-day board. Stage-time
  metrics (velocity) are computed in the frame *from* synced stage-change
  timestamps, not read from Pipedrive reports.

### 8.9 KPIs (single source each) & targets

| KPI | Definition | Source | Initial target |
|-----|-----------|--------|----------------|
| Interest rate | interested / contacted | Frame | baseline, then ≥ baseline |
| Catalog→order rate | orders / catalogs sent | Frame | set after 1st cohort |
| AJM reactivation rate | reactivated AJM / AJM contacted | Frame | set after AJM cohort |
| Pipeline velocity | avg days Interested→Won | Frame (from synced stage timestamps) | trend down |
| Wholesale revenue | wholesale `orders` net of refunds | **Frame `orders`** | growth vs prior |
| Reorder rate | repeat orders / customers | Frame | trend up |
| Data quality | duplicate orgs; unlinked manual deals | Frame audit | 0 |

---

## 9. Technical architecture & build

New files under `src/modules/sales/lib/`: `pipedrive-client.ts`,
`pipedrive-sync.ts`, `pipedrive-webhooks.ts`.

Schema: company columns `pipedrive_org_id` / `person_id`; `pipedrive_deal_id` on
orders; `deals` projection gains `pipeline` / `is_open` / `pipedrive_deal_id`;
`pipedrive_webhook_events` audit table.

Routes: `/api/admin/pipedrive/register-webhook`,
`/api/admin/pipedrive/backfill-orders` (dry-run default),
`/api/v1/integrations/pipedrive/preview`, `/api/webhooks/pipedrive`.

Cron (central registry per [docs/scheduled-jobs.md](./scheduled-jobs.md)):
`pipedrive-deal-poll` (30 min), `pipedrive-order-deal-sweep` (hourly),
`pipedrive-sla-breach` (hourly, `guard: isDuringBusinessHours`).

Credentials via `settings` (env override): `pipedrive_api_key`,
`pipedrive_company_domain`, webhook basic-auth, pipeline/stage/owner ID map.

### 9.1 What already exists vs. what must be built

**Reused as-is (verified):** Shopify order ingestion + `orders.channel` wholesale
detection; `order.created` / `order.shipped` events; the generic
`/api/webhooks/[provider]` dispatcher + `webhookRegistry.register` pattern; the
cron registry shape (`{id, schedule, description, handler, guard?}`); the
identity-resolution cascade; `ensureCustomerAccount`; the AJM importer.

**Must be newly built (do not assume free):**
1. **`reQualify()`** — sanctioned `terminal-4 → interested` for dead non-customer
   leads; no such path today (§3.1.1).
2. **Order mutation events** — add `order.updated` / `order.refunded` /
   `order.cancelled` to the event-bus `EventMap` and emit from the existing
   handlers (or hook handlers directly). They don't exist today (§7).
3. **Partial-refund handling** — persist refunded/net amount; stop marking the
   whole order `cancelled` on a partial refund (§7).
4. **Fan-out extension** — add `"pipedrive"` to the `StatusChangeSource` union
   **and** to `progressCompanyStatus` opts (two places), add a Pipedrive branch in
   `fanOutStatusChange` (hardcoded — no registry today), plus
   `registerJobHandler("sales.sync_status_to_pipedrive", …)`.
5. **`deals` projection refactor** — demote `syncDealStage`, add columns, drop the
   single-deal-per-company assumption (§4.1).
6. **Webhook auth in-handler** — the `[provider]` dispatcher does **no** auth, so
   the Pipedrive handler verifies HTTP basic-auth itself.
7. **Pipedrive client/sync/webhook modules + schema + routes + cron** (the bulk).

### 9.2 Webhook routing note

Pipedrive (like Instantly/PhoneBurner) uses the generic
`/api/webhooks/[provider]` route — add `"pipedrive"` to `SUPPORTED_PROVIDERS` +
side-effect import + `webhookRegistry.register("pipedrive", …)`. **Shopify is
different** — its own dedicated route with HMAC. So the order-deal half rides
Shopify's separate infrastructure, not `[provider]`.

### 9.3 Testing, QA & rollback

- **Staging Pipedrive** (sandbox company) for all dev and the first backfill.
- **Backfill safety:** dry-run → counts reconciled vs `orders` → Daniel sign-off
  → staging run → verify → production. **Rollback = delete deals tagged with the
  run's `backfill_run_id`** (distinct from `frame_order_id`, so live-created deals
  are never touched).
- Unit/integration tests on the sync engine (mirror `sync-engines.test.ts`);
  idempotency tests for double-delivery and crash-between-create-and-stamp.

### 9.4 Data-migration validation (AJM)

Not just row counts: validate field mapping (spend/orders/last-order land
correctly), email deliverability (MillionVerifier), dedup vs existing companies
(no AJM row merges into the wrong company), and confirm the matched-vs-unmatched
sub-cohort split (§3.2). Hand-audit 20 rows.

---

## 10. Action plan / roadmap

| Phase | Deliverable | Depends on | Acceptance |
|-------|-------------|-----------|-----------|
| **0 — AJM import** | AJM cohort in the frame | AJM spreadsheet | Counts match; field mapping + dedup validated (§9.4); sub-cohort split confirmed; 20-row audit |
| **1 — Client + schema + foundations** | client, ID columns, `deals` projection refactor, fan-out extension, settings, auth probe, staging | API token + subdomain | Auth probe green on staging; settings save; fan-out accepts `pipedrive`; projection upserts |
| **2 — Order-deals + backfill** | Wholesale orders → deals; history backfilled; **order mutation events + partial-refund fix** | Phase 1; pipeline IDs | All wholesale orders have deals; revenue reconciles to `orders` net of refunds; Faire reconciled; rollback tested |
| **3 — Interested-deals + reQualify** | Interest edge → AJM/Catalog deals + owned tasks; `reQualify` for dead leads | Phase 1; pipeline IDs | New interested leads appear with owned tasks; one-deal-per-(company,pipeline) holds; a ghosted lead can be re-qualified |
| **4 — Two-way pull** | Inbound webhooks (basic-auth) + reconcile poll + SLA breach + manual-lead reconcile | Phases 2–3 | Pipedrive stage change updates frame; manual Pipedrive deal links a frame company |

Phase 0 (data import) and Phase 1 (foundations) can start first; Phase 2 depends
on Phase 1. **Training/change-management** before Phase 3 go-live: walk Christina
through the board, ownership, SLAs, manual intake.

---

## 11. Success criteria (definition of "done & healthy")

- AJM cohort imported and validated; reactivation deals flowing on interest.
- 100% of wholesale orders (incl. backfilled history) represented as deals;
  revenue reconciles to `orders` net of refunds within tolerance.
- 0 duplicate Organizations; 0 unlinked manual deals after reconcile.
- A dead lead can be re-qualified; an existing customer can get a new opportunity
  without a status regression; no Pipedrive-only "customer" exists without an
  order.
- SLAs measured weekly; breaches visible and owned.
- Christina runs her day from the Pipedrive board; Daniel runs reporting from the
  frame dashboard.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Single-person operating model (bus-factor) | Coverage/escalation plan (§8.2); top risk until 2nd rep |
| Funnel leaks into Pipedrive | Hard event gates + dry-run preview |
| Echo/sync loops | `source`-tag loop prevention (after fan-out extension) |
| Two deal writers (internal + Pipedrive) | Demote internal `deals` to projection (§4.1) |
| Pipedrive-only "customer" with no order | Won is advisory; `customer` only via `order.created` (keystone #3) |
| "Already exists" assumptions that don't | §9.1 itemises build items; no silent reuse |
| Duplicate records | Resolve-before-create; custom-field dedup; weekly audit |
| Revenue drift (refunds) | Revenue truth = `orders`; new mutation events + partial-refund fix |
| Faire mislabeled DTC | Phase-2 blocking reconciliation |
| Backfill pollutes prod | Staging-first + dry-run + sign-off + `backfill_run_id` rollback |
| Manual Pipedrive edits drift | Two-way pull + reconcile poll; frame wins identity |
| Noisy "interest" signal | Resolve signal precision pre-Phase-3; human confirm on ambiguity |
| PII in a 5th system | Least-privilege seats; DNC suppression; deletion via frame |

---

## 13. Open prerequisites

(The keystone architecture is locked — see "Locked decisions" at top. These are
the remaining inputs/confirmations needed to execute.)

- [ ] AJM spreadsheet (file/Drive link) — *blocks Phase 0*
- [ ] Pipedrive API token + company subdomain + **staging/sandbox** company —
      *blocks Phase 1*
- [ ] Three pipelines + stage IDs + **Christina's Pipedrive user/owner ID** —
      *blocks Phase 2/3*
- [ ] Confirm Customers-pipeline shape (ledger vs. fulfilment view)
- [ ] Verify Faire-via-Shopify orders classify as wholesale
- [ ] Define the precise "wants catalog" signal(s) + human-confirm rule
- [x] Overlap routing (§3.3): AJM contact that shows interest stays in AJM
      Reactivation (locked 2026-06-27)
- [ ] Confirm partial-refund handling approach (persist net amount)
- [ ] Confirm backup classifier (Daniel) + coverage policy
- [ ] Confirm Pipedrive plan/seat cost + API rate tier for backfill
- [ ] Product call: retire the internal kanban UI, or keep it reading the
      projection (§4.1)

---

## Appendix — glossary

- **AJM** — AJ Morgan, the prior brand whose wholesale customers we're reactivating.
- **The frame** — this Next.js app; the CRM system of record.
- **Bucket** — one of three qualified-lead categories that may enter Pipedrive.
- **Opportunity** — a deal; recurs over a company's lifetime (vs. sticky account status).
- **reQualify** — the (to-be-built) sanctioned move of a dead lead back to `interested` (§3.1.1).
- **Fan-out** — mirroring a status change from the frame to external systems.
- **DNC** — do-not-contact; blocklisted/unsubscribed.
