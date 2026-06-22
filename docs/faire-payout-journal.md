# Faire payout — Xero journal structure

Canonical reference for how Faire payouts post to Xero.
The implementation lives in [`src/modules/integrations/lib/faire/payout-sync.ts`](../src/modules/integrations/lib/faire/payout-sync.ts).

## What posts per payout

Each Faire order with a `payment_initiated_at` and a positive `total_payout` produces TWO Xero records:

### 1. ManualJournal (deferred-revenue posting)

| Line | Side | Account | Amount | Description |
|---|---|---|---|---|
| 1 | Debit  | `paymentFeeAccount` | `+paymentFee` | Faire payment processing fee — order {displayId} |
| 2 | Debit  | `commissionAccount` | `+commission` | Faire commission — order {displayId} (only if > 0; Faire Direct = 0) |
| 3 | Debit  | `receivablesHoldingAccount` (1100) | `+totalPayout` | Receivables holding (net payout) — order {displayId} — swept to bank via BankTransaction |
| 4 | Credit | `deferredRevenueAccount` (2050) | `-netOrderTotal` | Deferred revenue (gross sales) — order {displayId} (recognized at shipment) |
| 5 | (opt) Debit/Credit | account varies (see below) | `-delta` | Faire payout adjustment — only when delta ≠ 0 (~5% of orders). |

**Balance check:** `paymentFee + commission + totalPayout - netOrderTotal + (-delta) = 0`

For most orders, `totalPayout = netOrderTotal - paymentFee - commission` so `delta = 0` and line 5 is omitted.

For ~5% of orders Faire's actual wire differs from this formula by ±$1-$60 with no matching field in `/external-api/v2/orders/{id}` (audited exhaustively 2026-06-22). Faire's payout-details UI shows buyer-paid shipping as a "Shipping" line that flows through to the maker — confirmed via UI on order `AS8JJQWP5X` ($18 buyer shipping → +$18 delta) — but the field isn't exposed in the order API.

### Where the delta routes

Line 5 picks the best account based on the sign of `delta`, falling back to `shippingLabelsAccount` (5460) if the more specific account isn't mapped:

| `delta` sign | First-choice account | Fallback | What it likely represents |
|---|---|---|---|
| **Positive** (Faire paid MORE) | **4060 Shipping Income** (`shipping_income`) | 5460 | Buyer-paid shipping passthrough, Faire shipping overpayment / subsidy |
| **Negative** (Faire paid LESS) | **5900 Inventory Adjustments & Shrinkage** (`inventory_adjustments`) | 5460 | Damaged/missing items deducted, hidden Faire fee |

To enable the better categorization, add these two mappings under **Settings → Integrations → Xero** with the category keys `shipping_income` and `inventory_adjustments`. Until they're configured, all deltas go to 5460 and the bookkeeper recategorizes at month-end in one batch journal.

The description line of every adjustment includes the delta amount and a hint, e.g.:
> "Faire payout adjustment — order AS8JJQWP5X (Faire paid +18.00 vs computed; likely buyer-paid shipping or Faire overpayment). Review at month-end."

### 2. BankTransaction (sweep from receivables to bank clearing)

After the journal posts, a separate `BankTransaction.RECEIVE` clears `totalPayout` from `1100 Receivables Holding` → `bankClearingAccount`. Reference: `faire_payout_{payoutKey}`.

This pairing lets the books reflect the timing accurately: the journal records the sale at payment initiation, the bank transaction records the actual cash hitting the operating account.

## ⚠️ Shipping reimbursement — NOT included

`summary.shippingReimbursement` (the `maker_cost` from the shipment) is **deliberately excluded** from the journal.

### Why

Empirical audit of 224 payouts (2026-06-22) showed Faire's `totalPayout` is **exactly** `netOrderTotal - paymentFee - commission`. The shipping reimbursement field is data we collect from the API, but Faire does NOT include it in the per-order payout for SHIP_ON_YOUR_OWN orders.

### Previous bug

An earlier version added a 5th credit line:

```ts
{ LineAmount: -shippingReimbursement, AccountCode: shippingLabelsAccount }
```

This intended to offset shipping expense that the maker already booked when paying for the label. But without a matching debit, it produced `Xero ValidationException: "The total debits (X) must equal total credits (X+25)"`. 56 of 224 payouts (June 17–22) failed with this error before the fix.

### If Faire ever does reimburse shipping

That cash flows through a different settlement channel (likely a monthly credit-back on the invoice, separately). When that happens, model it as its OWN journal:

- Debit `bankClearingAccount` (cash in)
- Credit `shippingLabelsAccount` (reverses the original expense)

Don't bundle it back into the per-order payout journal.

## Sync flow + idempotency

1. `syncFairePayouts` paginates Faire's `/orders` API filtered to recent `payment_initiated_at`
2. For each order, builds the summary via `summarizeFairePayout()`
3. Skips if `xero_payout_syncs` already has a `(faire, payoutKey)` row → idempotent
4. Posts the ManualJournal, then the BankTransaction
5. Logs both to `xero_journal_log` (success or failure with full payload + response)
6. On success only, inserts into `xero_payout_syncs` so future runs skip it

**Failed journals do NOT enter `xero_payout_syncs`** — they retry automatically on the next run. After fixing a journal-construction bug, just re-run the cron; previously-failed payouts will retry.

## Chart-of-accounts mapping

Account codes are configured in `cfg` (`faireXeroConfig()`). Current production values:

- `receivablesHoldingAccount` = **1100** Receivables Holding
- `deferredRevenueAccount` = **2050** Deferred Revenue
- `paymentFeeAccount` = **(see jaxy chart of accounts)**
- `commissionAccount` = same channel; 0 for Faire Direct
- `bankClearingAccount` = bank clearing
- `shippingLabelsAccount` = **5460** Shipping Labels (referenced by the dropped line; kept in config in case we revisit shipping reimbursement)

## Related

- Master SOP: `finance/Jaxy_Bookkeeping_SOP.md` in Google Drive — keep in sync when journal structure changes.
- Tracking dimension: every line carries the "Sales Channel = Faire" tracking option from `xero_tracking_mappings`.
- See [`src/modules/integrations/lib/xero/journal-builder.ts`](../src/modules/integrations/lib/xero/journal-builder.ts) for the generic deferred-revenue posting helper.
