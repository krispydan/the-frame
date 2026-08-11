# The Frame MCP server

The Frame exposes ~70 tools over MCP (JSON-RPC 2.0, protocol `2024-11-05`)
at a single endpoint. Any MCP-capable client — Claude Code, Claude
Desktop, a Claude session with an HTTP MCP connector — can drive the
catalog, product photos, sales, finance, and orders modules through it.

## Endpoint & auth

```
POST https://the-frame-production.up.railway.app/api/mcp
Header: X-API-Key: frame_…
```

- Supported methods: `initialize`, `tools/list`, `tools/call`.
- Rate limit: 100 requests/min per key.
- Keys live hashed in the `api_keys` table; the plaintext is shown once
  at mint time and never again.

### Minting / revoking keys (ops token)

Keys are managed through the ops endpoint (see
[`ops-endpoints.md`](ops-endpoints.md) for the ops-auth model):

```bash
# Mint (plaintext returned ONCE — store it immediately)
curl -X POST -H "x-ops-key: $OPS_TOKEN" -H "Content-Type: application/json" \
  "https://the-frame-production.up.railway.app/api/admin/ops/mcp-key?confirm=1" \
  -d '{"name": "daniel-laptop", "expiresDays": 365}'

# List (names + metadata only)
curl -H "x-ops-key: $OPS_TOKEN" \
  "https://the-frame-production.up.railway.app/api/admin/ops/mcp-key"

# Revoke
curl -X DELETE -H "x-ops-key: $OPS_TOKEN" -H "Content-Type: application/json" \
  "https://the-frame-production.up.railway.app/api/admin/ops/mcp-key?confirm=1" \
  -d '{"name": "daniel-laptop"}'
```

One key per person/machine, so a leak revokes cleanly.

## Connecting clients

**Claude Code (CLI):**

```bash
claude mcp add the-frame --transport http \
  https://the-frame-production.up.railway.app/api/mcp \
  --header "X-API-Key: frame_…"
```

**Raw JSON-RPC sanity check:**

```bash
curl -X POST -H "X-API-Key: frame_…" -H "Content-Type: application/json" \
  https://the-frame-production.up.railway.app/api/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Tool families

Names are `module.action` (run `tools/list` for the full, current
catalog with schemas — this table is orientation, not the contract):

| Family | Examples | What it covers |
|---|---|---|
| `system.*` | `system.health`, `system.query` | health, read-only SQL |
| `catalog.*` | `catalog.list_products`, `catalog.generate_copy`, `catalog.export` | products, copy, exports |
| `catalog.images.*` | `catalog.images.upload`, `.process`, `.replace_set`, `.generate_collection` | single-image ingestion + the sharp pipeline (bg removal, crop, shadow, square) |
| `catalog.photos.*` | `catalog.photos.bulk_upload`, `.route_preview`, `.coverage` | **bulk** photo ingestion by canonical filename + the coverage matrix |
| `sales.*` | `sales.list_prospects`, `sales.create_deal`, `sales.import_csv` | CRM/prospecting |
| `customers.*` | `customers.get_health`, `.get_reorder_predictions` | wholesale accounts |
| `orders.*` / `finance.*` | `orders.update_status`, `finance.get_pnl`, `finance.run_daily_cogs` | ops + accounting |
| `sequences.*` / `ajm.*` | `sequences.enroll`, `ajm.compare` | outreach engine, AJM comparisons |

## Bulk photo upload (the common workflow)

Canonically-named files route themselves — `{SKU}[-ANGLE]_{SUFFIX}.ext`
per SKU, `{STYLE}_{suffix}.ext` per product (see
[`/catalog/photos`](https://theframe.getjaxy.com/catalog/photos) for the
naming legend). The loop for a big migration:

1. `catalog.photos.route_preview` with just the file names — a free
   dry-run showing where every file WILL land and which names fail.
2. `catalog.photos.bulk_upload` in batches of ≤20 (base64 payload
   size), each entry `{fileName, base64|sourceUrl}`. Re-running is safe:
   dedupe is per (SKU, checksum).
3. `catalog.photos.coverage` to verify — per SKU, which kinds exist and
   which required ones (original, no_bg, square) are missing.

Humans doing the same thing by hand: drag files onto `/catalog/photos`.
