# FIFO Inventory Costing & Weekly COGS → Xero

**Status:** Deployed to main
**Module:** Finance
**Integration:** Xero Manual Journals API

---

## What it does

Implements lot-based FIFO inventory costing for Jaxy's sunglasses catalog.
Each Purchase Order receipt creates a "cost layer" per SKU with allocated
landed costs (product cost + freight + duties/tariffs). When orders are
fulfilled, units are consumed from the oldest cost layer first (FIFO).
Weekly COGS is calculated by summing all depletions for the period, split
into product cost / freight / duties components, and posted to Xero as a
Manual Journal.

### Why FIFO instead of weighted average

- Jaxy imports from Chinese factories via **mixed shipping methods** (air
  freight at ~$1.50/unit vs. ocean at ~$0.70/unit). The same SKU can have
  drastically different landed costs depending on which shipment it came from.
- **Tariffs change** (currently ~6% for HS6 900410, but subject to trade
  policy changes). A tariff increase only applies to units received AFTER
  the change — FIFO ensures old units are costed at the old rate.
- Xero's built-in tracked inventory uses weighted average, which would
  blend air and ocean costs together and misstate COGS on any given week.

### Why lots

Each PO receipt = one lot. The lot captures:
- **Product cost** (FOB unit price from the factory invoice)
- **Freight allocation** (shipping + freight costs from the PO, divided
  pro-rata across units by quantity)
- **Duties allocation** (duties cost from the PO, divided pro-rata)
- **Shipping method** (air vs ocean — for analysis, not for FIFO ordering)

FIFO depletion happens at the lot level: oldest lot consumed first
regardless of shipping method.

---

## Architecture

```
Factory PO received     →  Cost layers created
  (with freight,            (one per line item,
   duties, costs)            landed cost calculated)
        │                         │
        ▼                         ▼
Order fulfilled         →  FIFO depletion
  (Shopify/Faire/direct)     (oldest layer consumed first,
                              depletion record created)
        │                         │
        ▼                         ▼
Weekly COGS calc        →  Xero Manual Journal
  (sum depletions,            DR: COGS Product  (500)
   split by component,        DR: COGS Freight  (501)
   group by channel)           DR: COGS Duties   (502)
                               CR: Inventory Asset (630)
```

---

## Data model

### `inventory_cost_layers`

One row per PO line item receipt. The FIFO stack.

| Column | Type | Purpose |
|--------|------|---------|
| id | TEXT PK | |
| sku_id | TEXT | FK to catalog_skus |
| po_line_item_id | TEXT | FK to inventory_po_line_items (nullable for manual entries) |
| po_id | TEXT | FK to inventory_purchase_orders |
| po_number | TEXT | For display/audit |
| quantity | INTEGER | Original quantity received |
| remaining_quantity | INTEGER | Units not yet consumed (mutable) |
| unit_cost | REAL | FOB product cost per unit |
| freight_per_unit | REAL | Allocated freight + shipping |
| duties_per_unit | REAL | Allocated duties/tariffs |
| landed_cost_per_unit | REAL | unit_cost + freight + duties |
| shipping_method | TEXT | "air" or "ocean" (informational) |
| received_at | TEXT | When the PO was received (drives FIFO order) |

### `inventory_cost_depletions`

One row per consumption event. Links a cost layer to a sale.

| Column | Type | Purpose |
|--------|------|---------|
| id | TEXT PK | |
| cost_layer_id | TEXT | FK to inventory_cost_layers |
| order_item_id | TEXT | FK to order_items (nullable for adjustments) |
| order_id | TEXT | FK to orders |
| channel | TEXT | Sales channel for COGS breakdown |
| quantity | INTEGER | Units consumed from this layer |
| unit_cost | REAL | Product cost at time of depletion |
| landed_cost_per_unit | REAL | Full landed cost at depletion |
| depleted_at | TEXT | When the depletion occurred |

### `cogs_journals`

One row per weekly COGS posting.

| Column | Type | Purpose |
|--------|------|---------|
| id | TEXT PK | |
| week_start / week_end | TEXT | Period boundaries |
| product_cost | REAL | Sum of unit_cost × quantity across depletions |
| freight_cost | REAL | Sum of freight_per_unit × quantity |
| duties_cost | REAL | Sum of duties_per_unit × quantity |
| total_cogs | REAL | product + freight + duties |
| unit_count | INTEGER | Total units sold |
| channel_breakdown | TEXT | JSON: per-channel breakdown |
| status | TEXT | draft → posted → reconciled |
| xero_journal_id | TEXT | Xero ManualJournalID |
| xero_posted_at | TEXT | When posted to Xero |

---

## API endpoints

### `GET /api/v1/finance/cost-layers`

| Param | Effect |
|-------|--------|
| `?summary=true` | Grouped by SKU with totals |
| `?skuId=xxx` | Detailed layers for one SKU |

### `POST /api/v1/finance/cost-layers`

Create cost layers:
```json
{ "fromPO": "po-uuid" }
```
Or manually:
```json
{ "manual": { "skuId": "xxx", "quantity": 100, "unitCost": 1.50, "freightPerUnit": 0.70, "dutiesPerUnit": 0.09 } }
```

### `GET /api/v1/finance/cogs`

| Param | Effect |
|-------|--------|
| `?journals=true` | List all COGS journals |
| `?weekStart=YYYY-MM-DD&weekEnd=YYYY-MM-DD` | Calculate COGS for a period |

### `POST /api/v1/finance/cogs`

Multi-action endpoint:

| Action | Body | Effect |
|--------|------|--------|
| `calculate` | `{ weekStart, weekEnd }` | Calculate + save draft journal |
| `post-to-xero` | `{ journalId, asDraft? }` | Post a saved journal to Xero |
| `deplete-orders` | `{ since? }` | Run FIFO on all uncosted fulfilled orders |
| `full-cycle` | `{ weekStart, weekEnd, asDraft? }` | Deplete + calculate + post in one call |

---

## Weekly workflow

1. **Navigate to** Finance → FIFO Costing / COGS
2. **Select the week** (Monday–Sunday date picker)
3. **Click "Deplete Orders"** — finds all fulfilled orders in the period
   that haven't been costed yet, runs FIFO depletion against cost layers
4. **Click "Calculate COGS"** — sums all depletions for the week, splits
   by product/freight/duties, saves as a draft journal
5. **Review the numbers** — check the channel breakdown, verify totals
6. **Click "Post to Xero"** — posts the journal as a Draft in Xero
7. **In Xero** — review the draft manual journal, approve/post it

---

## Xero integration details

### Manual Journal format

```json
{
  "ManualJournals": [{
    "Narration": "Weekly COGS — 2026-04-14 to 2026-04-20 (142 units)",
    "Date": "2026-04-20",
    "Status": "DRAFT",
    "LineAmountTypes": "NoTax",
    "JournalLines": [
      { "LineAmount": 213.00, "AccountCode": "500", "Description": "COGS — Product cost (142 units)" },
      { "LineAmount": 99.40, "AccountCode": "501", "Description": "COGS — Freight/shipping allocation" },
      { "LineAmount": 12.78, "AccountCode": "502", "Description": "COGS — Duties/tariffs allocation" },
      { "LineAmount": -325.18, "AccountCode": "630", "Description": "Inventory consumed — 2026-04-14 to 2026-04-20" }
    ]
  }]
}
```

### Account codes (configurable via settings)

| Setting key | Default | Purpose |
|-------------|---------|---------|
| `xero_cogs_product_account` | 500 | COGS — Product cost |
| `xero_cogs_freight_account` | 501 | COGS — Freight |
| `xero_cogs_duties_account` | 502 | COGS — Duties/Tariffs |
| `xero_inventory_asset_account` | 630 | Inventory Asset (credited) |

Set these in The Frame's settings table to match your Xero chart of accounts.

### Why we post as DRAFT

Posting as DRAFT (not POSTED) means the journal appears in Xero's
Manual Journals list awaiting approval. This gives the finance person
a chance to review the numbers before they hit the ledger. Once
reviewed, they approve directly in Xero.

---

## Landed cost allocation

When a PO is received and cost layers are created, freight and duties
are allocated **pro-rata by quantity** across all line items:

```
freight_per_unit = (po.shipping_cost + po.freight_cost) / po.total_units
duties_per_unit  = po.duties_cost / po.total_units
landed_cost      = unit_cost + freight_per_unit + duties_per_unit
```

This is the "by quantity" allocation method, appropriate because Jaxy's
products are similar in size and weight. If products ever vary
significantly in weight/value, switch to "by value" allocation.

### Handling mixed shipping (air + ocean)

When a PO is split — some SKUs arrive by air, rest by ocean — the correct
approach is to **receive them as separate POs** (or separate receipts on
the same PO). Each receipt creates its own cost layers with its own freight
allocation. Air-shipped units get the higher per-unit freight; ocean units
get the lower rate.

---

## Backfilling existing inventory

If you have existing POs with cost data but no cost layers:

```bash
# Via API — create layers from a specific PO
curl -X POST https://theframe.getjaxy.com/api/v1/finance/cost-layers \
  -H "Content-Type: application/json" \
  -d '{ "fromPO": "<po-uuid>" }'

# Via MCP (from local Claude)
# system.query: SELECT id, po_number FROM inventory_purchase_orders WHERE status = 'received'
# Then call the API for each PO
```

For orders that were fulfilled before cost layers existed:

```bash
curl -X POST https://theframe.getjaxy.com/api/v1/finance/cogs \
  -H "Content-Type: application/json" \
  -d '{ "action": "deplete-orders", "since": "2026-01-01" }'
```

This finds all shipped/delivered orders without cost depletions and runs
FIFO against whatever cost layers exist. Orders whose SKUs have no cost
layers will show up in the `shortfalls` array.

---

## File map

| File | Purpose |
|------|---------|
| `src/modules/finance/schema/index.ts` | Cost layers, depletions, journals tables |
| `src/modules/finance/lib/fifo-engine.ts` | Core FIFO engine (create, deplete, calculate, query) |
| `src/modules/finance/lib/xero-client.ts` | Xero journal posting (postCogsJournalToXero) |
| `src/app/api/v1/finance/cost-layers/route.ts` | Cost layers CRUD API |
| `src/app/api/v1/finance/cogs/route.ts` | COGS calculation, depletion, Xero posting API |
| `src/app/(dashboard)/finance/cogs/page.tsx` | COGS dashboard UI |
| `src/lib/db.ts` | Idempotent CREATE TABLE statements |

---

## Research basis

Built after comprehensive analysis of:
- **Cin7 Core** (FIFO + landed cost, best Xero integration, $349-999/mo)
- **Finale Inventory** (weighted average only, ruled out)
- **A2X** (revenue bridge only, no FIFO)
- **inFlow** (FIFO support but beta lot tracking, one-way Xero)
- **ShipHero** (WMS only, no costing)
- **Xero API** (Manual Journals, tracked inventory limitations)

Custom build chosen because no tool in the $100K-$5M range handles the
complete flow of FIFO + landed cost allocation across mixed shipping
methods + native Xero journal posting + ShipHero as receiving system.
Cin7 comes closest but is a full ERP replacement at significant cost.
