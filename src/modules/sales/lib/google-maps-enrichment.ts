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

// Search strings per Apify actor run. Reduced from 10 → 5 after
// observing widespread 300s timeouts on 10-place batches on
// 2026-06-30. Apify hits a slow path on certain boutique-shaped
// queries; 5 places per batch keeps each run within Apify's
// resolution window.
const BATCH_SIZE = 5;

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
 * Lightweight fuzzy name compare. Returns max of two similarity
 * signals so we catch:
 *
 *   - Token-set overlap (handles word reordering, dropped noise words)
 *   - Compressed string compare (catches "SouthernPineBoutique" vs
 *     "Southern Pine Boutique" — common when our DB stores domain-
 *     style names with no spaces)
 *
 * Both signals normalize by lowercasing, stripping & → and, removing
 * common suffixes (LLC, Inc, .com, .co, .net, Online, Shop, Store),
 * and dropping noise words.
 */
function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;

  // Step 1: tokenized normalization (word-level)
  const normWords = (s: string) =>
    s.toLowerCase()
      .replace(/\.com\b|\.co\b|\.net\b|\.org\b|\.shop\b|\.online\b/gi, " ")
      .replace(/&/g, "and")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\b(the|a|an|co|llc|inc|ltd|company|online|shop|store|boutique|.com)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  // Step 2: compressed normalization (character-level — strip all
  // non-alphanumeric, lowercase). Handles "SouthernPineBoutique" ↔
  // "Southern Pine Boutique" both collapsing to "southernpineboutique".
  // Also strips common suffixes first.
  const normCompressed = (s: string) =>
    s.toLowerCase()
      .replace(/\.com\b|\.co\b|\.net\b|\.org\b|\.shop\b|\.online\b/gi, "")
      .replace(/&/g, "and")
      .replace(/[^a-z0-9]/g, "");

  const aTokens = normWords(a);
  const bTokens = normWords(b);
  const aCompressed = normCompressed(a);
  const bCompressed = normCompressed(b);

  // Compressed exact match wins immediately
  if (aCompressed && bCompressed && aCompressed === bCompressed) return 1;

  // Substring containment after compression — strong signal that one
  // is a subset/extended-form of the other.
  if (aCompressed && bCompressed) {
    const shorter = aCompressed.length < bCompressed.length ? aCompressed : bCompressed;
    const longer = aCompressed.length < bCompressed.length ? bCompressed : aCompressed;
    if (shorter.length >= 5 && longer.includes(shorter)) {
      // Score based on length ratio — longer overlap = stronger match
      const ratio = shorter.length / longer.length;
      // Floor at 0.7 so substring containment always passes the
      // "matched_moderate" threshold (sim ≥ 0.7) when there's any
      // city info; the caller's matcher logic handles edge cases.
      return Math.max(0.7, ratio);
    }
  }

  // Token-set overlap fallback (handles word reordering, dropped
  // noise words)
  if (!aTokens || !bTokens) return 0;
  if (aTokens === bTokens) return 1;
  const aTok = new Set(aTokens.split(" ").filter(Boolean));
  const bTok = new Set(bTokens.split(" ").filter(Boolean));
  if (aTok.size === 0 || bTok.size === 0) return 0;
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
    //
    // Name update behavior: when Apify returns a canonical title
    // (e.g. "Southern Pine Boutique" vs our scraper's
    // "SouthernPineBoutique"), adopt the Google-formatted name.
    // Stash the pre-update name in original_name on first update
    // (COALESCE — only stamped once) so the original is preserved.
    // The caller passes nameToUse — null/empty preserves the
    // existing name.
    _updateCompanyStmt = sqlite.prepare(`
      UPDATE companies
         SET original_name     = COALESCE(original_name, name),
             name              = COALESCE(NULLIF(?, ''), name),
             google_place_id   = COALESCE(google_place_id, ?),
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

let _logMatchStmt: Statement | null = null;
function logMatchStmt(): Statement {
  if (!_logMatchStmt) {
    _logMatchStmt = sqlite.prepare(`
      INSERT INTO apify_match_log (
        id, company_id, run_id, search_string,
        company_name, company_city, company_state,
        apify_title, apify_address, apify_city, apify_state,
        apify_phone, apify_place_id, apify_rating, apify_review_count,
        apify_permanently_closed, apify_temporarily_closed, apify_url,
        similarity_score, decision, decision_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  return _logMatchStmt;
}

function logMatch(args: {
  companyId: string;
  runId: string | null;
  searchString: string;
  company: CandidateCompany;
  place: GoogleMapsPlace | null;
  similarity: number;
  decision: "accepted" | "skipped" | "marked_closed" | "no_match";
  decisionReason: string;
}): void {
  // Wrap in try/catch so a logging failure never crashes the
  // enrichment run. Observed 2026-06-30: a logMatch crash silently
  // stranded multiple runs in 'running' status because the function
  // bailed out before reaching the completion stamp.
  try {
    const p = args.place;
    logMatchStmt().run(
      `m_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      args.companyId,
      args.runId,
      args.searchString,
      args.company.name,
      args.company.city,
      args.company.state,
      p?.title ?? null,
      p?.address ?? null,
      p?.city ?? null,
      p?.state ?? null,
      p?.phone || p?.phoneUnformatted || null,
      p?.placeId ?? null,
      p?.totalScore != null ? Number(p.totalScore) : null,
      p?.reviewsCount != null ? Number(p.reviewsCount) : null,
      p?.permanentlyClosed ? 1 : 0,
      p?.temporarilyClosed ? 1 : 0,
      p?.url ?? null,
      args.similarity,
      args.decision,
      args.decisionReason,
    );
  } catch (e) {
    console.error(
      `[gmaps-enrich] logMatch failed for company ${args.companyId}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
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

  // Track whether we reached normal completion so the finally block
  // can stamp the runs table correctly even if something throws.
  let crashed: Error | null = null;

  try {
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
        // Log batch errors so they show up in the match-log CSV
        // alongside no_match / skipped / accepted rows.
        logMatch({
          companyId: c.id,
          runId,
          searchString: buildSearchString(c),
          company: c,
          place: null,
          similarity: 0,
          decision: "no_match",
          decisionReason: errorReason,
        });
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
        logMatch({
          companyId: company.id,
          runId,
          searchString: query,
          company,
          place: null,
          similarity: 0,
          decision: "no_match",
          decisionReason: "apify_returned_no_place_for_this_query",
        });
        continue;
      }

      // Detect degenerate Apify output: when it can't find the
      // specific business it sometimes returns just the city name
      // ("Lubbock", "Jackson"). Reclassify these as no_match — they
      // contain no actionable data, and treating them as low-conf
      // skips would mark companies as "tried" when really Apify
      // had nothing for them.
      const placeTitleLower = (place.title || "").toLowerCase().trim();
      const companyCityLower = (company.city || "").toLowerCase().trim();
      const placeAddress = (place.address || "").trim();
      const looksLikeCity =
        !!placeTitleLower &&
        !!companyCityLower &&
        (placeTitleLower === companyCityLower ||
          placeTitleLower.includes(companyCityLower)) &&
        !placeAddress; // real businesses always have an address
      if (looksLikeCity) {
        result.no_match++;
        stampAttemptStmt().run(
          `apify_returned_city_only (got '${placeTitleLower}')`,
          company.id,
        );
        logMatch({
          companyId: company.id,
          runId,
          searchString: query,
          company,
          place,
          similarity: 0,
          decision: "no_match",
          decisionReason: `apify_returned_city_only (got '${placeTitleLower}')`,
        });
        continue;
      }
      const m = matchesCompany(place, company);

      // Permanently-closed is a binary signal — worth catching even
      // when the matcher rejected the place for normal data acceptance.
      // Apify's permanentlyClosed flag is high-trust; if Apify says it's
      // closed AND there's at least weak name resemblance (sim ≥ 0.5),
      // mark the company closed so Sandra doesn't waste a call.
      if (place.permanentlyClosed && m.similarity >= 0.5) {
        markClosedStmt().run(company.id);
        result.permanently_closed_marked++;
        stampAttemptStmt().run(
          m.ok ? null : `${m.reason} (but marked closed)`,
          company.id,
        );
        logMatch({
          companyId: company.id,
          runId,
          searchString: query,
          company,
          place,
          similarity: m.similarity,
          decision: "marked_closed",
          decisionReason: m.ok
            ? `${m.reason} + permanently_closed`
            : `${m.reason} (low-conf but permanently_closed)`,
        });
        if (!m.ok) continue;
      }

      if (!m.ok) {
        result.low_confidence_skipped++;
        stampAttemptStmt().run(m.reason, company.id);
        logMatch({
          companyId: company.id,
          runId,
          searchString: query,
          company,
          place,
          similarity: m.similarity,
          decision: "skipped",
          decisionReason: m.reason,
        });
        console.log(
          `[gmaps-enrich] skipped ${company.id} ${company.name}: ${m.reason}`,
        );
        continue;
      }
      // Match accepted — clear any previous skip reason (in case this
      // is a force=true re-run after fixing the company's name/city).
      stampAttemptStmt().run(null, company.id);
      logMatch({
        companyId: company.id,
        runId,
        searchString: query,
        company,
        place,
        similarity: m.similarity,
        decision: "accepted",
        decisionReason: m.reason,
      });

      // Phone — the prize
      if (place.phoneUnformatted || place.phone) {
        addCompanyPhone(
          company.id,
          place.phoneUnformatted || place.phone || null,
          "gmaps",
        );
        result.phones_added++;
      }

      // Note: permanently_closed handling now lives ABOVE the
      // matcher-reject check so we catch it even for low-confidence
      // matches. The marker is set there and not re-set here.

      // Hours as JSON
      const hoursJson = place.openingHours
        ? JSON.stringify(place.openingHours)
        : null;
      if (hoursJson) result.hours_updated++;

      // Adopt Apify's canonical title as the new company name when:
      //   - place.title is non-empty
      //   - AND the names differ in something more than just casing
      //     or whitespace (avoid pointless writes for identical names)
      // Only runs on accepted matches because the match-acceptance
      // gate above already confirmed this place corresponds to our
      // company. Stash the original name in companies.original_name
      // (handled by COALESCE in the prepared statement).
      const apifyTitle = String(place.title || "").trim();
      const compress = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      const nameDiffersMeaningfully =
        apifyTitle.length > 0 &&
        compress(apifyTitle) !== "" &&
        compress(apifyTitle) !== compress(company.name);
      // Pass empty string to skip the name update (NULLIF in the
      // prepared statement preserves the existing name).
      const nameToWrite = nameDiffersMeaningfully ? apifyTitle : "";

      updateCompanyStmt().run(
        nameToWrite,
        place.placeId || null,
        place.totalScore ?? null,
        place.reviewsCount ?? null,
        place.address || null,
        hoursJson,
        company.id,
      );
    }
  }
  } catch (e) {
    crashed = e instanceof Error ? e : new Error(String(e));
    console.error(`[gmaps-enrich] run ${runId} crashed:`, crashed.message);
  } finally {
    // ALWAYS stamp the runs row so it never strands in 'running'.
    // status = 'failed' if we crashed; 'completed' otherwise.
    sqlite
      .prepare(
        `UPDATE apify_enrichment_runs
            SET status = ?,
                completed_at = datetime('now'),
                phones_added = ?,
                permanently_closed_marked = ?,
                hours_updated = ?,
                no_match = ?,
                low_confidence_skipped = ?,
                errors_count = ?,
                errors_sample = ?,
                error_message = ?
          WHERE id = ?`,
      )
      .run(
        crashed ? "failed" : "completed",
        result.phones_added,
        result.permanently_closed_marked,
        result.hours_updated,
        result.no_match,
        result.low_confidence_skipped,
        result.errors.length,
        result.errors.length > 0
          ? JSON.stringify(result.errors.slice(0, 5))
          : null,
        crashed ? crashed.message.slice(0, 500) : null,
        runId,
      );
  }

  return result;
}
