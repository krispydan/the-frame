export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, skus, purchaseOrders } from "@/modules/catalog/schema";
import { eq, sql } from "drizzle-orm";

/**
 * Product Intake — create new products from CSV data or manual entry.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { mode, purchaseOrderId, items } = body as {
    mode: "manual" | "csv";
    purchaseOrderId?: string;
    items: {
      skuPrefix: string;
      name?: string;
      category?: string;
      factoryName?: string;
      factorySku?: string;
      wholesalePrice?: number;
      retailPrice?: number;
      variants?: {
        sku: string;
        colorName?: string;
        colorHex?: string;
        upc?: string;
        costPrice?: number;
      }[];
    }[];
  };

  if (!items?.length) {
    return NextResponse.json({ error: "items array required" }, { status: 400 });
  }

  const created: string[] = [];
  const errors: { skuPrefix: string; error: string }[] = [];

  for (const item of items) {
    try {
      // Check if product already exists
      const existing = await db.select().from(products).where(eq(products.skuPrefix, item.skuPrefix)).limit(1);
      if (existing.length > 0) {
        errors.push({ skuPrefix: item.skuPrefix, error: "Product already exists" });
        continue;
      }

      const productId = crypto.randomUUID();
      await db.insert(products).values({
        id: productId,
        skuPrefix: item.skuPrefix,
        name: item.name || null,
        category: (item.category as any) || null,
        factoryName: item.factoryName || null,
        factorySku: item.factorySku || null,
        wholesalePrice: item.wholesalePrice || null,
        retailPrice: item.retailPrice || null,
        purchaseOrderId: purchaseOrderId || null,
        status: "intake",
      });

      // Create variants
      if (item.variants?.length) {
        for (const v of item.variants) {
          await db.insert(skus).values({
            id: crypto.randomUUID(),
            productId,
            sku: v.sku,
            colorName: v.colorName || null,
            colorHex: v.colorHex || null,
            upc: v.upc || null,
            costPrice: v.costPrice || null,
            status: "intake",
          });
        }
      }

      created.push(item.skuPrefix);
    } catch (e: any) {
      errors.push({ skuPrefix: item.skuPrefix, error: e.message });
    }
  }

  return NextResponse.json({
    created: created.length,
    errors: errors.length,
    details: { created, errors },
  }, { status: 201 });
}
