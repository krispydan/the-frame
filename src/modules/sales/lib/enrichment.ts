/**
 * F2-007: Enrichment Pipeline — Outscraper + AI Research
 */
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

const OUTSCRAPER_API_KEY = process.env.OUTSCRAPER_API_KEY;
const OUTSCRAPER_BASE = "https://api.app.outscraper.com";

export type EnrichmentStatus = "not_enriched" | "queued" | "enriched" | "failed";

interface OutscraperResult {
  name?: string;
  phone?: string;
  site?: string;
  email_1?: string;
  rating?: number;
  reviews?: number;
  working_hours?: Record<string, string>;
  business_status?: string;
  place_id?: string;
  full_address?: string;
}

/**
 * Get companies that need enrichment
 */
export function getCompaniesNeedingEnrichment(limit = 50): { id: string; name: string; city: string; state: string }[] {
  return sqlite.prepare(`
    SELECT id, name, city, state FROM companies
    WHERE enrichment_status = 'not_enriched'
    AND (email IS NULL OR email = '') 
    AND (phone IS NULL OR phone = '')
    AND (website IS NULL OR website = '')
    LIMIT ?
  `).all(limit) as { id: string; name: string; city: string; state: string }[];
}

/**
 * Enrich a single company via Outscraper Google Maps API
 */
export async function enrichViaOutscraper(companyId: string): Promise<{ success: boolean; error?: string }> {
  if (!OUTSCRAPER_API_KEY) {
    return { success: false, error: "OUTSCRAPER_API_KEY not set" };
  }

  const company = sqlite.prepare("SELECT id, name, city, state FROM companies WHERE id = ?").get(companyId) as {
    id: string; name: string; city: string; state: string;
  } | undefined;

  if (!company) return { success: false, error: "Company not found" };

  // Mark as queued
  sqlite.prepare("UPDATE companies SET enrichment_status = 'queued', updated_at = datetime('now') WHERE id = ?").run(companyId);

  try {
    const query = `${company.name}, ${company.city}, ${company.state}`;
    const url = new URL(`${OUTSCRAPER_BASE}/maps/search-v3`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", "1");
    url.searchParams.set("async", "false");

    const res = await fetch(url.toString(), {
      headers: { "X-API-KEY": OUTSCRAPER_API_KEY },
    });

    if (!res.ok) {
      throw new Error(`Outscraper API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const results: OutscraperResult[] = data?.data?.[0] || [];

    if (results.length === 0) {
      sqlite.prepare("UPDATE companies SET enrichment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(companyId);
      return { success: false, error: "No results found" };
    }

    const result = results[0];

    // Update company
    const updates: string[] = ["enrichment_status = 'enriched'", "updated_at = datetime('now')"];
    const vals: unknown[] = [];

    if (result.email_1) {
      updates.push("email = ?");
      vals.push(result.email_1);
    }
    if (result.phone) {
      updates.push("phone = ?");
      vals.push(result.phone);
    }
    if (result.site) {
      updates.push("website = ?");
      vals.push(result.site);
      // Extract domain
      try {
        const domain = new URL(result.site).hostname.replace("www.", "");
        updates.push("domain = ?");
        vals.push(domain);
      } catch {}
    }
    if (result.rating != null) {
      updates.push("google_rating = ?");
      vals.push(result.rating);
    }
    if (result.reviews != null) {
      updates.push("google_review_count = ?");
      vals.push(result.reviews);
    }
    if (result.place_id) {
      updates.push("google_place_id = ?");
      vals.push(result.place_id);
    }

    vals.push(companyId);
    sqlite.prepare(`UPDATE companies SET ${updates.join(", ")} WHERE id = ?`).run(...vals);

    // Log enrichment activity if there's an active deal
    const deal = sqlite.prepare("SELECT id FROM deals WHERE company_id = ? ORDER BY created_at DESC LIMIT 1").get(companyId) as { id: string } | undefined;
    if (deal) {
      sqlite.prepare(`
        INSERT INTO deal_activities (id, deal_id, company_id, type, description, metadata, created_at)
        VALUES (?, ?, ?, 'enrichment', ?, ?, datetime('now'))
      `).run(
        crypto.randomUUID(),
        deal.id,
        companyId,
        `Enriched via Outscraper: ${[result.email_1 && "email", result.phone && "phone", result.site && "website"].filter(Boolean).join(", ")}`,
        JSON.stringify(result)
      );
    }

    logger.logChange("company", companyId, "enrichment_status", "queued", "enriched", null, "agent");

    return { success: true };
  } catch (err) {
    sqlite.prepare("UPDATE companies SET enrichment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(companyId);
    logger.logError("error", "enrichment", `Failed to enrich ${company.name}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Batch enrich multiple companies
 */
export async function batchEnrich(companyIds: string[], delayMs = 1000): Promise<{ enriched: number; failed: number; errors: string[] }> {
  let enriched = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const id of companyIds) {
    const result = await enrichViaOutscraper(id);
    if (result.success) {
      enriched++;
    } else {
      failed++;
      if (result.error) errors.push(result.error);
    }
    // Rate limiting
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return { enriched, failed, errors };
}
