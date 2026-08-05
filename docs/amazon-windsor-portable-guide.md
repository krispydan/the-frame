# Amazon → Windsor → accounting: a portable build guide

Everything built for the Jaxy Amazon channel, written so it can be rebuilt in
another business's codebase. Hand this whole file to a Claude Code session in
the target repo.

It is deliberately opinionated about **why**, not just what. Most of the cost
of this build was not writing code — it was discovering five things that are
not obvious until they bite you. Those are marked ⚠️ and they are the reason
this document is worth reading rather than skimming.

---

## 0. What this system does

Amazon sells. Windsor AI mirrors Amazon's SP-API reports over a simple HTTP
API. This system pulls those reports on a schedule, keeps a raw archive,
derives orders and settlements from the archive, costs the orders against FIFO
inventory layers, posts settlements to Xero, and reports at month end.

```
Windsor AI ──► raw archive tables ──► derived orders / settlements
                     │                          │
                     │                          ├──► FIFO COGS
                     │                          ├──► Xero (invoice or journal)
                     │                          └──► dashboard + month-end checks
                     └──► never re-fetched; everything replays from here
```

The single most valuable structural decision: **the raw archive is the source
of truth, and every derivation replays from it.** When you fix a SKU mapping
or a fee classification six weeks later, you re-derive history without
re-fetching anything. This matters more than it sounds, because of ⚠️1.

---

## ⚠️ The five things that will bite you

### ⚠️1 — Amazon settlement reports have a 90-day retention window

Settlement data older than ~90 days is **gone**. Not slow, not paginated —
absent. If you do not archive raw rows as they arrive, you permanently lose
the ability to re-derive a fee mapping over history.

This is the single biggest architectural driver. It is why the archive exists
and why every derivation is a pure function of the archive.

**Action on day one:** stand up the raw archive tables and start the daily
pull *before* you build anything downstream. Backfill the full 90 days
immediately.

### ⚠️2 — Windsor returns `settlement_end_date` empty on every row

The obvious way to know a settlement is closed is its end date. Windsor sends
that column blank. If you key "is this settlement closed?" on it, every
settlement stays permanently open, and the bridge, the Xero posting and the
revenue recognition all silently do nothing — **with no error anywhere**.

Derive the period from `posted_date` MIN/MAX across the settlement's rows,
preferring header dates when they happen to be present.

```ts
// Period is derived, not read. `settlement_end_date` arrives empty on every
// row; keying on it left every settlement permanently "open" and silently
// blocked the whole downstream chain with nothing logged.
const periodStart = headerStart || minPostedDate;
const periodEnd   = headerEnd   || maxPostedDate;
```

### ⚠️3 — Deduplicate settlement rows by COUNT, not by existence

Amazon legitimately emits several economically identical rows for one order —
two equal promotions on one item, for instance. An `INSERT ... WHERE NOT
EXISTS` drops every duplicate after the first and **quietly understates the
settlement**, which then fails to tie to the bank deposit by an amount nobody
can find.

Group the incoming batch by identity, count what is already stored for that
identity, insert the difference:

```ts
// Deduplication is by COUNT per identity, not by existence. Amazon emits
// genuinely duplicate rows (two equal promotions on one item); an existence
// check drops every duplicate after the first and understates the settlement.
const toInsert = Math.max(0, groupRows.length - alreadyStored);
```

### ⚠️4 — Marketplace facilitator tax must be booked nowhere

Amazon collects sales tax and remits it. Two rows appear and cancel exactly:
`ItemPrice/Tax` positive and `ItemWithheldTax/MarketplaceFacilitatorTax-*`
negative. It is never your revenue and never your liability.

Booking either leg — or both to a tax account — creates a liability you do not
owe and a reconciliation that never closes. Classify both legs, then exclude
them from the journal. Assert the residual is zero as a test.

### ⚠️5 — Never let the invoice total be a residual

Under a settlement-date model the invoice total **must equal the bank
deposit**, because that is what makes the bank reconcile 1:1.

But some settlement lines are legitimately excluded (facilitator tax,
settlement-internal transfers, micro deposits). So the mapped revenue and fee
lines do *not* naturally sum to the deposit. If you compute the receivable as
"whatever is left over", any excluded amount is stranded in a holding account
forever — a cent at a time, invisibly.

Pin the receivable to the **actual net**, and emit an explicit plug line for
the difference:

```ts
// The receivable is pinned to the ACTUAL settlement net. If it were computed
// as the residual, any amount excluded from the journal — a micro deposit,
// an internal transfer — would strand that difference in Receivables Holding
// permanently.
const plug = round2(summary.net - mappedTotal);
if (plug !== 0) components.push({
  kind: plug < 0 ? "contra" : "revenue",
  amount: Math.abs(plug),
  accountCode: accounts.unclassified,
  description: `Settlement adjustment — ${settlementId}`,
});
```

---

## 1. Windsor client

Connector-agnostic on purpose — the same client serves TikTok Shop, Meta ad
spend, and anything else Windsor connects, which is where this goes next.

**Endpoint shape:** `https://connectors.windsor.ai/<connector>?api_key=…&fields=…&date_preset=…`
Amazon's connector slug is `amazon_sp`. Field names must carry a report
prefix (e.g. `amazon_sp_orders.…`).

```ts
export type WindsorErrorKind =
  | "auth" | "no_account" | "unknown_connector" | "bad_fields"
  | "date_range" | "timeout" | "no_data" | "http" | "parse";

export class WindsorError extends Error {
  constructor(
    message: string,
    readonly kind: WindsorErrorKind,
    readonly retryable: boolean,
  ) { super(message); }
}
```

### Secret redaction is not optional

The API key travels in the **query string**. Every error path — logs, Slack
alerts, DB error columns, HTTP responses — will happily echo the URL back at
you. Redact centrally, on the way out, so no call site can forget:

```ts
export function redact(text: string): string {
  const key = process.env.WINDSOR_API_KEY;
  let out = text;
  if (key && key.length > 0) out = out.split(key).join("***");
  return out.replace(/api_key=[^&\s"']+/gi, "api_key=***");
}
```

Apply `redact()` in the error constructor path, not at each `console.error`.

### `no_data` is a success, not a failure

Amazon **cancels** report requests for periods with no activity. Windsor
surfaces that as an error-shaped response. Treat `no_data` as an empty
success or the alerting will cry wolf every quiet weekend.

### Chunk long date ranges

Long ranges time out. Split into windows and merge:

```ts
export function chunkDateRange(from: string, to: string, days: number): Array<[string, string]>;
```

### Measured latencies (Amazon, real account)

Worth knowing before you set timeouts — the spread is enormous:

| Report | Latency |
|---|---|
| Orders by order date | 1.9 s |
| Settlements | 0.2 s |
| Sales & traffic | 0.2 s |
| FBA inventory | 0.5 s |
| Orders by last-update | 36.4 s |
| Returns | 50.1 s |
| Reimbursements | 73.5 s |
| Shipments | never returned |

Two consequences: set generous per-report timeouts, and **do not put a
multi-report backfill behind a single HTTP request** — a 300 s edge timeout
(Railway's, and most platforms') will kill it mid-run. Give the sync endpoint
date-range parameters so history can be pulled report-by-report.

---

## 2. Raw archive

Five tables. Nothing derived, nothing cleaned, raw JSON retained:

| Table | Holds |
|---|---|
| `amazon_order_rows` | one row per order-item, per report pull |
| `amazon_settlement_rows` | one row per settlement line |
| `amazon_sales_traffic_daily` | sessions, page views, buy-box %, conversion |
| `amazon_fba_inventory` | daily FBA stock snapshot |
| `amazon_sync_state` | per-report health: last success, failures, last error |

`amazon_sync_state` is what makes failures visible. Per report, track
`last_status`, `last_success_at`, `last_synced_through`,
`consecutive_failures`, `last_error`, `rows_ingested`.

```ts
// Alert after N consecutive failures, not on the first — transient upstream
// errors are normal and a channel that pages on every blip gets muted.
// Config errors (auth, unknown connector) alert immediately: those never
// self-heal and waiting three cycles just delays the fix.
const ALERT_AFTER_FAILURES = 3;
```

Also surface a `stale` flag: a run stuck in `running` for over 30 minutes is a
killed request, not a running one. Without this, a backfill killed by an edge
timeout leaves the sync permanently "in progress" and the next scheduled run
skips itself.

---

## 3. Order import — and the guards that matter

**Only import orders if fulfilment does not flow through this system.** In
Jaxy's case ShipHero fulfils Amazon directly; importing orders is for
reporting and COGS only, and pushing them anywhere would double-ship.

Prefix the identifiers so channel origin is never ambiguous:

```ts
export const AMAZON_ORDER_NUMBER_PREFIX = "AMZ-";
export const AMAZON_EXTERNAL_ID_PREFIX  = "amazon:";
```

### Guards — the actually important part

Every existing job that acts on orders must be taught to skip this channel.
Missing one of these is how a reporting-only import turns into a duplicate
shipment or a false alert. In this repo that was four places:

```sql
-- Every lookup that resolves an order for fulfilment or alerting
AND channel != 'amazon'
```

1. Activity-log order resolution (three separate lookups in one function)
2. The 3PL order sync
3. The stuck-order Slack scan
4. Sell-through calculation

**Verify structurally, don't just grep.** The strongest guarantee here was
confirming the codebase has *no order-create mutation at all* in either the
3PL or storefront clients — double-shipping is impossible by construction, not
by discipline. Check that in the target repo; if a create mutation does exist,
the guard list is longer and needs real care.

### Import rules that avoid data loss

- `company_id = NULL` — marketplace orders have no B2B customer.
- Pre-stamp `shipped_alert_sent_at` so historical imports don't fire a
  backlog of Slack alerts on first run.
- `COALESCE` `shipped_at` — never clear a timestamp you already have.
- **Do not rewrite line items once they carry COGS.** Re-costing a line
  silently changes closed-period margin.
- **Do** re-import when a previously-unresolved SKU *would now resolve* —
  that is the mapping-fix replay path, and it is the whole point of the
  archive.

---

## 4. Settlement classification

One pure function, `classifySettlementRow(row) → category`, keyed on
`(transactionType, amountType, amountDescription)`. Then
`summariseSettlement()` folds rows into per-category totals plus a net.

Validate against a real settlement and assert three things:

1. **Zero unclassified rows.** (Ours: all 288 real rows classified.)
2. **Facilitator tax residual is exactly zero.**
3. **The summary net reproduces the actual deposit to the cent.**

Anything unclassified must route to a **suspense account**, never be dropped.
A dropped line breaks the tie-out with no trace; a suspense line shows up on
the P&L and gets fixed.

Category → account mapping used here (create these in the chart of accounts):

| Category | Code | Type |
|---|---|---|
| Sales | 4010 | Revenue |
| Shipping income | 4060 | Revenue |
| Promotions / discounts | 4310 | Contra-revenue |
| Refunds | 4300 | Contra-revenue |
| Commission | 5410 | COGS/expense |
| FBA fulfilment fees | 5470 | COGS/expense |
| FBA storage fees | 5475 | COGS/expense |
| Subscription fee | 5480 | Expense |
| Inbound freight | 5010 | COGS |
| Outbound shipping | 5300 | COGS |
| Unclassified (suspense) | 5440 | Expense |
| Marketplace clearing | 1030 | Asset |

**Promotions are contra-revenue, not a reduction of the sales line.** Netting
them into sales hides the discount rate. In one real Jaxy settlement,
promotions ran at ~71% of gross — $1,650 of gross produced $20 of cash.
Netting would have made that invisible.

---

## 5. Xero posting — two models, pick one deliberately

**Deferred model:** recognise revenue at shipment, settle the receivable when
the payout lands. Manual journals. Correct under ASC 606.

**Invoice model (settlement-date):** one ACCREC invoice per settlement, dated
the settlement, totalling the deposit. Simpler, reconciles 1:1 with the bank.

Make it a setting (`payout_revenue_model = deferred | invoice`) and implement
both. Jaxy runs `invoice`.

Two hard constraints:

- **Xero forbids manual journals touching BANK accounts.** Route through a
  clearing account.
- **A net-negative settlement cannot be an invoice.** When Amazon charges the
  card instead of depositing, it needs a credit note. Refuse explicitly rather
  than posting something invalid:

```ts
if (summary.net < 0) {
  return fail(
    `Settlement is net negative (${summary.net}) — Amazon charged the card ` +
    `rather than depositing. That needs a credit note, not an invoice; ` +
    `record it manually against the clearing account.`,
  );
}
```

### Sign handling

Do the sign inversion **once**, at the boundary. Let `kind` (`revenue` |
`contra`) carry the sign downstream and keep every `amount` non-negative. A
category can legitimately flip sides — refund credits can exceed commission in
a quiet period — and if `kind` and a negative magnitude both encode sign you
get a double-negation that is very hard to spot.

```ts
// Side follows the sign; the magnitude is always positive. Both encoding
// sign would double-negate whenever a category flips.
const kind = total >= 0 ? "revenue" : "contra";
const amount = Math.abs(total);
```

### Rollout sequence — do not skip steps

```
dry run  →  status: "DRAFT", limit: 1  →  review in Xero  →  status: "POSTED"
```

Posting is hard to reverse: the correction path is a reversing journal, not a
delete.

---

## 6. Operator endpoints — the highest-leverage piece

This is the part most worth copying, and the part most likely to be skipped.

The app's real API sits behind login middleware, so it is unusable from
tooling — you cannot drive a backfill, check a sync, or diagnose a bad close
from a script or an agent session. Expose the **same libraries** through a
token-guarded door.

```
/api/admin/ops/*   ← exempt from session middleware, gates on x-ops-key
/api/v1/*          ← session-guarded, what the UI calls
```

**One implementation, two front doors.** Put the logic in a lib; both routes
call it. Never duplicate.

```ts
export function requireOpsToken(req, opts?: { mutation?: boolean }) {
  const expected = process.env.OPS_TOKEN;
  if (!expected) return json({ error: "OPS_TOKEN not configured" }, 503);

  const provided = req.headers.get("x-ops-key")
    ?? req.nextUrl.searchParams.get("ops_key") ?? "";
  // Constant-time — a plain === leaks the token a byte at a time.
  if (!provided || !safeEqual(provided, expected)) return json({ error: "Unauthorized" }, 401);

  // GET is read-only and needs only the token. POST mutates and additionally
  // needs ?confirm=1, so a write is always an explicit act.
  if (opts?.mutation && req.nextUrl.searchParams.get("confirm") !== "1") {
    return json({ error: "This is a mutation — re-send with ?confirm=1" }, 428);
  }
  return null;
}
```

### The safe-default rule

Anything that writes to an external system takes **explicit opt-out**, never
opt-in:

```ts
// Explicit opt-out only. Omitting dryRun must never post to Xero.
// The safe outcome has to be what happens when a parameter is forgotten.
const isDryRun = dryRun !== false;
```

Keep the token in the platform's env vars. Never print, commit, or paste it.

---

## 7. FIFO costing + the drift diagnostic

Cost layers (`inventory_cost_layers`) are created from received POs;
depletions (`inventory_cost_depletions`) are written when an order ships.
Reconcile FIFO's remaining units against physical stock (3PL on-hand + FBA).

⚠️ **A single drift number is not actionable.** "FIFO holds 20,666 units but
physical is 945" has at least three causes with opposite fixes. Build the
diagnostic that distinguishes them, or someone will spend a close chasing the
wrong one — which is exactly what happened here:

| Shape | Meaning | Fix |
|---|---|---|
| Drift on layers costing never touched | Opening balance — predates FIFO | One-off write-down, not a depletion run |
| Drift concentrated in a few SKUs | Real: sales went uncosted | Chase those SKUs' orders |
| **Physical side reads near-zero** | **A sync problem, not a costing problem** | **Fix the feed** |

That third row is the one that actually fired. Always report **raw feed
totals** next to mapped totals — a per-SKU view can only show stock that
joined to a catalog SKU, so "physical is zero" otherwise conflates *an empty
feed* with *a broken join*.

```ts
// The per-SKU view can only show stock it managed to join to a catalog SKU,
// so "physical is zero" there is ambiguous: the feed could be empty, or the
// feed could be full and the join broken. These are the raw numbers, which
// separate the two — the difference between chasing a costing bug and
// chasing a sync bug.
export type SourceReport = {
  shiphero: { rows: number; onHand: number; lastSyncedAt: string | null;
              unmappedOnHand: number; unmappedExamples: string[] };
  mappedWarehouse: number;
  fba: { rows: number; totalQty: number; snapshotDate: string | null;
         unmatchedQty: number; unmatchedExamples: string[] };
};
```

### $0 transfer orders

Transferring stock to FBA via a $0 3PL order should generate **no COGS** — the
goods have not been sold. Verify the transfer never reaches your `orders`
table. Here the 3PL sync only ever *updates* orders and never inserts, so it
cannot; confirm the equivalent in the target repo.

Do flag suspiciously large $0 orders, but **flag without blocking** — genuine
$0 orders exist (influencer gifting, warranty replacements) and their cost
*should* be recognised. An earlier version refused to cost them and broke
seven valid cases.

---

## 8. SKU spelling — resolve through one shared definition

Catalog spells it `JX3004-S-BLK`. The 3PL reports `JX3004-BLK`. Amazon reports
`JX3004-BLK-FBA`. Use an alias table (`catalog_sku_aliases`) and make
**every** consumer resolve through it — importer, inventory sync, and all
diagnostics.

⚠️ We got this wrong twice in one session, in both directions:

- The inventory sync matched exactly and ignored aliases.
- The diagnostics *also* ignored aliases, and so reported 867 FBA units as
  unmatched while the order importer was resolving every one of them —
  a diagnostic contradicting the code it exists to explain.

Define the resolution once and share it:

```sql
WITH sku_map AS (
  SELECT sku AS spelling, id AS sku_id FROM catalog_skus WHERE sku IS NOT NULL AND sku != ''
  UNION                      -- UNION, not UNION ALL: an alias duplicating a
  SELECT alias, sku_id FROM catalog_sku_aliases   -- real SKU must not double-count
)
```

Two rules when proposing aliases automatically:

- **Only ever drop segments, never invent them.** Dropping can merge two
  catalog SKUs onto one spelling (detectable); inventing can conjure a product
  that does not exist (not detectable).
- **Refuse to guess on ambiguity.** If `JX3004-S-BLK` and `JX3004-M-BLK` both
  collapse to `JX3004-BLK`, withhold the proposal. A missing alias reads as
  zero stock and gets noticed; a wrong one attributes stock and later COGS to
  the wrong product and looks correct doing it.
- Apply exact catalog matches **last** so an alias can never shadow a real SKU.

Aggregate by **resolved id**, not by feed spelling — once aliases resolve, two
spellings can land on one SKU, and an upsert that SETs quantity would have the
second silently replace the first:

```ts
// Aggregate by RESOLVED sku_id, not by feed spelling. Two spellings can now
// resolve to one catalog SKU, and the upsert SETs rather than adds — writing
// per-spelling would have the second row overwrite the first instead of summing.
```

---

## 9. ⚠️ Reconciliation guards — the bug that cost the most

A sync that clears sold-out SKUs to zero needs a completeness guard: if a pull
comes back truncated, every omitted SKU looks sold out and the reconcile
**zeroes real stock while reporting success**.

The guard here was an absolute floor of 50 rows. The feed returns ~2,276. A
truncated pull after an unrelated pagination incident cleared 50 easily, and
warehouse stock went from ~20,300 units to 78. Nothing errored. Every
downstream reader worked from near-zero until it was noticed days later — and
it surfaced as a *20,000-unit FIFO drift*, which looks exactly like an
accounting problem and is not one.

**Never guard a destructive reconcile with an absolute constant.** Make the
floor relative to what the feed returned last time:

```ts
const MIN_ROWS_FOR_RECONCILE = 50;      // first-run backstop only
const SHRINK_TOLERANCE = 0.8;

const lastRowCount = /* COUNT(DISTINCT sku) from the raw feed table */;
const expected = Math.max(MIN_ROWS_FOR_RECONCILE,
                          Math.floor(lastRowCount * SHRINK_TOLERANCE));
const pullLooksComplete = distinctSkusThisPull >= expected;
```

Stale is recoverable. Zeroed is not.

And **a skipped reconcile must be visible.** It was a `console.warn`, which is
why nobody saw it. Put it in the return value on every run:

```ts
return { success: true, skuCount, syncedAt,
         distinctSkus, expectedSkus, truncatedPull: !pullLooksComplete, zeroed };
```

Generalise the rule: *any* job that deletes or zeroes based on absence from a
feed needs (a) a relative completeness guard and (b) the skip reported in
structured output, not a log line.

---

## 10. Month-end checklist

Codify the close as checks with `ok | attention | blocked` and an **action
string on every non-ok result** — a check that says "something is wrong"
without saying what to do is only marginally better than no check:

1. Settlements posted to the accounting system
2. COGS coverage (shipped units carrying no cost)
3. Open COGS exceptions
4. SKU mapping (every marketplace SKU resolves)
5. Fee classification (nothing in suspense)
6. Inventory reconciliation (FIFO vs 3PL + FBA)
7. Marketplace reimbursements (real income that never appears as a sale)

Scale tolerances with holding size — `max(25, 5% of physical)` — so a small
absolute gap from snapshot timing does not page anyone.

---

## 11. Scheduling

Use one centralised scheduler with a job registry, not one cron service per
job. In this repo: a single cron hits `/api/v1/cron/tick` every 5 minutes and
schedules are evaluated on ticks. Note the platform's real floor — Railway's
is 5 minutes regardless of what its config claims, so `*/3` actually means
every 15 minutes.

---

## 12. Test conventions worth carrying over

- **DDL lives in three places** — the ORM schema, the app's boot DDL, and the
  test setup. All three must agree. Add new tables to the test reset list too,
  or state leaks between tests.
- Indexes count as DDL. An `ON CONFLICT` upsert silently fails without its
  unique index, and a test suite missing that index will pass the wrong
  behaviour.
- Test the **pure functions** hard (classification, sign handling, tie-out,
  ambiguity refusal). They hold the accounting correctness.
- Validate against a **real settlement** as a fixture. Every one of the
  material bugs found here — the stranded cent, the sign flip, the empty
  dates — surfaced from real data, not synthetic.

---

## 13. Build order

Do it in this sequence; each phase is independently verifiable.

1. **Windsor client + raw archive + backfill.** ⚠️1 makes this urgent.
2. **Order import + guards.** Only if fulfilment is external.
3. **Dashboard + sync health + alerting.**
4. **Settlement classification + accounting posting.**
5. **COGS + revenue recognition.**
6. **Month-end checks.**
7. **Operator endpoints** — or earlier; they make 1–6 far easier to verify.

---

## 14. Checklist for the target repo

- [ ] Windsor API key in env; `redact()` on every error path
- [ ] Raw archive tables + `sync_state` with `stale` detection
- [ ] Backfill run for the full retention window immediately
- [ ] Count-based settlement dedup (⚠️3)
- [ ] Period derived from `posted_date` (⚠️2)
- [ ] Facilitator-tax legs classified and excluded; residual asserted zero (⚠️4)
- [ ] Receivable pinned to actual net + explicit plug line (⚠️5)
- [ ] Suspense account for unclassified lines
- [ ] Guards on every fulfilment/alerting path if importing orders
- [ ] Alias table consulted by importer, inventory sync **and** diagnostics
- [ ] Relative completeness guard on any zeroing reconcile (§9)
- [ ] Truncated-pull state in structured output, not a log line
- [ ] Ops endpoints with constant-time token, `?confirm=1`, dry-run defaults
- [ ] Month-end checks with an action string on every failure
- [ ] Real-settlement fixture in the test suite
