export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { generateSeoForProduct } from "@/modules/catalog/lib/seo/ai-generate";

/**
 * POST /api/v1/catalog/products/{id}/generate-seo
 *
 * Generates a Google Shopping–optimised title + description via Claude.
 * Does NOT save anything. Caller (UI) shows the preview and the user
 * confirms before hitting the save-seo endpoint.
 *
 * Body: { model?: string }   // override SEO_AI_MODEL for this run
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  // Accept UUID or skuPrefix
  let product = (await db.select().from(products).where(eq(products.id, id)))[0];
  if (!product) {
    product = (await db.select().from(products).where(eq(products.skuPrefix, id)))[0];
  }
  if (!product) {
    return NextResponse.json({ error: `Product not found: ${id}` }, { status: 404 });
  }

  const result = await generateSeoForProduct(product.id, body.model);
  if (!result.output) {
    return NextResponse.json(
      { error: result.errors.join("; "), warnings: result.warnings, model: result.model },
      { status: 502 },
    );
  }

  return NextResponse.json({
    productId: product.id,
    skuPrefix: product.skuPrefix,
    productName: product.name,
    model: result.model,
    current: {
      title: product.seoTitle,
      description: product.metaDescription,
    },
    generated: result.output,
    warnings: result.warnings,
  });
}
