/**
 * /settings/integrations/amazon
 *
 * Operator surface for the Amazon listings pipeline. Server component
 * fetches initial state; the products table is a client island
 * (ListingsTable) that owns selection, the row-click sheet, and the
 * sequential batch generation flow.
 *
 *   1. Readiness card — template-snapshot version, Shopify retail
 *      connection, Anthropic env, eligible counts, last validation.
 *   2. Actions strip — Validate + Download (generation lives in the
 *      table's bulk-action bar now).
 *   3. Products table — checkboxes, thumbnails, row-click → side sheet
 *      hosting the AmazonListingTab editor. Bulk action bar offers
 *      "Generate selected", "Regenerate selected", or "Generate all
 *      pending" with sequential one-product-at-a-time POSTs.
 */
export const dynamic = "force-dynamic";

import { sqlite } from "@/lib/db";
import {
  getSnapshotSource, getAmazonColumns,
} from "@/modules/catalog/lib/amazon/template-snapshot";
import { catalogImageUrl } from "@/lib/storage/image-url";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  CheckCircle, AlertTriangle, Warehouse,
} from "lucide-react";
import { ListingsTable, type ListingRow } from "./listings-table";
import { UpcImportCard } from "./upc-import-card";

function tryAll<T>(sql: string, params: unknown[] = []): T[] {
  try {
    return sqlite.prepare(sql).all(...params) as T[];
  } catch (e) {
    console.error("[amazon settings page]", e);
    return [];
  }
}

function tryGet<T>(sql: string, params: unknown[] = []): T | null {
  try {
    return (sqlite.prepare(sql).get(...params) as T) ?? null;
  } catch {
    return null;
  }
}

interface ProductRow {
  id: string;
  sku_prefix: string;
  name: string | null;
  status: string;
  has_listing: number;
  generated_at: string | null;
  model_used: string | null;
  amazon_title: string | null;
  hero_file_path: string | null;
}

export default function AmazonIntegrationPage() {
  const source = getSnapshotSource();
  const columnCount = getAmazonColumns().length;
  const requiredColumnCount = getAmazonColumns().filter((c) => c.required).length;

  // Approved products joined with their Amazon listing + hero image.
  // The hero is picked by isBest DESC, position ASC (matches the order
  // the AI vision pipeline implicitly uses).
  const eligible = tryAll<ProductRow>(`
    SELECT
      p.id, p.sku_prefix, p.name, p.status,
      CASE WHEN al.id IS NULL THEN 0 ELSE 1 END AS has_listing,
      al.generated_at, al.model_used, al.amazon_title,
      (
        SELECT ci.file_path FROM catalog_images ci
        JOIN catalog_skus cs ON ci.sku_id = cs.id
        WHERE cs.product_id = p.id
        ORDER BY ci.is_best DESC, ci.position ASC, ci.id ASC
        LIMIT 1
      ) AS hero_file_path
    FROM catalog_products p
    LEFT JOIN catalog_amazon_listings al ON al.product_id = p.id
    WHERE p.status NOT IN ('intake', 'processing')
    ORDER BY (CASE WHEN al.id IS NULL THEN 0 ELSE 1 END) ASC, p.sku_prefix ASC
  `);

  const totalEligible = eligible.length;
  const withListing = eligible.filter((r) => r.has_listing === 1).length;
  const withoutListing = totalEligible - withListing;

  // Convert SQL rows → typed ListingRow[] for the client island.
  const initialRows: ListingRow[] = eligible.map((r) => ({
    id: r.id,
    skuPrefix: r.sku_prefix,
    name: r.name,
    status: r.status,
    hasListing: r.has_listing === 1,
    generatedAt: r.generated_at,
    modelUsed: r.model_used,
    amazonTitle: r.amazon_title,
    thumbnailUrl: catalogImageUrl(r.hero_file_path),
  }));

  // Shopify retail connection check (image-URL source).
  const shopifyConnected = tryGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM shopify_shops WHERE channel = 'retail' AND is_active = 1`,
  );
  const retailOk = (shopifyConnected?.c ?? 0) > 0;

  // Anthropic readiness — env presence + evidence-of-working state.
  const anthropicEnvSet = !!process.env.ANTHROPIC_API_KEY;
  const anthropicHealthy = anthropicEnvSet && withListing > 0;
  const anthropicValue = !anthropicEnvSet
    ? "Not configured"
    : anthropicHealthy
      ? "Healthy (validated by recent generation)"
      : "Configured (no generations yet)";
  const anthropicSub = !anthropicEnvSet
    ? "Set ANTHROPIC_API_KEY in Railway env, then click Generate."
    : anthropicHealthy
      ? undefined
      : "Click Generate to confirm the key works against Claude vision.";

  // Last validation summary (persisted by /validate so it survives page
  // refresh).
  const lastValidation = tryGet<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'amazon_last_validation'`,
  );
  let lastSummary: {
    ready: number;
    warning: number;
    blocked: number;
    at: string;
    mode?: "grouped" | "per-product";
    parentCount?: number;
    childCount?: number;
    productCount?: number;
  } | null = null;
  try {
    if (lastValidation?.value) lastSummary = JSON.parse(lastValidation.value);
  } catch {
    /* ignore */
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Warehouse className="h-7 w-7" />
          Amazon listings
        </h1>
        <p className="text-muted-foreground mt-2">
          Vision-AI listing copy → snapshot-validated spreadsheet → Seller Central upload.
        </p>
      </div>

      {/* Readiness */}
      <Card>
        <CardHeader>
          <CardTitle>Pipeline readiness</CardTitle>
          <CardDescription>
            What needs to be set up before listings can be generated and downloaded.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 text-sm">
          <ReadinessRow
            ok={true}
            label="Template snapshot"
            value={`v${source.version ?? "(unknown)"} — ${columnCount} columns (${requiredColumnCount} required)`}
            sub={`Snapshotted ${source.snapshotTakenAt.slice(0, 10)}`}
          />
          <ReadinessRow
            ok={retailOk}
            label="Shopify retail (for image URLs)"
            value={retailOk ? "Connected" : "Not connected"}
            sub={retailOk ? undefined : "Connect retail in /settings/integrations/shopify before generating."}
          />
          <ReadinessRow
            ok={anthropicEnvSet}
            label="Anthropic API"
            value={anthropicValue}
            sub={anthropicSub}
          />
          <ReadinessRow
            ok={totalEligible > 0}
            label="Eligible products"
            value={`${totalEligible} approved`}
            sub={withListing
              ? `${withListing} with AI copy · ${withoutListing} pending`
              : "Run Generate to draft copy for these."}
          />
          {lastSummary && (
            <ReadinessRow
              ok={lastSummary.blocked === 0}
              label="Last validation"
              value={`${lastSummary.ready} ready · ${lastSummary.warning} warning · ${lastSummary.blocked} blocked`}
              sub={
                // Phase 4 group restructure: report parents + children
                // when the validate run was in group mode so the
                // operator can sanity-check the structural change.
                lastSummary.mode === "grouped" &&
                lastSummary.parentCount != null &&
                lastSummary.childCount != null
                  ? `Grouped feed: ${lastSummary.parentCount} parents + ${lastSummary.childCount} children · run at ${lastSummary.at}`
                  : `Run at ${lastSummary.at}`
              }
            />
          )}
        </CardContent>
      </Card>

      {/* UPC import — surface here so missing UPCs don't block validation */}
      <UpcImportCard />

      {/* Products table (client island — owns selection + sheet +
          Generate/Validate/Download actions scoped to the selection) */}
      <Card>
        <CardHeader>
          <CardTitle>Products ({totalEligible})</CardTitle>
          <CardDescription>
            Click a row to edit Claude&apos;s draft. Check rows to bulk-generate / regenerate. Pending products are pinned to the top.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ListingsTable initialRows={initialRows} />
        </CardContent>
      </Card>
    </div>
  );
}

function ReadinessRow({
  ok, label, value, sub,
}: {
  ok: boolean;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      {ok ? (
        <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-medium truncate">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}
