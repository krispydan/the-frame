export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";

/**
 * PATCH /api/v1/integrations/shopify/{id}
 *
 * Update a shop's editable fields — display_name, channel, is_active.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (typeof body.displayName === "string") updates.displayName = body.displayName.trim();
  if (typeof body.channel === "string" && body.channel.trim()) updates.channel = body.channel.trim();
  if (typeof body.isActive === "boolean") updates.isActive = body.isActive;

  const [updated] = await db.update(shopifyShops).set(updates).where(eq(shopifyShops.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  return NextResponse.json({ ok: true, shop: updated });
}

/**
 * DELETE /api/v1/integrations/shopify/{id}
 *
 * Locally disconnect a shop (clears token + marks inactive). Does NOT
 * uninstall the app from Shopify — for that the merchant uses the
 * Shopify admin or you call the AppRevoke API.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [updated] = await db.update(shopifyShops).set({
    isActive: false,
    accessToken: "",
    uninstalledAt: new Date().toISOString(),
    lastHealthStatus: "disconnected",
  }).where(eq(shopifyShops.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
