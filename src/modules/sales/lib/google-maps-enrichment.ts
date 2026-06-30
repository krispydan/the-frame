/**
 * Google Maps enrichment via the Apify scraper.
 *
 * Pulls a batch of companies that need phone numbers, sends their
 * "{name}, {city}, {state}" as search strings to Apify's Google Maps
 * actor, matches each returned place back to the source company
 * (using fuzzy-name + city match for safety), and writes:
 *
 *   - Phone → company_phones (via addCompanyPhone helper, source='gmaps')
 *   - Business hours → companies.business_hours (JSON)
 *   - Address → companies.address (only if currently empty)
 *   - Rating + review count → companies.google_rating, .google_review_count
 *   - Google place id → companies.google_place_id (so we never re-query)
 *   - Permanently closed → companies.status = 'not_qualified',
 *                          disqualify_reason = 'permanently_closed'
 *
 * Skips any company whose google_place_id is already set (assumes
 * we've enriched once and don't need to again — re-run with
 * `force: true` to override).
 */

import { sqlite } from "@/lib/db";
import { apifyClient, type GoogleMapsPlace } from "./apify-client";
import { addCompanyPhone } from "./company-phones";

// Search strings per Apify actor run. Reduced from 25 → 10 after
// observing intermittent 10-min timeouts on 24/25-result runs in
// the overnight cron — Apify hits a slow path with certain search
// strings that doesn't reliably finish. Smaller batches mean shorter
// individual runs and less wasted wall-clock on stuck queries.
const BATCH_SIZE = 10;

interface CandidateCompany {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
}

export interface EnrichmentResult {
  companies_attempted: number;
  phones_added: number;
  permanently_closed_marked: number;
  hours_updated: number;
  no_match: number;
  low_confidence_skipped: number;
  errors: Array<{ company_id: string; reason: string }>;
}

/**
 * Lightweight fuzzy compare — normalized Levenshtein-like ratio
 * via character-set overlap. Fast enough for hundreds of comparisons
 * per second without a dependency.
 */
function nameSimilarity(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/&/g, "and")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\b(the|a|an|co|llc|inc|ltd|company)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Token-set overlap — handles word reordering and minor noise.
  const aTok = new Set(na.split(" "));
  const bTok = new Set(nb.split(" "));
  let inter = 0;
  for (const t of aTok) if (bTok.has(t)) inter++;
  const union = aTok.size + bTok.size - inter;
  return union > 0 ? inter / union : 0;
}

function loadCohort(opts: {
  limit: number;
  tier?: string[];
  status?: string[];
  force?: boolean;
}): CandidateCompany[] {
  const wheres: string[] = [
    // In any Instantly campaign — same definition as the cohort endpoint
    `EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.company_id = c.id AND cl.instantly_lead_id IS NOT NULL)`,
    // No phone yet
    `NOT EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)`,
    // Enough location data to ask Google
    `((c.city IS NOT NULL AND TRIM(c.city) <> '' AND c.state IS NOT NULL AND TRIM(c.state) <> '') OR (c.address IS NOT NULL AND TRIM(c.address) <> ''))`,
    // Exclude dead-end statuses — never enrich a lead Sandra can't call.
    // Includes Instantly "not interested" replies (hub-and-spoke status
    // sync rolls these into companies.status = 'not_interested').
    `c.status NOT IN ('not_interested', 'ghosted', 'not_qualified', 'rejected', 'customer')`,
  ];
  if (!opts.force) {
    // Skip companies we've already attempted, regardless of outcome.
    // - google_place_id IS NOT NULL = matched, no need to re-query
    // - gmaps_enrichment_attempted_at IS NOT NULL = tried and skipped,
    //   needs human review via /enrich-via-apify/skipped before re-attempting
    wheres.push(`c.google_place_id IS NULL`);
    wheres.push(`c.gmaps_enrichment_attempted_at IS NULL`);
  }
  const params: unknown[] = [];
  if (opts.tier && opts.tier.length > 0) {
    wheres.push(`c.icp_tier IN (${opts.tier.map(() => "?").join(",")})`);
    params.push(...opts.tier);
  }
  if (opts.status && opts.status.length > 0) {
    wheres.push(`c.status IN (${opts.status.map(() => "?").join(",")})`);
    params.push(...opts.status);
  }

  const sql = `
    SELECT id, name, city, state, address
      FROM companies c
     WHERE ${wheres.join(" AND ")}
     ORDER BY c.icp_score DESC NULLS LAST
     LIMIT ?
  `;
  return sqlite.prepare(sql).all(...params, opts.limit) as CandidateCompany[];
}

function buildSearchString(c: CandidateCompany): string {
  const parts = [c.name];
  if (c.city) parts.push(c.city);
  if (c.state) parts.push(c.state);
  return parts.join(", ");
}

/**
 * Match an Apify-returned place back to the source company.
 *
 * Apify's search is already locality-filtered (we send "Name, City,
 * State" — Apify's geo-disambiguation does the heavy lifting). So the
 * matcher's only job is to catch egregious false positives.
 *
 * Acceptance (loosened 2026-06-30 after overnight data showed 451 of
 * 1000 low-confidence rejects where Apify had returned a reasonable
 * match):
 *   - sim ≥ 0.7  AND cities not explicitly different  → accept
 *   - sim ≥ 0.5  AND both cities present + exact match → accept
 *     (lower bar when city is a strong corroboration)
 *
 * Missing city on either side is treated as benign — we don't reject
 * just because our DB or Apify omitted the city field.
 *
 * Rejection cases:
 *   - sim < 0.5  → name doesn't match at all
 *   - sim < 0.7  AND no city corroboration (both present, exact match)
 *   - cities explicitly different (both present, not equal) AND sim < 0.85
 */
function matchesCompany(place: GoogleMapsPlace, company: CandidateCompany): {
  ok: boolean;
  reason: string;
  similarity: number;
} {
  const sim = nameSimilarity(place.title || "", company.name);
  const placeCity = (place.city || "").toLowerCase().trim();
  const companyCity = (company.city || "").toLowerCase().trim();
  const bothCitiesPresent = !!placeCity && !!companyCity;
  const cityMatches = bothCitiesPresent && placeCity === companyCity;
  const cityExplicitlyDifferent = bothCitiesPresent && placeCity !== companyCity;

  // Override: strong name match (0.85+) accepts regardless of city
  if (sim >= 0.85) {
    return { ok: true, reason: "matched_strong_name", similarity: sim };
  }
  // Strong city corroboration lowers the name bar
  if (cityMatches && sim >= 0.5) {
    return { ok: true, reason: "matched_name_and_city", similarity: sim };
  }
  // Otherwise: moderate name match accepted if city isn't explicitly different
  if (sim >= 0.7 && !cityExplicitlyDifferent) {
    return { ok: true, reason: "matched_moderate", similarity: sim };
  }

  if (sim < 0.5) {
    return {
      ok: false,
      reason: `name_similarity_too_low (${sim.toFixed(2)})`,
      similarity: sim,
    };
  }
  if (cityExplicitlyDifferent) {
    return {
      ok: false,
      reason: `city_mismatch (place=${placeCity}, company=${companyCity})`,
      similarity: sim,
    };
  }
  return {
    ok: false,
    reason: `name_similarity_too_low (${sim.toFixed(2)})`,
    similarity: sim,
  };
}

// Lazy-prepared statements. Top-level sqlite.prepare(...) runs at
// module-load time, which during Next.js build-phase page-data
// collection executes against a fresh in-memory DB before the boot
// block has materialized the `companies` table — same crash we hit
// in company-phones.ts and company-emails.ts. Defer until first
// call so the real DB is fully initialized.
import type { Statement } from "better-sqlite3";

let _updateCompanyStmt: Statement | null = null;
let _markClosedStmt: Statement | null = null;
let _stampAttemptStmt: Statement | null = null;

function updateCompanyStmt(): Statement {
  if (!_updateCompanyStmt) {
    // enrichment_status has a CHECK constraint limiting it to
    // ('not_enriched','queued','enriched','failed'). The provider
    // identity lives in enrichment_source — set it to 'apify_gmaps'
    // so we can distinguish from outscraper / manual / etc.
    _updateCompanyStmt = sqlite.prepare(`
      UPDATE companies
         SET google_place_id   = COALESCE(google_place_id, ?),
             google_rating     = COALESCE(google_rating, ?),
             google_review_count = COALESCE(google_review_count, ?),
             address           = COALESCE(NULLIF(address, ''), ?),
             business_hours    = COALESCE(business_hours, ?),
             enrichment_status = 'enriched',
             enrichment_source = 'apify_gmaps',
             enriched_at       = datetime('now'),
             updated_at        = datetime('now')
       WHERE id = ?
    `);
  }
  return _updateCompanyStmt;
}

function markClosedStmt(): Statement {
  if (!_markClosedStmt) {
    _markClosedStmt = sqlite.prepare(`
      UPDATE companies
         SET status = 'not_qualified',
             disqualify_reason = 'permanently_closed',
             updated_at = datetime('now')
       WHERE id = ?
    `);
  }
  return _markClosedStmt;
}

function stampAttemptStmt(): Statement {
  if (!_stampAttemptStmt) {
    _stampAttemptStmt = sqlite.prepare(`
      UPDATE companies
         SET gmaps_enrichment_attempted_at = datetime('now'),
             gmaps_skip_reason = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `);
  }
  return _stampAttemptStmt;
}

/**
 * Run an enrichment batch. Returns aggregate counts.
 *
 * Called from the admin endpoint with a configurable limit. Safe to
 * call repeatedly — already-matched companies are skipped via
 * google_place_id IS NULL.
 */
export async function enrichViaGoogleMaps(opts: {
  limit: number;
  tier?: string[];
  status?: string[];
  force?: boolean;
  dryRun?: boolean;
}): Promise<EnrichmentResult> {
  const cohort = loadCohort({
    limit: opts.limit,
    tier: opts.tier,
    status: opts.status,
    force: opts.force,
  });

  const result: EnrichmentResult = {
    companies_attempted: cohort.length,
    phones_added: 0,
    permanently_closed_marked: 0,
    hours_updated: 0,
    no_match: 0,
    low_confidence_skipped: 0,
    errors: [],
  };

  if (cohort.length === 0 || opts.dryRun) return result;

  // Record the run in apify_enrichment_runs so the operator can read
  // the result via the /runs admin endpoint instead of scrolling
  // Railway logs. Inserted only after the early-return checks so
  // we never leave a "running" row for empty/dry-run calls.
  const runId = `apify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO apify_enrichment_runs
        (id, status, limit_requested, tier_filter, status_filter,
         force_flag, dry_run, companies_attempted)
       VALUES (?, 'running', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      opts.limit,
      opts.tier ? opts.tier.join(",") : null,
      opts.status ? opts.status.join(",") : null,
      opts.force ? 1 : 0,
      0,
      cohort.length,
    );

  // Index by searchString so we can route results back to companies.
  // Multiple companies could in theory produce the same search string
  // (rare — same name in same city); the map stores the first hit
  // for now.
  for (let i = 0; i < cohort.length; i += BATCH_SIZE) {
    const batch = cohort.slice(i, i + BATCH_SIZE);
    const queries = batch.map(buildSearchString);
    const queryToCompany = new Map<string, CandidateCompany>();
    for (let j = 0; j < batch.length; j++) {
      queryToCompany.set(queries[j], batch[j]);
    }

    let places: GoogleMapsPlace[];
    try {
      places = await apifyClient.runGoogleMapsScraper(queries, {
        maxPerSearch: 1,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[gmaps-enrich] batch failed: ${reason}`);
      // Stamp each company in the failed batch so they don't keep
      // getting retried tick after tick. The skip_reason carries the
      // error so we can revisit via the /skipped review endpoint and
      // clear them with force=true if the underlying issue is fixed.
      const shortReason =
        reason.length > 200 ? reason.slice(0, 200) + "…" : reason;
      const errorReason = `batch_error: ${shortReason}`;
      for (const c of batch) {
        result.errors.push({ company_id: c.id, reason });
        stampAttemptStmt().run(errorReason, c.id);
      }
      continue;
    }

    // Build a lookup: searchString → place. Apify echoes the original
    // searchString on each returned place.
    const placeByQuery = new Map<string, GoogleMapsPlace>();
    for (const p of places) {
      if (p.searchString) placeByQuery.set(p.searchString, p);
    }

    for (const company of batch) {
      const query = buildSearchString(company);
      const place = placeByQuery.get(query);
      if (!place) {
        result.no_match++;
        stampAttemptStmt().run("no_match", company.id);
        continue;
      }
      const m = matchesCompany(place, company);
      if (!m.ok) {
        result.low_confidence_skipped++;
        stampAttemptStmt().run(m.reason, company.id);
        console.log(
          `[gmaps-enrich] skipped ${company.id} ${company.name}: ${m.reason}`,
        );
        continue;
      }
      // Match accepted — clear any previous skip reason (in case this
      // is a force=true re-run after fixing the company's name/city).
      stampAttemptStmt().run(null, company.id);

      // Phone — the prize
      if (place.phoneUnformatted || place.phone) {
        addCompanyPhone(
          company.id,
          place.phoneUnformatted || place.phone || null,
          "gmaps",
        );
        result.phones_added++;
      }

      // Permanently closed → drop from outreach
      if (place.permanentlyClosed) {
        markClosedStmt().run(company.id);
        result.permanently_closed_marked++;
      }

      // Hours as JSON
      const hoursJson = place.openingHours
        ? JSON.stringify(place.openingHours)
        : null;
      if (hoursJson) result.hours_updated++;

      updateCompanyStmt().run(
        place.placeId || null,
        place.totalScore ?? null,
        place.reviewsCount ?? null,
        place.address || null,
        hoursJson,
        company.id,
      );
    }
  }

  // Stamp completion in the runs table so the operator can read the
  // final stats via /enrich-via-apify/runs.
  sqlite
    .prepare(
      `UPDATE apify_enrichment_runs
          SET status = 'completed',
              completed_at = datetime('now'),
              phones_added = ?,
              permanently_closed_marked = ?,
              hours_updated = ?,
              no_match = ?,
              low_confidence_skipped = ?,
              errors_count = ?,
              errors_sample = ?
        WHERE id = ?`,
    )
    .run(
      result.phones_added,
      result.permanently_closed_marked,
      result.hours_updated,
      result.no_match,
      result.low_confidence_skipped,
      result.errors.length,
      result.errors.length > 0
        ? JSON.stringify(result.errors.slice(0, 5))
        : null,
      runId,
    );

  return result;
}
