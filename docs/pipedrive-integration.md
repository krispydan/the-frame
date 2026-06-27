# Pipedrive integration — spec & rollout plan

**Status:** Draft for review · **Owner:** CRM / Sales · **Last updated:** 2026-06-27

This document specifies how the-frame will sync high-potential leads into
[Pipedrive](https://www.pipedrive.com/). It is a **plan**, not yet an
implementation — see [Open items](#open-items--prerequisites) for what's
needed before code lands.

---

## 1. Goal & guiding principle

The frame holds *all* prospects. Pipedrive should hold **only** leads with a
strong potential of converting, so the sales team works a clean, qualified
list. We import exactly three buckets and nothing else:

| # | Bucket | Frame definition | Pipedrive pipeline |
|---|--------|------------------|--------------------|
| 1 | **AJ Morgan reactivation** | Previous AJM wholesale customers (`source = 'ajm_2025_import'`) | *AJM Reactivation* |
| 2 | **Catalog-interested** | Leads who said they want a catalog via Instantly or PhoneBurner (`status = 'interested'`, reached *through outreach*) | *Catalog Interested* |
| 3 | **Customers** | **B2B wholesale** accounts who have purchased from us or came inbound (≥1 real order) | *Customers* |

**Decisions locked in (2026-06-27):**
- **Type #3 scope:** B2B wholesale accounts only. DTC / individual Shopify
  consumers are **excluded** — Pipedrive stays a B2B sales tool.
- **Layout:** three separate Pipedrive pipelines (above).
- **Sync direction:** two-way (push qualified leads out; pull deal/stage
  changes back into the frame).

The frame remains the **system of record** for the full prospect universe;
Pipedrive is the working surface for qualified deals.

---

## 2. How this maps to what already exists

Most of the spine is already built. Pipedrive is a **third fan-out target**
alongside Instantly and PhoneBurner, not new plumbing.

- **One lead table.** All leads live in `companies`
  ([`src/modules/sales/schema/index.ts`](../src/modules/sales/schema/index.ts))
  with a forward-only `status` pipeline:
  `prospect → qualified_lead → interested → catalog_sent → customer`
  (plus terminals `not_qualified / not_interested / ghosted / revisit_later`).
  Progression rules live in
  [`status-progression.ts`](../src/modules/sales/lib/status-progression.ts).
- **Outreach already writes back status.** Instantly's `lead_interested`
  webhook and PhoneBurner's "Set Appointment" disposition both flip a company
  to `status = 'interested'` and fire the #sales-leads Slack alert. That
  forward edge into `interested` is the precise *"now, and not before"*
  trigger described for bucket #2.
- **Fan-out layer exists.** When a company's status changes,
  [`status-sync.ts`](../src/modules/sales/lib/status-sync.ts) mirrors it to
  Instantly and PhoneBurner (with loop prevention via a `source` tag).
  Pipedrive slots in here.
- **AJM import already exists.** [`ajm-import.ts`](../src/modules/sales/lib/ajm-import.ts),
  the `/api/admin/sales/import-ajm` endpoint, the `ajm_*` columns on
  `companies`, and `scripts/prep-ajm-import.py` already turn an AJM
  spreadsheet into frame rows. Bucket #1's prerequisite ("get them into the
  frame") is mostly a matter of *running* this with the real spreadsheet.
- **"Customer" is behavioral.** A customer = a company with ≥1 real
  (non-cancelled) order, per
  [`customer-sync.ts`](../src/modules/sales/lib/storeleads/customer-sync.ts)
  and `customer_accounts`
  ([`src/modules/customers/schema/index.ts`](../src/modules/customers/schema/index.ts)).

---

## 3. Pipedrive entity mapping

| Frame entity | Pipedrive entity | Notes |
|--------------|------------------|-------|
| `companies` row | **Organization** | Name, domain, address, ICP tier as a custom field |
| `contacts` row | **Person** | Linked to the Organization; email + phone |
| Qualified lead | **Deal** | Created in the pipeline for its bucket, at stage 1 |

We do **not** use Pipedrive "Leads" (the inbox-style pre-deal object); each
qualified bucket goes straight to a **Deal** in the appropriate pipeline, since
by definition these are already qualified.

Custom fields written on the Organization/Deal for context (mirrors what we
already send to Instantly/PhoneBurner): `frame_company_id`, `icp_tier`,
`icp_score`, `industry`, `estimated_yearly_sales`, `lead_bucket`
(`ajm` | `catalog_interested` | `customer`), and `frame_status`.

---

## 4. Selection logic — who goes to Pipedrive

A lead is eligible only if it falls in one of the three buckets **and** has the
minimum data to be workable (a contact email or phone). Mirror the existing
"skip if missing required field" guards from the Instantly/PhoneBurner push.

```
Bucket 1 — AJM Reactivation:
  companies.source = 'ajm_2025_import'
  (status is typically 'customer' or 'qualified_lead' from the import)

Bucket 2 — Catalog Interested:
  companies.status IN ('interested', 'catalog_sent')
  AND reached that status via outreach (interest event from Instantly/PhoneBurner)
  → pushed on the forward edge into 'interested' (event-driven, not bulk)

Bucket 3 — Customers (B2B wholesale only):
  EXISTS (≥1 real order)            -- non-cancelled/returned, per customer-sync rules
  AND company is wholesale/B2B      -- EXCLUDE DTC consumers (see §Open items: how to flag)
```

**Dedup:** never create a duplicate. Before creating an Organization/Person,
look up by `pipedrive_org_id`/`pipedrive_person_id` (if already stamped), then
by domain/email, then by phone — same cascade philosophy as
[`lead-resolution.ts`](../src/modules/sales/lib/lead-resolution.ts) and the
PhoneBurner "never override a contact" rule.

---

## 5. Architecture (mirrors Instantly / PhoneBurner)

New files under `src/modules/sales/lib/`:

| File | Responsibility |
|------|----------------|
| `pipedrive-client.ts` | API client: token resolution (`env.PIPEDRIVE_API_KEY` → `settings.pipedrive_api_key`), rate limiting, retry/backoff, auth probe. Pipedrive API base `https://{company}.pipedrive.com/api/v2`. |
| `pipedrive-sync.ts` | Push engine: `pushLeadToPipedrive(companyId, bucket)` (event-driven) + `bulkPushBucket(bucket)` (backfill). Ensures org → person → deal; dedups; stamps IDs back. |
| `pipedrive-webhooks.ts` | Pull: handle `deal.change` / `deal.updated` events → progress frame status (e.g. deal won → `customer`). Self-registers with the generic dispatcher. |

Schema additions
([`src/modules/sales/schema/campaigns.ts`](../src/modules/sales/schema/campaigns.ts)
or a new `pipedrive.ts`):

```ts
// On companies (or a side table): the stamped Pipedrive IDs
pipedriveOrgId:    text("pipedrive_org_id"),
pipedrivePersonId: text("pipedrive_person_id"),
pipedriveDealId:   text("pipedrive_deal_id"),
pipedrivePipeline: text("pipedrive_pipeline"),  // which of the 3 buckets

// Audit log — one row per inbound webhook, idempotent on event hash
pipedrive_webhook_events  // mirrors instantly_webhook_events / phoneburner_webhook_events
```

Routes (mirror existing conventions):
- `POST /api/admin/pipedrive/register-webhook` — mint secret, register webhook(s).
- `POST /api/v1/integrations/pipedrive/push` — manual/bulk push a bucket `{ bucket, dryRun? }`.
- `POST /api/v1/integrations/pipedrive/preview` — dry-run counts before pushing.
- `POST /api/webhooks/pipedrive` — inbound (add `pipedrive` to the
  [`[provider]` dispatcher](../src/app/api/webhooks/) + side-effect import).

---

## 6. Push flow (frame → Pipedrive)

**Bucket #2 (catalog-interested) is event-driven** — the highest-value path.
Hook into the existing forward edge into `interested` in
[`status-sync.ts`](../src/modules/sales/lib/status-sync.ts), right where the
Slack alert fires today. When a company first reaches `interested`:

1. Resolve/create the Organization + primary Person in Pipedrive (dedup first).
2. Create a Deal in the **Catalog Interested** pipeline at stage 1.
3. Stamp `pipedrive_org_id / person_id / deal_id` back on the company.

This guarantees the *"import when they say they're interested, and not before"*
requirement — nothing earlier in the funnel ever reaches Pipedrive.

**Buckets #1 (AJM) and #3 (customers) are bulk + incremental:**
- One-time backfill via `bulkPushBucket('ajm')` / `bulkPushBucket('customer')`.
- A cron job keeps them current (new AJM rows, newly-promoted customers).

---

## 7. Pull flow (Pipedrive → frame) — two-way

Pipedrive [webhooks v2](https://developers.pipedrive.com/docs/api/v1/Webhooks)
(HTTP basic auth) post deal changes to `/api/webhooks/pipedrive`. Handler
maps Pipedrive deal state back to frame `status` via
`progressCompanyStatus(..., { source: "pipedrive" })` (forward-only; the
`source` tag prevents an echo back out to Pipedrive):

| Pipedrive event | Frame effect |
|-----------------|--------------|
| Deal **won** | `status = 'customer'` (terminal); `ensureCustomerAccount()` |
| Deal moved to "catalog sent" stage | `status = 'catalog_sent'` |
| Deal **lost** | `status = 'not_interested'` (sibling terminal; no downgrade of customers) |
| Person/Org field edits | Log to `activity_feed`; optionally backfill contact info |

A safety-net **poll cron** (like `phoneburner-call-poll`) reconciles anything a
missed webhook dropped — idempotent on deal id.

---

## 8. Scheduled jobs

Add to `CRON_JOBS` in
[`src/modules/integrations/lib/cron/registry.ts`](../src/modules/integrations/lib/cron/registry.ts)
(per [docs/scheduled-jobs.md](./scheduled-jobs.md) — **no** new Railway cron service):

```ts
{
  id: "pipedrive-bulk-sync",
  schedule: "0 * * * *",            // hourly (UTC)
  description: "Incremental push of new AJM + customer leads to Pipedrive, and reconcile deal stages back.",
  handler: () => runPipedriveSync(),
},
{
  id: "pipedrive-deal-poll",
  schedule: "*/30 * * * *",         // safety net for missed webhooks
  description: "Poll recent Pipedrive deal changes; idempotent on deal id.",
  handler: () => pullPipedriveDealChanges({ sinceMinutes: 60 }),
},
```

---

## 9. Credentials & settings

Same pattern as the other integrations (env wins, settings fallback, no redeploy
to rotate):

| Key | Where | Purpose |
|-----|-------|---------|
| `pipedrive_api_key` | `settings` / `env.PIPEDRIVE_API_KEY` | API token |
| `pipedrive_company_domain` | `settings` | `{company}.pipedrive.com` subdomain |
| `pipedrive_webhook_user` / `pipedrive_webhook_pass` | `settings` | Webhook basic-auth |
| `pipedrive_pipeline_ids` | `settings` (JSON) | Map bucket → pipeline & stage IDs |

---

## 10. Rollout phases

1. **Phase 0 — AJM into the frame.** Get the AJM spreadsheet, run it through
   `prep-ajm-import.py` → `/api/admin/sales/import-ajm`. Verify counts. *(No
   Pipedrive code needed; unblocks bucket #1.)*
2. **Phase 1 — Client + schema + settings.** `pipedrive-client.ts`, ID columns,
   credential settings UI, auth probe. No pushing yet.
3. **Phase 2 — Event-driven bucket #2.** Wire the `interested` forward edge to
   create a Pipedrive deal. Highest value, lowest volume — safest to ship first.
4. **Phase 3 — Bulk buckets #1 & #3.** `bulkPushBucket` + cron incremental sync.
   Requires the B2B-wholesale flag for #3 (see open items).
5. **Phase 4 — Two-way pull.** Webhooks + reconcile poll; deal-won → customer.

---

## 11. Open items / prerequisites

Needed before / during build:

- [ ] **AJM spreadsheet** — the file (or Drive link). Confirms column mapping and
      unblocks Phase 0.
- [ ] **Pipedrive API token + company subdomain.**
- [ ] **Three pipelines created in Pipedrive** (or confirm we create them via API)
      and their pipeline + stage IDs.
- [ ] **How to flag "B2B wholesale" vs DTC** for bucket #3. Options: a
      company `type`/`tag`, "wholesale" channel on orders, or order size
      threshold. **This is the one selection rule not yet expressible from
      existing data** — needs a definition before bucket #3 can ship.
- [ ] **Catalog-interested precision:** today `status = 'interested'` is set by
      both Instantly interest events and PhoneBurner "Set Appointment". Confirm
      both count as "wants a catalog," or whether we need a distinct
      catalog-request signal.

---

## 12. Risks & notes

- **Don't leak the whole funnel into Pipedrive.** The event-driven gate on
  `interested` is the safeguard; bulk pushes must apply the bucket filters
  strictly. A dry-run/preview endpoint guards against accidental mass-push.
- **Echo loops.** Reuse the `source`-tag loop prevention from `status-sync.ts`
  so a Pipedrive-originated change isn't synced straight back to Pipedrive.
- **Dedup across tools.** A lead may already be a Person in Pipedrive from a
  prior manual entry — always dedup by domain/email/phone before create.
- **DTC volume.** Excluding DTC is a deliberate scope decision; revisit only if
  the team wants consumer nurture in Pipedrive later.
