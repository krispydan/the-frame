export const dynamic = "force-dynamic";
// 100 domains/call × ~2s avg per StoreLeads bulk = ~10s for 50 leads,
// up to ~60s for 500. Cap below at MAX_PER_CALL to stay under the
// Cloudflare edge budget regardless.
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  bulkGetStoresByDomain,
  isConfigured as storeleadsConfigured,
} from "@/modules/sales/lib/storeleads/client";
import { mapStoreLeadsToCompanyFields } from "@/modules/sales/lib/storeleads/customer-sync";

const MAX_PER_CALL = 500;
const DEFAULT_LIMIT = 50;

/**
 * Apex domains for sites that host LISTINGS, not ecom merchants —
 * StoreLeads doesn't index any of these so sending them is pure
 * API-credit waste. Match is case-insensitive and applied with a
 * `www.` strip; any company.domain whose apex equals one of these
 * is excluded from the enrichment candidates AND marked attempted
 * (so it can't sneak back in next run).
 *
 * Maintained inline rather than in a config table because the list
 * is small, slow-moving, and Daniel will want to grep it when a
 * domain shows up unexpectedly. Add freely as new junk surfaces.
 */
const JUNK_DOMAINS = new Set([
  // Social
  "facebook.com", "fb.com", "m.facebook.com",
  "instagram.com",
  "twitter.com", "x.com",
  "linkedin.com",
  "pinterest.com",
  "tiktok.com",
  "youtube.com", "youtu.be",
  "reddit.com",
  "threads.net",
  // Review / directory
  "yelp.com", "m.yelp.com", "biz.yelp.com",
  "yellowpages.com", "yp.com",
  "foursquare.com",
  "mapquest.com",
  "tripadvisor.com",
  "google.com", "maps.google.com",
  "bing.com",
  "bizapedia.com",
  "dnb.com",
  "manta.com",
  "bbb.org",
  "nextdoor.com",
  // Sitebuilder root domains (legit customer sites live on subdomains,
  // but a raw e.g. "wixsite.com" usually means we scraped the builder
  // homepage by mistake)
  "wixsite.com", "wix.com",
  "weebly.com",
  "godaddysites.com",
  "squarespace.com",
  "webador.com",
  "jimdosite.com",
  "site123.me",
  // Misc generic
  "yahoo.com",
  "gmail.com",
  "hotmail.com",
  "wordpress.com",
  "blogspot.com",
]);

/** Strip www., lowercase, trim. Returns the apex match key we test
 *  against JUNK_DOMAINS. */
function junkKey(d: string | null | undefined): string {
  if (!d) return "";
  return String(d).trim().toLowerCase().replace(/^www\./, "");
}

function isJunkDomain(d: string | null | undefined): boolean {
  return JUNK_DOMAINS.has(junkKey(d));
}

/**
 * POST /api/v1/integrations/storeleads/enrich-no-email
 *
 * Walk every company in the CRM that has a domain but no email, send
 * its domain to StoreLeads' bulk lookup, and fill in email + phone +
 * description + meta_description + sales/visits/socials/etc — all via
 * COALESCE so existing values never get overwritten.
 *
 * Default limit is 50 so Daniel can pilot the response shape before
 * unleashing it on thousands of rows. Loop the endpoint client-side
 * until `remaining` hits 0 for a full pass.
 *
 * Body (all optional):
 *   {
 *     limit?: number    // 1..500 (default 50). For the first test
 *                       // run, leave at the default.
 *     dryRun?: boolean  // skip the StoreLeads call entirely, just
 *                       // return the list of candidates that WOULD
 *                       // be sent.
 *     sourceType?: string  // restrict to a single source_type (e.g.
 *                          // 'storeleads', 'outscraper'). Default:
 *                          // any.
 *   }
 *
 * Returns:
 *   {
 *     ok, scanned, gotEmail, gotPhone, gotDescription, gotMeta,
 *     gotPhoneOnly, notFoundInStoreLeads, errors,
 *     sample: [{ domain, fields }], remaining
 *   }
 */
export async function POST(req: NextRequest) {
  if (!storeleadsConfigured()) {
    return NextResponse.json(
      { ok: false, error: "STORELEADS_API_KEY not configured" },
      { status: 400 },
    );
  }

  let body: { limit?: number; dryRun?: boolean; sourceType?: string } = {};
  try { body = await req.json(); } catch { /* ok */ }

  const limit = Math.max(1, Math.min(MAX_PER_CALL, body.limit ?? DEFAULT_LIMIT));

  // Track which companies we've already attempted via this enrichment
  // path so a re-run doesn't waste API calls on the same nulls. Idempotent
  // ALTER — first call after deploy adds the column, subsequent calls
  // skip.
  try {
    sqlite.exec(
      "ALTER TABLE companies ADD COLUMN storeleads_no_email_attempted_at TEXT",
    );
  } catch { /* exists */ }

  // One-time pre-pass per request: mark every no-email row whose
  // domain is a known junk site (Facebook, Yelp, etc.) as already
  // attempted so it falls out of the candidate set and won't waste
  // a StoreLeads bulk slot on a guaranteed miss. Idempotent — re-
  // running just no-ops on rows already stamped.
  const junkPh = Array.from(JUNK_DOMAINS).map(() => "?").join(",");
  const junkMarked = sqlite.prepare(
    `UPDATE companies
        SET storeleads_no_email_attempted_at = COALESCE(storeleads_no_email_attempted_at, ?),
            updated_at = ?
      WHERE (email IS NULL OR TRIM(email) = '')
        AND domain IS NOT NULL AND TRIM(domain) != ''
        AND LOWER(REPLACE(domain, 'www.', '')) IN (${junkPh})`,
  ).run(new Date().toISOString(), new Date().toISOString(),
        ...Array.from(JUNK_DOMAINS));

  const where: string[] = [
    "(c.email IS NULL OR TRIM(c.email) = '')",
    "c.domain IS NOT NULL AND TRIM(c.domain) != ''",
    "c.storeleads_no_email_attempted_at IS NULL",
  ];
  const params: unknown[] = [];
  if (body.sourceType) {
    where.push("c.source_type = ?");
    params.push(body.sourceType);
  }
  const whereSql = `WHERE ${where.join(" AND ")}`;

  // Count remaining BEFORE doing the limit-bounded select so the caller
  // can plan how many loops they need.
  const remainingBefore = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM companies c ${whereSql}`,
  ).get(...params) as { c: number }).c;

  // Prefer hottest leads first if ICP is set, so a small pilot tests
  // the rows we actually care about. Over-fetch slightly + filter
  // any junk-domain stragglers the SQL `LOWER(REPLACE(...))` missed
  // (subdomains like `m.yelp.com/biz/...` won't match a literal
  // 'yelp.com' apex check). Stamp those stragglers attempted in the
  // same pass so they don't reappear.
  const rawCandidates = sqlite.prepare(
    `SELECT c.id, c.name, c.domain
       FROM companies c
       ${whereSql}
      ORDER BY COALESCE(c.icp_score, -1) DESC, c.created_at ASC
      LIMIT ?`,
  ).all(...params, Math.min(MAX_PER_CALL, limit * 2)) as Array<{
    id: string; name: string; domain: string;
  }>;

  const stampJunk = sqlite.prepare(
    `UPDATE companies SET storeleads_no_email_attempted_at = ?, updated_at = ?
       WHERE id = ?`,
  );
  let junkStragglers = 0;
  const candidates: Array<{ id: string; name: string; domain: string }> = [];
  const now0 = new Date().toISOString();
  for (const c of rawCandidates) {
    if (isJunkDomain(c.domain)) {
      stampJunk.run(now0, now0, c.id);
      junkStragglers++;
      continue;
    }
    candidates.push(c);
    if (candidates.length >= limit) break;
  }

  if (candidates.length === 0) {
    return NextResponse.json({
      ok: true, scanned: 0, gotEmail: 0, gotPhone: 0, gotDescription: 0,
      gotMeta: 0, notFoundInStoreLeads: 0, errors: [],
      sample: [], remaining: Math.max(0, remainingBefore - junkStragglers),
      junkExcluded: junkMarked.changes + junkStragglers,
    });
  }

  if (body.dryRun) {
    return NextResponse.json({
      ok: true, dryRun: true, scanned: candidates.length,
      remaining: Math.max(0, remainingBefore - junkStragglers),
      junkExcluded: junkMarked.changes + junkStragglers,
      sample: candidates.slice(0, 10),
    });
  }

  // StoreLeads bulk takes up to 100 per request. Our cap (500) =
  // up to 5 sequential bulk calls per route invocation.
  const BATCH = 100;
  const stats = {
    scanned: candidates.length,
    gotEmail: 0,
    gotPhone: 0,
    gotDescription: 0,
    gotMeta: 0,
    notFoundInStoreLeads: 0,
    errors: [] as Array<{ domain: string; message: string }>,
    sample: [] as Array<Record<string, unknown>>,
  };

  // Same merge SQL the customer-sync flow uses. COALESCE everywhere
  // means an enrichment NEVER clobbers a value already on the row —
  // only fills nulls. Plus stamp the attempt timestamp so a second
  // call ignores rows StoreLeads couldn't fill in either.
  const updateStmt = sqlite.prepare(
    `UPDATE companies
        SET storeleads_id                  = COALESCE(storeleads_id, ?),
            storeleads_last_synced_at      = ?,
            category                       = COALESCE(category, ?),
            industry                       = COALESCE(industry, ?),
            estimated_yearly_sales_cents   = COALESCE(estimated_yearly_sales_cents, ?),
            estimated_monthly_visits       = COALESCE(estimated_monthly_visits, ?),
            average_product_price_cents    = COALESCE(average_product_price_cents, ?),
            employee_count                 = COALESCE(employee_count, ?),
            ecom_platform                  = COALESCE(ecom_platform, ?),
            facebook_url                   = COALESCE(facebook_url, ?),
            instagram_url                  = COALESCE(instagram_url, ?),
            tiktok_url                     = COALESCE(tiktok_url, ?),
            tiktok_followers               = COALESCE(tiktok_followers, ?),
            youtube_url                    = COALESCE(youtube_url, ?),
            youtube_followers              = COALESCE(youtube_followers, ?),
            phone                          = COALESCE(phone, ?),
            email                          = COALESCE(email, ?),
            description                    = COALESCE(description, ?),
            meta_description               = COALESCE(meta_description, ?),
            storeleads_no_email_attempted_at = ?,
            updated_at                     = ?
      WHERE id = ?`,
  );

  for (let i = 0; i < candidates.length; i += BATCH) {
    const chunk = candidates.slice(i, i + BATCH);
    const domains = chunk.map((c) => c.domain);
    try {
      const map = await bulkGetStoresByDomain(domains, {
        followRedirects: true,
      });
      const now = new Date().toISOString();
      const txn = sqlite.transaction(() => {
        for (const c of chunk) {
          const sl = map[c.domain.toLowerCase()];
          if (!sl) {
            // StoreLeads doesn't know this domain. Stamp the attempt
            // so we don't ask again next call — caller can clear
            // storeleads_no_email_attempted_at to retry later.
            updateStmt.run(
              null, now, null, null, null, null, null, null, null,
              null, null, null, null, null, null, null, null, null, null,
              now, now, c.id,
            );
            stats.notFoundInStoreLeads++;
            continue;
          }
          try {
            const fields = mapStoreLeadsToCompanyFields(sl);
            updateStmt.run(
              fields.storeleadsId, now,
              fields.category, fields.industry,
              fields.estimatedYearlySalesCents,
              fields.estimatedMonthlyVisits,
              fields.averageProductPriceCents,
              fields.employeeCount, fields.ecomPlatform,
              fields.facebookUrl, fields.instagramUrl,
              fields.tiktokUrl, fields.tiktokFollowers,
              fields.youtubeUrl, fields.youtubeFollowers,
              fields.phone, fields.email,
              fields.description, fields.metaDescription,
              now, now, c.id,
            );
            if (fields.email) stats.gotEmail++;
            if (fields.phone) stats.gotPhone++;
            if (fields.description) stats.gotDescription++;
            if (fields.metaDescription) stats.gotMeta++;

            // Keep the first 5 enriched rows as a sample blob — gives
            // Daniel a quick look at the response shape from the pilot
            // 50-lead run without trawling the DB.
            if (stats.sample.length < 5) {
              stats.sample.push({
                domain: c.domain,
                name: c.name,
                email: fields.email,
                phone: fields.phone,
                ecom_platform: fields.ecomPlatform,
                category: fields.category,
                industry: fields.industry,
                description: fields.description?.slice(0, 200),
                meta_description: fields.metaDescription?.slice(0, 200),
                estimated_yearly_sales_cents: fields.estimatedYearlySalesCents,
                estimated_monthly_visits: fields.estimatedMonthlyVisits,
              });
            }
          } catch (e) {
            stats.errors.push({
              domain: c.domain,
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
      });
      txn();
    } catch (e) {
      // Whole batch failed (rate limit, network, auth). Don't stamp
      // attempted_at on these — they should retry next call.
      stats.errors.push({
        domain: `(batch ${i}-${i + chunk.length})`,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    ...stats,
    junkExcluded: junkMarked.changes + junkStragglers,
    remaining: Math.max(0, remainingBefore - candidates.length - junkStragglers),
  });
}
