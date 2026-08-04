# Amazon Channel — Accounting Notes

**Purpose:** the shared reference for how Amazon money moves through the books.
Written for whoever is closing the month, reviewing the P&L, or wondering why a
number looks the way it does — not just for whoever wrote the code.

**Last updated:** 2026-08-04 · **Owner:** Finance · **Source of truth for
implementation:** [`docs/amazon-channel-plan.md`](./amazon-channel-plan.md)

---

## 1. The one thing to know first

Amazon's gross sales number is misleading right now, and it will stay that way
while the launch is running.

For 4 Jun – 25 Jul 2026 the numbers were:

| | Amount |
|---|---|
| Gross product sales | **$1,652.00** |
| Promotions | **−$1,178.99** (71% of gross) |
| FBA fulfilment fees | −$205.32 |
| Referral commission | −$31.92 (net of refund credits) |
| Refunds | −$112.00 |
| Selling plan subscription | −$79.98 |
| Inbound freight to FBA | −$21.30 |
| Return shipping labels | −$5.48 |
| **Net deposited** | **$19.99** |

Roughly $1,650 of gross sales produced $20 of cash. That is a launch-pricing
decision, not a problem with the data — but it means **any report quoting
Amazon gross revenue without promotions beside it is actively misleading.**
Promotions are therefore booked to their own contra-revenue account and shown
next to gross everywhere in The Frame.

---

## 2. Chart of accounts — what Amazon uses

### Newly created (Aug 2026)

| Code | Name | Type |
|---|---|---|
| 5470 | Amazon Fees - FBA Fulfillment | Direct Costs |
| 5475 | Amazon Fees - FBA Storage | Direct Costs |
| 5480 | Amazon Fees - Subscription | Direct Costs |

**Why these are separate from the 3PL accounts:** 5500 `3PL - Fulfillment &
Pick-Pack` and 5510 `3PL - Storage` are Big Sky. Amazon FBA is a second,
parallel fulfilment operation with a completely different cost structure. If
both fed the same accounts, neither channel's unit economics would be
answerable — you could not say what it costs to ship a unit through Amazon
versus through our own warehouse.

**Note on 5480:** the selling plan subscription (~$39.99/mo) is a fixed cost
sitting in Direct Costs so that Amazon's channel contribution is complete.
Moving it to 6340 `Software & Subscriptions` is equally defensible if we would
rather keep gross margin purely variable — flag it if the CPA prefers that.

### Existing accounts Amazon posts to

| Purpose | Account |
|---|---|
| Gross product sales | 4010 Sales - Amazon |
| Shipping income | 4060 Shipping Income |
| Promotions / discounts | 4310 Sales Discounts & Promotions |
| Refunds | 4300 Sales Returns & Allowances |
| Referral commission | 5410 Merchant Fees - Amazon |
| Inbound freight to FBA | 5010 COGS - Inbound Freight |
| Return shipping labels | 5300 Outbound Shipping & Postage |
| Unrecognised fees (suspense) | 5440 Merchant Fees - Other |
| Deposit clearing | 1030 Amazon Clearing (Bank) |
| Deferred revenue | 2050 Deferred Revenue |
| Receivable in transit | 1100 Receivables Holding |
| COGS | 5000 / 5010 / 5020 (shared) |

---

## 3. How a sale becomes a journal

Amazon money arrives on a two-week settlement cycle, not per order. Four things
happen, in this order:

**1. Orders import daily (14:10 UTC).** Amazon orders land in The Frame's
`orders` table with `channel = 'amazon'`. They exist for *finance only* —
revenue recognition, COGS, P&L and reconciliation all read from that table, so
Amazon has to be there or it is invisible to every one of them.

> **These orders are never pushed anywhere.** Amazon fulfils them itself. The
> Frame has no code path that can create an order in ShipHero or Shopify, and
> Amazon rows carry an `AMZ-` prefix plus explicit channel guards so no inbound
> ShipHero webhook can bind to one. If you see an Amazon order in The Frame, it
> is a record, not an instruction.

**2. Revenue is deferred, then recognised at shipment.** Same as Shopify and
Faire. Cash arriving is not revenue; shipping the goods is. The settlement
journal credits 2050 Deferred Revenue, and the daily recognition job moves it
to 4010 Sales - Amazon as orders ship.

**3. COGS posts daily (16:45 UTC).** Amazon lines flow into the existing
consolidated daily COGS journal — there is no separate Amazon COGS journal.
Cost comes from the same FIFO layers as every other channel.

**4. Settlements post on close (16:20 UTC).** When Amazon closes a settlement
period, one manual journal books the whole thing, then a bank transaction
sweeps the deposit into 1030 Amazon Clearing.

### The settlement journal

```
CR  2050  Deferred Revenue              gross product sales
CR  4060  Shipping Income               shipping charged to buyer
DR  4310  Sales Discounts & Promotions  promotions          ← the big one
DR  4300  Sales Returns & Allowances    refunds
DR  5410  Merchant Fees - Amazon        referral commission
DR  5470  Amazon Fees - FBA Fulfillment per-unit FBA fees
DR  5475  Amazon Fees - FBA Storage     monthly storage
DR  5480  Amazon Fees - Subscription    selling plan
DR  5010  COGS - Inbound Freight        freight into FBA
DR  5300  Outbound Shipping & Postage   return labels
DR  1100  Receivables Holding           = the actual deposit
──────────────────────────────────────────────────────────
then:  DR 1030 Amazon Clearing / CR 1100 Receivables Holding
```

Xero forbids manual journals touching bank accounts, which is why the deposit
lands in 1100 first and a separate bank transaction sweeps it into 1030.

---

## 4. Three treatments worth understanding

These are the judgement calls. If a number looks odd, it is usually one of
these three.

### Marketplace facilitator tax is not booked at all

Amazon collects sales tax from the buyer and remits it to the state itself. The
money never reaches us. The settlement file shows both legs — tax collected and
tax withheld — and they cancel exactly.

Booking them would create a sales tax liability we do not owe and never pay.
So both legs are excluded, and the system **asserts they net to zero on every
settlement**. If that ever stops being true, a Slack alert fires, because a
non-zero residual would mean a real tax obligation going unrecorded.

*In the books:* Amazon contributes nothing to 2230 Sales Tax. That is correct,
not an omission.

### Promotions are contra-revenue, never netted against sales

At 71% of gross, netting promotions into the sales figure would hide the single
most important fact about this channel. 4010 shows true demand; 4310 shows what
the launch discount is costing.

*In the books:* Amazon's 4010 balance will look much larger than the cash. The
difference is 4310.

### Unrecognised fees go to suspense and raise an alert

Amazon introduces new fee types over time — long-term storage, disposal,
removal, Vine enrolment. Anything the system does not recognise posts to 5440
`Merchant Fees - Other` **and fires a Slack alert**. It is never absorbed into
a neighbouring account on a partial name match.

*If you see 5440 moving:* a new Amazon fee type has appeared and needs a proper
mapping. It is a prompt, not an error.

---

## 5. Inventory: FBA is not ShipHero

This is the part most likely to cause confusion at month-end.

**Moving stock from our warehouse to Amazon FBA is a transfer, not a sale.** No
revenue, no COGS. The goods stay ours, and stay in inventory, until a customer
buys them. The $0 ShipHero order used to move them is a picking document — its
zero value is correct.

Three consequences:

1. **COGS is recognised when Amazon sells the unit,** not when it ships to
   Amazon. This matches revenue to cost in the same period, the same as every
   other channel.
2. **ShipHero's on-hand understates what we own.** Units at Amazon have left
   ShipHero's count but are still our asset. True owned inventory is
   `ShipHero on-hand + FBA available + FBA inbound + FBA reserved`, and the
   Amazon dashboard shows this breakdown.
3. **Keep raising FBA replenishments in ShipHero, not as $0 Shopify orders.** A
   ShipHero-native order never reaches The Frame, which is exactly what we
   want. A $0 Shopify order *would* import and *would* deplete FIFO at transfer
   time — then again when Amazon sells the unit, double-counting the cost while
   the books still balanced against themselves.

There is a safety net: any $0 order carrying 20+ units raises a
`suspected_transfer` exception. It still costs the line (influencer gifting and
warranty replacements are genuine $0 orders whose cost we do want recognised) —
it just flags it for a human look.

**Month-end check:** FIFO remaining quantity should ≈ ShipHero on-hand + FBA
total. If FIFO shows *more*, a sale went uncosted. If it shows *less*,
something was likely depleted twice. This runs automatically on the dashboard.

---

## 6. Month-end close

The Amazon dashboard (`/finance/amazon`) carries a month-end card that runs
seven checks. Work top to bottom — they are ordered by how expensive the
mistake is to find late.

| Check | Blocks close? | What it means |
|---|---|---|
| Settlements posted to Xero | Yes | A closed settlement not in Xero means the period's revenue and fees are missing |
| COGS coverage | Yes | Shipped units with no cost attached — gross margin is overstated |
| Unmapped SKUs | Yes | An Amazon SKU that does not resolve to the catalog cannot be costed |
| Open COGS exceptions | Review | Shortfalls, zero-cost layers, suspected transfers |
| Unclassified fees | Review | A new Amazon fee type sitting in 5440 |
| Inventory reconciliation | Review | FIFO vs ShipHero + FBA drift |
| FBA reimbursements | Review | Amazon paying us for stock it lost — real income, easy to miss |

**On reimbursements:** when Amazon loses or damages FBA inventory it reimburses
us. This arrives inside the settlement and never looks like a sale, so it is
easy to overlook. If a month looks light, check Seller Central.

---

## 7. Reference: every settlement line type

Derived from the 288 settlement rows actually on the account, not from Amazon's
documentation. All 288 classify with none falling through.

| Amazon says | We book it to |
|---|---|
| Order / ItemPrice / Principal | 2050 → 4010 (deferred, then recognised) |
| Order / ItemPrice / Shipping | 4060 Shipping Income |
| Order / ItemPrice / Tax | *excluded — facilitator tax* |
| Order / ItemWithheldTax / MarketplaceFacilitatorTax | *excluded — facilitator tax* |
| Order / Promotion / Principal or Shipping | 4310 Sales Discounts & Promotions |
| Order / ItemFees / Commission | 5410 Merchant Fees - Amazon |
| Order / ItemFees / FBAPerUnitFulfillmentFee | 5470 Amazon Fees - FBA Fulfillment |
| Refund / ItemPrice / Principal | 4300 Sales Returns & Allowances |
| Refund / ItemFees / Commission | 5410 (credit back) |
| Refund / ItemFees / RefundCommission | 5410 (admin fee) |
| FBAFees / Partnered Carrier Shipment Fee | 5010 COGS - Inbound Freight |
| FBAFees / FBA Inventory Storage Fee | 5475 Amazon Fees - FBA Storage |
| other / Subscription Fee | 5480 Amazon Fees - Subscription |
| other / Inbound Transportation Fee | 5010 COGS - Inbound Freight |
| other / Shipping label purchase for return | 5300 Outbound Shipping & Postage |
| other / Payable to Amazon + Successful charge | *excluded — offsetting pair* |
| Transfers / Micro Deposit | 5440 (bank artefact, via the adjustment line) |
| *anything unrecognised* | 5440 **+ Slack alert** |

---

## 8. Operating notes

**Data source.** Everything comes from Windsor AI (connector `amazon_sp`), not
a direct Amazon integration. Amazon serves settlement data for **90 days only**,
so The Frame archives every settlement row permanently on first sight. Anything
older than 90 days exists only in our archive — it cannot be re-fetched.

**Reliability.** Windsor's Amazon reports are genuinely unreliable; some respond
in two seconds and others never return. This is expected, not a fault. A single
failure is ignored; three consecutive failures raise an alert. The dashboard's
sync-health panel shows the last successful pull per report.

**Posting is opt-in.** Settlements only post to Xero when the
`amazon_xero_posting` setting is `draft` or `posted`. Unset means the system
builds and validates journals without sending them. Journals are hard to unpick
once posted, so going live is a deliberate act, not something that happens
overnight.

**Recommended first live run:**
1. Dry run — builds and balances every journal, posts nothing
2. `DRAFT`, one settlement — appears in Xero unapproved, eyeball it
3. `POSTED` for the rest

**Corrections.** Never edit a posted journal. Use the reverse-and-repost
pattern already used for COGS: post a reversing journal, then re-post the
corrected one. The period lock (`xero_period_lock_date`) is respected.

---

## 9. Open items

- **Xero tracking category.** Journals attach a "Sales Channel" tracking option.
  Amazon needs one alongside the existing Faire/Shopify options, or Amazon will
  not separate out in tracking-based reports. Check
  `GET /api/v1/finance/amazon/post-settlements` — it reports whether tracking
  is mapped.
- **5480 placement** — Direct Costs vs 6340 Software & Subscriptions (§2).
- **Settlement-date invoice model** is not implemented for Amazon. If
  `payout_revenue_model` is ever switched to `invoice`, Amazon posting will
  refuse rather than post something wrong.
