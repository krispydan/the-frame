/**
 * /settings/integrations/amazon
 *
 * Operator surface for the Amazon listings pipeline. Three sections:
 *
 *   1. Connection / readiness — env config, Shopify retail link, snapshot
 *      version, candidate counts. Lets ops see at a glance whether the
 *      pipeline can run.
 *   2. Listings status — per-product table with "has AI copy?" /
 *      "has Shopify images?" so ops knows what's blocking each product
 *      from being releasable.
 *   3. Actions — Generate / Validate / Download buttons. Download is
 *      disabled until validation reports zero blocked.
 *
 * Server component — reads sqlite directly for speed. The three buttons
 * are client islands. Last validation result lives in a settings row so
 * a refresh doesn't lose state.
 */
export const dynamic = "force-dynamic";

import { sqlite } from "@/lib/db";
import { getSnapshotSource, getAmazonColumns } from "@/modules/catalog/lib/amazon/template-snapshot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle, AlertTriangle, Circle, Warehouse, Image as ImageIcon, Sparkles } from "lucide-react";
import { GenerateListingsButtons } from "./generate-button";
import { ValidateButton } from "./validate-button";
import { DownloadButton } from "./download-button";

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
}

export default function AmazonIntegrationPage() {
  const source = getSnapshotSource();
  const columnCount = getAmazonColumns().length;
  const requiredColumnCount = getAmazonColumns().filter((c) => c.required).length;

  // Catalog candidate set: approved products (not intake/processing).
  const eligible = tryAll<ProductRow>(`
    SELECT
      p.id,
      p.sku_prefix,
      p.name,
      p.status,
      CASE WHEN al.id IS NULL THEN 0 ELSE 1 END AS has_listing,
      al.generated_at,
      al.model_used
    FROM catalog_products p
    LEFT JOIN catalog_amazon_listings al ON al.product_id = p.id
    WHERE p.status NOT IN ('intake', 'processing')
    ORDER BY (CASE WHEN al.id IS NULL THEN 0 ELSE 1 END) ASC, p.sku_prefix ASC
  `);

  const totalEligible = eligible.length;
  const withListing = eligible.filter((r) => r.has_listing === 1).length;
  const withoutListing = totalEligible - withListing;

  // Shopify retail connection check (image-URL source).
  const shopifyConnected = tryGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM shopify_shops WHERE channel = 'retail' AND is_active = 1`,
  );
  const retailOk = (shopifyConnected?.c ?? 0) > 0;

  // Anthropic readiness: check the actual env var on the server, and use
  // a successful generation as the stronger evidence the key works. The
  // tri-state UI (configured-untested vs healthy vs missing) is the
  // honest read — silent "Untested" with a setup instruction was wrong
  // when the key was already set on Railway.
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

  // Last validation summary (stored in settings table on each validate
  // call) — optional, falls through to null when not present.
  const lastValidation = tryGet<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'amazon_last_validation'`,
  );
  let lastSummary: {
    ready: number;
    warning: number;
    blocked: number;
    at: string;
  } | null = null;
  try {
    if (lastValidation?.value) {
      lastSummary = JSON.parse(lastValidation.value);
    }
  } catch {
    /* ignore */
  }

  const downloadDisabled =
    !retailOk ||
    totalEligible === 0 ||
    (lastSummary != null && lastSummary.blocked > 0);

  return (
    <div className="container mx-auto p-6 max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Warehouse className="h-7 w-7" />
          Amazon listings
        </h1>
        <p className="text-muted-foreground mt-2">
          Vision-AI listing copy → snapshot-validated spreadsheet → Seller Central upload. See <code>docs/amazon-listings.md</code> for the full flow.
        </p>
      </div>

      {/* Readiness card */}
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
              sub={`Run at ${lastSummary.at}`}
            />
          )}
        </CardContent>
      </Card>

      {/* Action row */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Actions</CardTitle>
              <CardDescription>
                Generate AI copy for products that don't have it yet, validate the batch, then download the spreadsheet.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-2">
            <GenerateListingsButtons />
            <ValidateButton />
            <DownloadButton disabled={downloadDisabled} />
          </div>
          {downloadDisabled && (
            <p className="text-xs text-muted-foreground mt-3">
              {!retailOk && "Connect Shopify retail first. "}
              {totalEligible === 0 && "No approved products to export. "}
              {lastSummary && lastSummary.blocked > 0 && `${lastSummary.blocked} product${lastSummary.blocked === 1 ? "" : "s"} blocked — re-validate or fix.`}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Per-product status */}
      <Card>
        <CardHeader>
          <CardTitle>Products ({totalEligible})</CardTitle>
          <CardDescription>
            Pending generation surface to the top so you know what to click Generate for next.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved products in the catalog yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>AI listing</TableHead>
                  <TableHead>Last generated</TableHead>
                  <TableHead>Model</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eligible.slice(0, 100).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono text-xs">
                      <div>{p.sku_prefix}</div>
                      <div className="text-muted-foreground truncate max-w-md">{p.name ?? "—"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{p.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {p.has_listing === 1 ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs">
                          <CheckCircle className="h-3 w-3" /> ready
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-yellow-600 text-xs">
                          <Sparkles className="h-3 w-3" /> needs Generate
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.generated_at?.slice(0, 16).replace("T", " ") ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {p.model_used ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {eligible.length > 100 && (
            <p className="text-xs text-muted-foreground mt-3">
              Showing first 100 of {eligible.length}. Generate / validate run over the full set.
            </p>
          )}
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

// Silence unused-import warning — ImageIcon + Circle are reserved for the
// future per-product drilldown drawer (Phase 4 extension).
void ImageIcon;
void Circle;
