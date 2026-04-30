export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { xeroAdminFetch } from "@/modules/finance/lib/xero-client";

/**
 * GET /api/v1/integrations/xero/tracking-categories
 *
 * Fetches tracking categories defined in the connected Xero tenant.
 * Each category has an array of options (e.g. "Sales Channel" -> Faire,
 * Shopify - Retail, Shopify - Wholesale).
 *
 * Used by the mapping UI to populate per-platform tracking pickers.
 *
 * Response:
 *   {
 *     categories: [
 *       {
 *         categoryId, name, status,
 *         options: [{ optionId, name, status }, ...]
 *       }, ...
 *     ]
 *   }
 */
export async function GET() {
  try {
    const result = await xeroAdminFetch("/api.xro/2.0/TrackingCategories");
    if (!result.success) {
      return NextResponse.json({
        error: result.error || "Failed to fetch tracking categories",
        hint: /401|403|forbidden|unauthor/i.test(result.error || "")
          ? "Reconnect Xero — your current token may be missing the accounting.settings.read scope."
          : undefined,
      }, { status: 502 });
    }

    type XeroOption = { TrackingOptionID: string; Name: string; Status: string };
    type XeroCategory = { TrackingCategoryID: string; Name: string; Status: string; Options?: XeroOption[] };

    const raw = (result.data as { TrackingCategories?: XeroCategory[] })?.TrackingCategories || [];
    const categories = raw
      .filter((c) => c.Status === "ACTIVE")
      .map((c) => ({
        categoryId: c.TrackingCategoryID,
        name: c.Name,
        status: c.Status,
        options: (c.Options || [])
          .filter((o) => o.Status === "ACTIVE")
          .map((o) => ({
            optionId: o.TrackingOptionID,
            name: o.Name,
            status: o.Status,
          })),
      }));

    return NextResponse.json({ categories });
  } catch (e) {
    console.error("[xero/tracking-categories] route threw:", e);
    return NextResponse.json({
      error: `Internal error: ${e instanceof Error ? e.message : "Unknown error"}`,
    }, { status: 500 });
  }
}
