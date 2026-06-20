/**
 * F2-007 / JAX-334: Enrichment Pipeline — Outscraper + Web Scrape Fallback
 */
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";
import { addCompanyPhone } from "./company-phones";

const OUTSCRAPER_BASE = "https://api.app.outscraper.com";

export type EnrichmentStatus = "not_enriched" | "queued" | "enriched" | "failed";

interface OutscraperResult {
  name?: string;
  phone?: string;
  site?: string;
  email_1?: string;
  email_2?: string;
  rating?: number;
  reviews?: number;
  working_hours?: Record<string, string>;
  working_hours_old_format?: string;
  business_status?: string;
  place_id?: string;
  full_address?: string;
  owner_title?: string;
  owner_name?: string;
  facebook?: string;
  instagram?: string;
  twitter?: string;
  linkedin?: string;
  yelp?: string;
}

/**
 * Get the Outscraper API key from app settings DB
 */
function getOutscraperApiKey(): string | null {
  const row = sqlite.prepare("SELECT value FROM settings WHERE key = 'outscraper_api_key'").get() as { value: string } | undefined;
  return row?.value || process.env.OUTSCRAPER_API_KEY || null;
}

/**
 * Get companies that need enrichment
 */
export function getCompaniesNeedingEnrichment(limit = 50): { id: string; name: string; city: string; state: string }[] {
  return sqlite.prepare(`
    SELECT id, name, city, state FROM companies c
    WHERE (enrichment_status IS NULL OR enrichment_status = 'not_enriched')
    AND (email IS NULL OR email = '')
    AND NOT EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)
    AND (website IS NULL OR website = '')
    LIMIT ?
  `).all(limit) as { id: string; name: string; city: string; state: string }[];
}

/**
 * Simple web scrape fallback: fetch a prospect's website and extract emails/phones/socials
 */
async function webScrapeFallback(url: string): Promise<{
  emails: string[];
  phones: string[];
  socials: { facebook?: string; instagram?: string; twitter?: string; linkedin?: string };
}> {
  const result: { emails: string[]; phones: string[]; socials: { facebook?: string; instagram?: string; twitter?: string; linkedin?: string } } = {
    emails: [], phones: [], socials: {},
  };

  try {
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; JaxyBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return result;
    const html = await res.text();

    // Extract emails
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const emails = [...new Set(html.match(emailRegex) || [])].filter(
      e => !e.endsWith(".png") && !e.endsWith(".jpg") && !e.endsWith(".gif") && !e.includes("example.com") && !e.includes("wixpress")
    );
    result.emails = emails.slice(0, 5);

    // Extract phones
    const phoneRegex = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const phones = [...new Set(html.match(phoneRegex) || [])];
    result.phones = phones.slice(0, 3);

    // Extract social links
    const fbMatch = html.match(/href=["'](https?:\/\/(?:www\.)?facebook\.com\/[^"'\s]+)["']/i);
    if (fbMatch) result.socials.facebook = fbMatch[1];
    const igMatch = html.match(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/[^"'\s]+)["']/i);
    if (igMatch) result.socials.instagram = igMatch[1];
    const twMatch = html.match(/href=["'](https?:\/\/(?:www\.)?(twitter|x)\.com\/[^"'\s]+)["']/i);
    if (twMatch) result.socials.twitter = twMatch[1];
    const liMatch = html.match(/href=["'](https?:\/\/(?:www\.)?linkedin\.com\/[^"'\s]+)["']/i);
    if (liMatch) result.socials.linkedin = liMatch[1];
  } catch {
    // Silently fail — this is a best-effort fallback
  }

  return result;
}

/**
 * Enrich a single company via Outscraper Google Maps API + web scrape fallback
 * Returns list of fields that were newly populated.
 */
export async function enrichViaOutscraper(companyId: string): Promise<{ success: boolean; error?: string; newFields?: string[] }> {
  const apiKey = getOutscraperApiKey();
  if (!apiKey) {
    return { success: false, error: "Outscraper API key not configured. Set it in Settings → Integrations." };
  }

  const company = sqlite.prepare(`
    SELECT id, name, city, state, email,
           (SELECT cp.phone FROM company_phones cp
             WHERE cp.company_id = companies.id
             ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS phone,
           website, domain,
           google_rating, google_review_count, google_place_id,
           owner_name, facebook_url, instagram_url, twitter_url, linkedin_url, yelp_url, business_hours
    FROM companies WHERE id = ?
  `).get(companyId) as Record<string, unknown> | undefined;

  if (!company) return { success: false, error: "Company not found" };

  // Mark as queued
  sqlite.prepare("UPDATE companies SET enrichment_status = 'queued', updated_at = datetime('now') WHERE id = ?").run(companyId);

  const newFields: string[] = [];

  try {
    const query = `${company.name}, ${company.city}, ${company.state}`;
    const url = new URL(`${OUTSCRAPER_BASE}/maps/search-v3`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", "1");
    url.searchParams.set("async", "false");

    const res = await fetch(url.toString(), {
      headers: { "X-API-KEY": apiKey },
    });

    if (!res.ok) {
      throw new Error(`Outscraper API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const results: OutscraperResult[] = data?.data?.[0] || [];

    if (results.length === 0) {
      sqlite.prepare("UPDATE companies SET enrichment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(companyId);
      return { success: false, error: "No results found on Google Maps" };
    }

    const r = results[0];

    // Build updates — only fill empty fields
    const updates: string[] = [];
    const vals: unknown[] = [];

    const setIfEmpty = (dbCol: string, companyKey: string, newVal: unknown) => {
      if (newVal && (!company[companyKey] || company[companyKey] === "")) {
        updates.push(`${dbCol} = ?`);
        vals.push(newVal);
        newFields.push(dbCol);
      }
    };

    setIfEmpty("email", "email", r.email_1);
    // Phone writes go to company_phones (canonical store) instead of
    // the legacy companies.phone column. addCompanyPhone is idempotent.
    if (r.phone) {
      addCompanyPhone(companyId, String(r.phone), "outscraper");
      newFields.push("phone");
    }
    setIfEmpty("website", "website", r.site);
    if (r.site && (!company.domain || company.domain === "")) {
      try {
        const domain = new URL(r.site).hostname.replace("www.", "");
        updates.push("domain = ?");
        vals.push(domain);
        newFields.push("domain");
      } catch {}
    }
    setIfEmpty("google_rating", "google_rating", r.rating);
    setIfEmpty("google_review_count", "google_review_count", r.reviews);
    setIfEmpty("google_place_id", "google_place_id", r.place_id);
    setIfEmpty("owner_name", "owner_name", r.owner_name || r.owner_title);
    setIfEmpty("facebook_url", "facebook_url", r.facebook);
    setIfEmpty("instagram_url", "instagram_url", r.instagram);
    setIfEmpty("twitter_url", "twitter_url", r.twitter);
    setIfEmpty("linkedin_url", "linkedin_url", r.linkedin);
    setIfEmpty("yelp_url", "yelp_url", r.yelp);
    
    if (r.working_hours && (!company.business_hours)) {
      updates.push("business_hours = ?");
      vals.push(JSON.stringify(r.working_hours));
      newFields.push("business_hours");
    }

    // Web scrape fallback if Outscraper didn't find email
    const hasEmail = r.email_1 || (company.email && company.email !== "");
    const websiteUrl = r.site || company.website;
    if (!hasEmail && websiteUrl) {
      const scraped = await webScrapeFallback(String(websiteUrl));
      if (scraped.emails.length > 0 && (!company.email || company.email === "")) {
        updates.push("email = ?");
        vals.push(scraped.emails[0]);
        newFields.push("email");
      }
      if (scraped.phones.length > 0 && (!company.phone || company.phone === "") && !r.phone) {
        addCompanyPhone(companyId, scraped.phones[0], "web_scrape");
        newFields.push("phone");
      }
      if (scraped.socials.facebook && !r.facebook && (!company.facebook_url || company.facebook_url === "")) {
        updates.push("facebook_url = ?"); vals.push(scraped.socials.facebook); newFields.push("facebook_url");
      }
      if (scraped.socials.instagram && !r.instagram && (!company.instagram_url || company.instagram_url === "")) {
        updates.push("instagram_url = ?"); vals.push(scraped.socials.instagram); newFields.push("instagram_url");
      }
      if (scraped.socials.twitter && !r.twitter && (!company.twitter_url || company.twitter_url === "")) {
        updates.push("twitter_url = ?"); vals.push(scraped.socials.twitter); newFields.push("twitter_url");
      }
      if (scraped.socials.linkedin && !r.linkedin && (!company.linkedin_url || company.linkedin_url === "")) {
        updates.push("linkedin_url = ?"); vals.push(scraped.socials.linkedin); newFields.push("linkedin_url");
      }
    }

    // Always set enrichment metadata
    updates.push("enrichment_status = 'enriched'");
    updates.push("enriched_at = datetime('now')");
    updates.push("enrichment_source = 'outscraper'");
    updates.push("updated_at = datetime('now')");

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
        `Enriched via Outscraper: ${newFields.join(", ") || "no new fields"}`,
        JSON.stringify(r)
      );
    }

    logger.logChange("company", companyId, "enrichment_status", "queued", "enriched", null, "agent");

    return { success: true, newFields };
  } catch (err) {
    sqlite.prepare("UPDATE companies SET enrichment_status = 'failed', updated_at = datetime('now') WHERE id = ?").run(companyId);
    logger.logError("error", "enrichment", `Failed to enrich ${company.name}: ${(err as Error).message}`);
    return { success: false, error: (err as Error).message };
  }
}

/**
 * Batch enrich multiple companies with rate limiting
 */
export async function batchEnrich(
  companyIds: string[],
  options?: { delayMs?: number; skipWithEmail?: boolean; onProgress?: (done: number, total: number, id: string, success: boolean) => void }
): Promise<{ enriched: number; failed: number; skipped: number; errors: string[]; newFieldsByCompany: Record<string, string[]> }> {
  const { delayMs = 400, skipWithEmail = false, onProgress } = options || {};
  let enriched = 0;
  let failed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const newFieldsByCompany: Record<string, string[]> = {};

  for (let i = 0; i < companyIds.length; i++) {
    const id = companyIds[i];

    // Optional: skip prospects that already have email
    if (skipWithEmail) {
      const row = sqlite.prepare("SELECT email FROM companies WHERE id = ?").get(id) as { email: string } | undefined;
      if (row?.email && row.email.trim() !== "") {
        skipped++;
        onProgress?.(i + 1, companyIds.length, id, true);
        continue;
      }
    }

    const result = await enrichViaOutscraper(id);
    if (result.success) {
      enriched++;
      if (result.newFields) newFieldsByCompany[id] = result.newFields;
    } else {
      failed++;
      if (result.error) errors.push(`${id}: ${result.error}`);
    }
    onProgress?.(i + 1, companyIds.length, id, result.success);

    // Rate limiting (~2-3/sec)
    if (delayMs > 0 && i < companyIds.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return { enriched, failed, skipped, errors, newFieldsByCompany };
}
