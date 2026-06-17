import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/settings/test-connection
 * Body: { integration: "shopify" | "instantly" | "faire" | "klaviyo" | "outscraper" }
 * Tests the API key stored in settings and returns success/failure.
 */
export async function POST(request: NextRequest) {
  try {
    const { integration } = await request.json();

    const testers: Record<string, () => Promise<{ ok: boolean; message: string }>> = {
      shopify_dtc: async () => {
        const domain = db.select().from(settings).where(eq(settings.key, "shopify_dtc_store_domain")).get();
        const token = db.select().from(settings).where(eq(settings.key, "shopify_dtc_access_token")).get();
        if (!domain?.value || !token?.value) return { ok: false, message: "DTC store domain and access token are required" };
        const res = await fetch(`https://${domain.value}/admin/api/2024-01/shop.json`, {
          headers: { "X-Shopify-Access-Token": token.value },
        });
        if (res.ok) {
          const data = await res.json();
          return { ok: true, message: `Connected to DTC: ${data.shop?.name || domain.value}` };
        }
        return { ok: false, message: `HTTP ${res.status}: ${res.statusText}` };
      },

      shopify_wholesale: async () => {
        const domain = db.select().from(settings).where(eq(settings.key, "shopify_wholesale_store_domain")).get();
        const token = db.select().from(settings).where(eq(settings.key, "shopify_wholesale_access_token")).get();
        if (!domain?.value || !token?.value) return { ok: false, message: "Wholesale store domain and access token are required" };
        const res = await fetch(`https://${domain.value}/admin/api/2024-01/shop.json`, {
          headers: { "X-Shopify-Access-Token": token.value },
        });
        if (res.ok) {
          const data = await res.json();
          return { ok: true, message: `Connected to Wholesale: ${data.shop?.name || domain.value}` };
        }
        return { ok: false, message: `HTTP ${res.status}: ${res.statusText}` };
      },

      instantly: async () => {
        const key = db.select().from(settings).where(eq(settings.key, "instantly_api_key")).get();
        if (!key?.value) return { ok: false, message: "API key is required" };
        // Try v2 API first (Bearer token), fallback to v1
        const resV2 = await fetch("https://api.instantly.ai/api/v2/accounts", {
          headers: { Authorization: `Bearer ${key.value}` },
        });
        if (resV2.ok) return { ok: true, message: "Connected to Instantly (v2)" };
        // Fallback: v1 API key param
        const resV1 = await fetch(`https://api.instantly.ai/api/v1/authenticate?api_key=${key.value}`);
        if (resV1.ok) return { ok: true, message: "Connected to Instantly (v1)" };
        return { ok: false, message: `HTTP ${resV2.status}: Authentication failed. Check API key format.` };
      },

      klaviyo: async () => {
        const key = db.select().from(settings).where(eq(settings.key, "klaviyo_api_key")).get();
        if (!key?.value) return { ok: false, message: "API key is required" };
        const res = await fetch("https://a.klaviyo.com/api/lists/", {
          headers: { Authorization: `Klaviyo-API-Key ${key.value}`, revision: "2024-02-15" },
        });
        if (res.ok) return { ok: true, message: "Connected to Klaviyo" };
        return { ok: false, message: `HTTP ${res.status}: Authentication failed` };
      },

      outscraper: async () => {
        const key = db.select().from(settings).where(eq(settings.key, "outscraper_api_key")).get();
        if (!key?.value) return { ok: false, message: "API key is required" };
        const res = await fetch("https://api.app.outscraper.com/profile", {
          headers: { "X-API-Key": key.value },
        });
        if (res.ok) {
          const data = await res.json();
          return { ok: true, message: `Connected to Outscraper (balance: $${data.balance?.toFixed(2) || '?'})` };
        }
        return { ok: false, message: `HTTP ${res.status}: Authentication failed` };
      },

      phoneburner: async () => {
        const key = db.select().from(settings).where(eq(settings.key, "phoneburner_api_key")).get();
        if (!key?.value) return { ok: false, message: "API key is required" };
        // PB doesn't expose a /me endpoint; use a low-cost folder list
        // as the auth probe. Auth failure returns 401; bad routing 404.
        const res = await fetch("https://www.phoneburner.com/rest/1/folders?page_size=1", {
          headers: {
            Authorization: `Bearer ${key.value}`,
            Accept: "application/json",
          },
        });
        if (res.ok) return { ok: true, message: "Connected to PhoneBurner" };
        const body = await res.text().catch(() => "");
        return { ok: false, message: `HTTP ${res.status}: ${body.slice(0, 200) || "Authentication failed"}` };
      },
    };

    const tester = testers[integration];
    if (!tester) {
      return NextResponse.json({ error: `Unknown integration: ${integration}` }, { status: 400 });
    }

    const result = await tester();

    // Save validation timestamp
    const tsKey = `${integration}_validated_at`;
    db.insert(settings)
      .values({ key: tsKey, value: new Date().toISOString(), type: "string", updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: new Date().toISOString(), updatedAt: new Date().toISOString() } })
      .run();

    // Save validation result
    const resultKey = `${integration}_validation_result`;
    db.insert(settings)
      .values({ key: resultKey, value: result.ok ? "success" : "failed", type: "string", updatedAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: settings.key, set: { value: result.ok ? "success" : "failed", updatedAt: new Date().toISOString() } })
      .run();

    return NextResponse.json(result);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[settings/test-connection] error:", msg);
    return NextResponse.json({ ok: false, message: msg }, { status: 500 });
  }
}
