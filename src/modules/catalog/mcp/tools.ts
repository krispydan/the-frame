/**
 * F4-008: MCP Tools — Catalog Module
 */
import { mcpRegistry } from "@/modules/core/mcp/server";
import { sqlite } from "@/lib/db";
import { z } from "zod";
import { parseFrameSize } from "@/modules/catalog/lib/frame-size";

// ── catalog.list_products ──
mcpRegistry.register(
  "catalog.list_products",
  "List products with optional search, status filter, and pagination.",
  z.object({
    search: z.string().optional().describe("Search by name or SKU prefix"),
    status: z.string().optional().describe("Filter by status: intake, processing, review, approved, published"),
    category: z.string().optional().describe("Filter by category: sunglasses, optical, reading"),
    factory: z.string().optional().describe("Filter by factory series: JX1, JX2, JX3, JX4"),
    limit: z.number().optional().describe("Max results (default 25)"),
    offset: z.number().optional().describe("Offset for pagination"),
  }),
  async (args) => {
    const limit = Math.min(100, args.limit ?? 25);
    const offset = args.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (args.search) { clauses.push("(p.name LIKE ? OR p.sku_prefix LIKE ?)"); params.push(`%${args.search}%`, `%${args.search}%`); }
    if (args.status) { clauses.push("p.status = ?"); params.push(args.status); }
    if (args.category) { clauses.push("p.category = ?"); params.push(args.category); }
    if (args.factory) { clauses.push("p.sku_prefix LIKE ?"); params.push(`${args.factory}%`); }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

    const products = sqlite.prepare(`
      SELECT p.*, 
        (SELECT COUNT(*) FROM catalog_skus WHERE product_id = p.id) as variant_count,
        (SELECT COUNT(*) FROM catalog_images ci JOIN catalog_skus cs ON ci.sku_id = cs.id WHERE cs.product_id = p.id) as image_count
      FROM catalog_products p ${where}
      ORDER BY p.sku_prefix
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const total = sqlite.prepare(`SELECT COUNT(*) as count FROM catalog_products p ${where}`).get(...params) as { count: number };

    return { content: [{ type: "text" as const, text: JSON.stringify({ products, total: total.count, limit, offset }) }] };
  }
);

// ── catalog.get_product ──
mcpRegistry.register(
  "catalog.get_product",
  "Get detailed product info including SKUs, tags, and image stats.",
  z.object({
    id: z.string().optional().describe("Product ID"),
    skuPrefix: z.string().optional().describe("SKU prefix (e.g. JX1-001)"),
  }),
  async (args) => {
    let product;
    if (args.id) {
      product = sqlite.prepare("SELECT * FROM catalog_products WHERE id = ?").get(args.id);
    } else if (args.skuPrefix) {
      product = sqlite.prepare("SELECT * FROM catalog_products WHERE sku_prefix = ?").get(args.skuPrefix);
    } else {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "id or skuPrefix required" }) }], isError: true };
    }

    if (!product) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Product not found" }) }], isError: true };
    }

    const p = product as { id: string };
    const skus = sqlite.prepare("SELECT * FROM catalog_skus WHERE product_id = ?").all(p.id);
    const tags = sqlite.prepare("SELECT * FROM catalog_tags WHERE product_id = ?").all(p.id);
    const skuIds = (skus as { id: string }[]).map((s) => s.id);
    const imageCount = skuIds.length > 0
      ? sqlite.prepare(`SELECT COUNT(*) as count FROM catalog_images WHERE sku_id IN (${skuIds.map(() => "?").join(",")})`)
          .get(...skuIds) as { count: number }
      : { count: 0 };

    return { content: [{ type: "text" as const, text: JSON.stringify({ product, skus, tags, imageCount: imageCount.count }) }] };
  }
);

// ── catalog.update_product ──
mcpRegistry.register(
  "catalog.update_product",
  "Update product fields (name, description, pricing, status, etc).",
  z.object({
    id: z.string().describe("Product ID"),
    name: z.string().optional(),
    description: z.string().optional(),
    shortDescription: z.string().optional(),
    bulletPoints: z.string().optional(),
    category: z.string().optional(),
    wholesalePrice: z.number().optional(),
    retailPrice: z.number().optional(),
    msrp: z.number().optional(),
    status: z.string().optional().describe("intake, processing, review, approved, published"),
    // Frame dimensions in millimetres. Pass any subset. To set all at
    // once from a factory string (e.g. "51口22 145"), prefer the
    // dedicated catalog.set_frame_size tool which parses + writes
    // everything atomically.
    lensWidth: z.number().int().positive().optional().describe("Lens width (mm)"),
    bridgeWidth: z.number().int().positive().optional().describe("Bridge width (mm)"),
    templeLength: z.number().int().positive().optional().describe("Temple length (mm)"),
    lensHeight: z.number().int().positive().optional().describe("Lens height (mm) — optional"),
    frameWidth: z.number().int().positive().optional().describe("Total frame width edge-to-edge (mm) — supplied on 5-field tabular factory sheets"),
    frameSize: z.string().optional().describe("Raw factory size string, e.g. \"51口22 145\""),
  }),
  async (args) => {
    const { id, ...updates } = args;
    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = key.replace(/([A-Z])/g, "_$1").toLowerCase();
        fields.push(`${col} = ?`);
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No fields to update" }) }], isError: true };
    }

    fields.push("updated_at = datetime('now')");
    sqlite.prepare(`UPDATE catalog_products SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);

    const updated = sqlite.prepare("SELECT * FROM catalog_products WHERE id = ?").get(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ product: updated }) }] };
  }
);

// ── catalog.set_frame_size ──
// Convenience tool for the common case where a factory hands us a single
// dimension string like "51口22 145". Parses + persists all five
// dimension fields (lens_width, bridge_width, temple_length, lens_height,
// frame_size) in one call. On parse failure returns isError so the caller
// can fall back to setting individual fields via catalog.update_product.
mcpRegistry.register(
  "catalog.set_frame_size",
  "Parse a factory frame-size string (e.g. \"51口22 145\") and write all four dimensions + the raw string to the product. Accepts separators 口, x, X, ×, -, /, and whitespace.",
  z.object({
    productId: z.string().describe("Product ID"),
    raw: z.string().describe("Factory dimension string, e.g. \"51口22 145\" or \"52-20-148\""),
  }),
  async ({ productId, raw }) => {
    const parsed = parseFrameSize(raw);
    if (!parsed) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: "Couldn't parse frame size — set the four fields individually via catalog.update_product",
            raw,
          }),
        }],
        isError: true,
      };
    }

    sqlite.prepare(
      `UPDATE catalog_products
       SET lens_width = ?, bridge_width = ?, temple_length = ?, lens_height = ?, frame_width = ?, frame_size = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      parsed.lensWidth,
      parsed.bridgeWidth,
      parsed.templeLength,
      parsed.lensHeight ?? null,
      parsed.frameWidth ?? null,
      raw,
      productId,
    );

    const product = sqlite.prepare("SELECT * FROM catalog_products WHERE id = ?").get(productId);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ ok: true, parsed, product }),
      }],
    };
  },
);

// ── catalog.generate_copy ──
mcpRegistry.register(
  "catalog.generate_copy",
  "Generate AI copy for a product field (description, short_description, bullet_points, name).",
  z.object({
    productId: z.string().describe("Product ID"),
    field: z.string().describe("Field: description, short_description, bullet_points, name"),
  }),
  async (args) => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
      const res = await fetch(`${baseUrl}/api/v1/catalog/copy/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ── catalog.suggest_tags ──
mcpRegistry.register(
  "catalog.suggest_tags",
  "Get AI-suggested tags for a product.",
  z.object({
    productId: z.string().describe("Product ID"),
  }),
  async (args) => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
      const res = await fetch(`${baseUrl}/api/v1/catalog/tags/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);

// ── catalog.export ──
mcpRegistry.register(
  "catalog.export",
  "Export catalog to Shopify/Faire/Amazon CSV or validate before export.",
  z.object({
    platform: z.string().describe("Platform: shopify, faire, amazon"),
    validate: z.boolean().optional().describe("If true, validate only without generating export"),
    channel: z.string().optional().describe("For Shopify: retail or wholesale"),
    productIds: z.string().optional().describe("Comma-separated product IDs to export (default: all)"),
  }),
  async (args) => {
    try {
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
      const params = new URLSearchParams();
      if (args.validate) params.set("validate", "true");
      if (args.channel) params.set("channel", args.channel);
      if (args.productIds) params.set("ids", args.productIds);

      const res = await fetch(`${baseUrl}/api/v1/catalog/export/${args.platform}?${params}`);
      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("json")) {
        const data = await res.json();
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      } else {
        const text = await res.text();
        const lines = text.split("\n");
        return { content: [{ type: "text" as const, text: `Export generated: ${lines.length} rows for ${args.platform}. First 5 rows:\n${lines.slice(0, 5).join("\n")}` }] };
      }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: e.message }) }], isError: true };
    }
  }
);
