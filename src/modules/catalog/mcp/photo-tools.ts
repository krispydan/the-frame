/**
 * Product-photo MCP tools: bulk upload with canonical-filename routing,
 * routing dry-run, and the coverage matrix. Side-effect import —
 * importing this file registers the tools.
 *
 * These are thin doors over lib/photo-ingest.ts, shared with the
 * /api/v1/catalog/photos routes (one implementation, two front doors).
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { z } from "zod";

mcpRegistry.register(
  "catalog.photos.bulk_upload",
  "Bulk-upload product photos. Each entry routes ITSELF by canonical filename — {SKU}[-ANGLE]_{SUFFIX}.ext (JX1019-R-BLK-SIDE_SQUARE_F8F9FA.jpg → SKU JX1019-R-BLK, kind square, angle side) or {STYLE}_{suffix} for product assets (JX4011_collage.png). Handles both SKU generations + aliases, dedupes per (sku, checksum). Pass sku/kind on an entry to override routing. Returns per-file uploaded/deduped/failed. Batch ≤20 files per call (base64 payload size).",
  z.object({
    imagesJson: z.string().describe(
      "JSON array: [{fileName, base64|sourceUrl, sku?, kind?, angle?, altText?, isBest?, position?}]",
    ),
  }),
  async (args) => {
    try {
      const { ingestRoutedPhoto } = await import("@/modules/catalog/lib/photo-ingest");
      let specs: Array<Record<string, unknown>>;
      try {
        specs = JSON.parse(String(args.imagesJson));
        if (!Array.isArray(specs)) throw new Error("not an array");
      } catch (e) {
        throw new Error(`imagesJson must be a JSON array: ${e instanceof Error ? e.message : e}`);
      }
      if (specs.length > 20) throw new Error(`${specs.length} entries — max 20 per call, batch the rest`);

      const results = [];
      for (const spec of specs) {
        const fileName = String(spec.fileName ?? "");
        let bytes: Buffer | null = null;
        if (typeof spec.base64 === "string" && spec.base64) {
          bytes = Buffer.from(spec.base64, "base64");
        } else if (typeof spec.sourceUrl === "string" && spec.sourceUrl) {
          const res = await fetch(spec.sourceUrl, { headers: { "User-Agent": "Mozilla/5.0 (TheFrame photo ingest)" } });
          if (!res.ok) {
            results.push({ fileName, status: "failed", error: `Fetch → HTTP ${res.status}` });
            continue;
          }
          bytes = Buffer.from(await res.arrayBuffer());
        }
        if (!bytes || !fileName) {
          results.push({ fileName, status: "failed", error: "Need fileName and base64|sourceUrl" });
          continue;
        }
        results.push(await ingestRoutedPhoto({
          bytes,
          fileName,
          sku: typeof spec.sku === "string" ? spec.sku : undefined,
          kind: typeof spec.kind === "string" ? spec.kind : undefined,
          angle: typeof spec.angle === "string" ? spec.angle : undefined,
          altText: typeof spec.altText === "string" ? spec.altText : undefined,
          isBest: spec.isBest === true,
          position: typeof spec.position === "number" ? spec.position : undefined,
        }));
      }
      const counts = {
        uploaded: results.filter((r) => r.status === "uploaded").length,
        deduped: results.filter((r) => r.status === "deduped").length,
        failed: results.filter((r) => r.status === "failed").length,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...counts, results }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);

mcpRegistry.register(
  "catalog.photos.route_preview",
  "Dry-run the canonical-filename router: given file names (no bytes), show where each WOULD land — SKU, kind, angle — and which fail to parse or resolve. Use before a big bulk_upload to catch mis-named files cheaply. Example: preview ['JX1016-S-BLK_SQUARE_F8F9FA.jpg', 'JX4011_collage.png'].",
  z.object({
    fileNamesJson: z.string().describe("JSON array of file names"),
  }),
  async (args) => {
    try {
      const { routePhotoFileName } = await import("@/modules/catalog/lib/photo-ingest");
      const names: string[] = JSON.parse(String(args.fileNamesJson));
      if (!Array.isArray(names)) throw new Error("fileNamesJson must be a JSON array");
      const results = names.map((n) => {
        const r = routePhotoFileName(String(n));
        return r.target
          ? { fileName: n, ok: true, sku: r.target.sku, kind: r.target.kind, angle: r.target.angleSlug, productScope: r.target.productScope }
          : { fileName: n, ok: false, error: r.error };
      });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results }, null, 2),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);

mcpRegistry.register(
  "catalog.photos.coverage",
  "The product-photo coverage matrix: per SKU, which photo kinds exist (original, no_bg, white_bg, cropped, square, google_hero, lifestyle + product-scope Amazon set) and which REQUIRED kinds are missing. Product-scope assets roll up to every colourway. Filter by productId or search. Example: coverage for 'Windsor' → which colourways still lack a square.",
  z.object({
    productId: z.string().optional().describe("Limit to one product"),
    search: z.string().optional().describe("Match product name / SKU / colour"),
    missingOnly: z.boolean().optional().describe("Only SKUs missing at least one required kind"),
  }),
  async (args) => {
    try {
      const { photoCoverage } = await import("@/modules/catalog/lib/photo-ingest");
      let rows = photoCoverage({
        productId: typeof args.productId === "string" ? args.productId : undefined,
        search: typeof args.search === "string" ? args.search : undefined,
      });
      if (args.missingOnly) rows = rows.filter((r) => r.missingRequired.length > 0);
      const summary = {
        skus: rows.length,
        complete: rows.filter((r) => r.missingRequired.length === 0).length,
        missingSquare: rows.filter((r) => r.missingRequired.includes("square")).length,
      };
      // Compact per-row shape for token economy: kinds as slug:count.
      const compact = rows.map((r) => ({
        sku: r.sku,
        product: r.productName,
        kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, v]) => [k, v.count])),
        missingRequired: r.missingRequired,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify({ summary, rows: compact }, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  },
);
