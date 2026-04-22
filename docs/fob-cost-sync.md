# FOB Cost Sync

How to keep `catalog_skus.cost_price` in sync with the factory PO
spreadsheet so Shopify margin reports stay accurate.

## Why this exists

Shopify's Finance / Margin / Profit reports all multiply `(Order total − Cost per item × quantity)` to show you gross margin. `Cost per item` in the Shopify CSV comes from `catalog_skus.cost_price` in our DB, adjusted by a landed-cost formula (see below). If the DB costs drift from the real factory quotes, **every margin number in Shopify becomes fiction** — off by whatever the drift is, usually 30–50%.

When a new factory PO lands, or prices change, re-run the sync.

## Where the data lives

| Source | What it is |
|---|---|
| `Factory_PO_Consolidated.xlsx` (`PO Master` sheet) | The source of truth. Col C = SKU, Col J = Unit Cost (FOB, USD). 115 rows today. |
| `catalog_skus.cost_price` in prod SQLite | Destination. Populated by `scripts/sync-fob-costs.py`. |
| Shopify CSV `Cost per item` column | Derived at export time = `cost_price × COST_LANDED_MULTIPLIER + COST_LANDED_FLAT` (see [shopify.ts](../src/modules/catalog/lib/export/shopify.ts) `landedCostFor()`). |

## Running the sync

### Prerequisites

- `openpyxl` Python package (`pip install openpyxl`)
- The consolidated PO spreadsheet at its canonical path (or pass a custom `--path`)
- Network access to `https://theframe.getjaxy.com/api/mcp` (uses the existing Claude Code MCP admin key baked into the script — same key as `scripts/sync-images-to-prod.py`)

### Typical run

```bash
# Preview only — parse + diff, no writes
python3 scripts/sync-fob-costs.py --dry

# Apply changes
python3 scripts/sync-fob-costs.py
```

### Custom spreadsheet path

```bash
python3 scripts/sync-fob-costs.py --path ~/Downloads/Factory_PO_Consolidated.xlsx
```

## Spreadsheet contract

The script reads a sheet named `PO Master` with this shape:

| Row | Column | Description |
|---|---|---|
| 1 | — | Header row (skipped) |
| 2+ | C | `JAXY SKU` — e.g. `JX1001-BLK` |
| 2+ | J | `Unit Cost` — FOB USD, e.g. `1.55` |

Rows with empty SKU or empty cost are skipped. Other columns (PO #, Factory, Style, Qty, Extension, etc.) are ignored but kept in the spreadsheet for context.

If the contract changes (new column order, renamed sheet), update `parse_spreadsheet()` in [`scripts/sync-fob-costs.py`](../scripts/sync-fob-costs.py).

## What the script does

1. Parse `{sku: fob_cost}` from the spreadsheet (normally 115 rows).
2. Read current `catalog_skus` via the MCP `system.query` tool (read-only admin path).
3. Diff: print how many rows will change, which are unchanged, and any SKUs in the spreadsheet but not the DB (or vice versa).
4. Unless `--dry`: build a single `UPDATE catalog_skus SET cost_price = CASE sku WHEN ... END WHERE sku IN (...)` and send it through the same MCP tool. One round-trip, not 115.
5. Verify: re-read the distribution (min/max/avg) and print a spot-check with landed-cost for 5 SKUs.

## Landed-cost formula

```
landed = FOB × 1.25 + $0.50
```

- **1.25× multiplier** covers US import duties on HS 9004.10, Section 301 China tariff, MPF/HMF fees, broker fees, docs, and a small contingency buffer. Totals to roughly 20–25% for Chinese-manufactured eyewear.
- **$0.50 flat adder** is a conservative per-unit freight allocation. Freight scales with carton density, not unit price, so a pure % multiplier would under-allocate on cheap units. At ~$300–$400 per air-freight carton holding 500–800 pairs, ~$0.40–$0.60 per unit, $0.50 is the safe midpoint.

Both knobs are Railway env vars, overridable without redeploy:

| Env var | Default |
|---|---|
| `COST_LANDED_MULTIPLIER` | `1.25` |
| `COST_LANDED_FLAT` | `0.50` |

Full code + comments: [`src/modules/catalog/lib/export/shopify.ts`](../src/modules/catalog/lib/export/shopify.ts) → `landedCostFor()`.

### Examples

| FOB | Landed (what Shopify sees) |
|---|---|
| $0.70 | $1.38 |
| $1.00 | $1.75 |
| $1.50 | $2.38 |
| $2.00 | $3.00 |

## After running the sync

1. Re-export the Shopify CSV (retail + wholesale as needed) from `/catalog/export` in the Frame.
2. Upload to Shopify.
3. Verify a product's `Cost per item` in Shopify Admin matches expectations.

## Troubleshooting

**"pip install openpyxl" error**
→ Run `pip install openpyxl` in the same Python that you're running the script with. If it still fails, run `python3 -m pip install openpyxl`.

**"Spreadsheet not found" / wrong path**
→ The default path points at the Claude Code local-agent-mode output folder. If the spreadsheet lives somewhere else, pass `--path`.

**Unknown SKUs warning (WARN N SKUs in spreadsheet but NOT in DB)**
→ Means the PO has a SKU that isn't yet created in `catalog_skus`. Either create the SKU first via the Frame UI, or fix the spreadsheet. The script will skip those rows.

**Costs look right in DB but Shopify still shows wrong numbers**
→ Check the landed-cost env vars on Railway. A stale `COST_LANDED_MULTIPLIER` or `COST_LANDED_FLAT` will skew every cost. Defaults are 1.25 and 0.50.

## Upgrade path

Today's formula is a heuristic. When we have real per-shipment landed cost (from broker invoices), the proper path is:

1. Add a `catalog_skus.landed_cost` column.
2. Populate from broker invoice data instead of derived arithmetic.
3. Change `shopify.ts:landedCostFor()` to prefer `landed_cost` when present, fall back to the formula when not.

Until then, the heuristic gets you directionally-correct margin analytics — much better than shipping FOB-only or blank.

## Related files

- [`scripts/sync-fob-costs.py`](../scripts/sync-fob-costs.py) — the script
- [`src/modules/catalog/lib/export/shopify.ts`](../src/modules/catalog/lib/export/shopify.ts) — `landedCostFor()` + CSV emission
- [`src/modules/catalog/lib/export/load-products.ts`](../src/modules/catalog/lib/export/load-products.ts) — exposes `costPrice` on `ExportProduct.skus[]`
- [`docs/image-pipeline.md`](image-pipeline.md) — the other long-running sync runbook, same auth pattern
