export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { apifyClient } from "@/modules/sales/lib/apify-client";

/**
 * POST /api/admin/sales/enrich-via-apify/preview
 *
 * Dry-run preview of what the enrichment would decide for a small
 * sample. Calls Apify ONCE for a batch of search strings, then for
 * each result runs the matcher and returns the decision — without
 * writing ANY data (no company_phones, no companies.status changes,
 * no apify_match_log rows, no skip stamps).
 *
 * Lets you validate matcher tuning before unleashing the cron on
 * the full cohort. Cost is one small Apify run (~$0.05).
 *
 * Body — pass ONE of:
 *   { company_ids: ["abc","def"] }
 *       Run on specific companies (great for known cases — pull
 *       a row from the skip log and test what it would now decide).
 *
 *   { searches: [{name, city, state}, ...] }
 *       Run on arbitrary search strings — no DB row needed. Useful
 *       for testing edge cases like 'SouthernPineBoutique' vs
 *       'Southern Pine Boutique'.
 *
 *   { limit: 20, tier?: "A,B" }
 *       Random sample of N companies from the cohort.
 *
 * Hard limit: 5 inputs per call (Apify is occasionally slow; bigger
 * batches hit Cloudflare's ~100s edge timeout). To test more than 5
 * cases, run multiple preview calls back-to-back.
 *
 * Returns: a structured comparison for each input — what we asked,
 * what Apify returned, the similarity score, and the matcher's
 * decision (accepted | skipped | marked_closed | no_match).
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: {
    company_ids?: string[];
    searches?: Array<{ name: string; city?: string; state?: string }>;
    limit?: number;
    tier?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body fine */
  }

  // Resolve the inputs to a list of {name, city, state, company_id?}
  type Input = {
    name: string;
    city: string | null;
    state: string | null;
    company_id: string | null;
  };
  let inputs: Input[] = [];

  if (Array.isArray(body.company_ids) && body.company_ids.length > 0) {
    const ids = body.company_ids.slice(0, 5);
    const placeholders = ids.map(() => "?").join(",");
    inputs = (
      sqlite
        .prepare(
          `SELECT id, name, city, state FROM companies WHERE id IN (${placeholders})`,
        )
        .all(...ids) as Array<{
        id: string;
        name: string;
        city: string | null;
        state: string | null;
      }>
    ).map((r) => ({
      company_id: r.id,
      name: r.name,
      city: r.city,
      state: r.state,
    }));
  } else if (Array.isArray(body.searches) && body.searches.length > 0) {
    inputs = body.searches.slice(0, 5).map((s) => ({
      company_id: null,
      name: String(s.name || ""),
      city: s.city ? String(s.city) : null,
      state: s.state ? String(s.state) : null,
    }));
  } else {
    // Random cohort sample
    const limit = Math.min(5, Math.max(1, body.limit ?? 5));
    const tier = body.tier
      ? body.tier.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
      : null;
    const tierClause =
      tier && tier.length > 0
        ? `AND c.icp_tier IN (${tier.map(() => "?").join(",")})`
        : "";
    const tierParams = tier ?? [];

    inputs = (
      sqlite
        .prepare(
          `SELECT c.id, c.name, c.city, c.state FROM companies c
            WHERE EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.company_id = c.id AND cl.instantly_lead_id IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM company_phones cp WHERE cp.company_id = c.id)
              AND ((c.city IS NOT NULL AND TRIM(c.city) <> '' AND c.state IS NOT NULL AND TRIM(c.state) <> '') OR (c.address IS NOT NULL AND TRIM(c.address) <> ''))
              AND c.status NOT IN ('not_interested','ghosted','not_qualified','rejected','customer')
              ${tierClause}
            ORDER BY RANDOM()
            LIMIT ?`,
        )
        .all(...tierParams, limit) as Array<{
        id: string;
        name: string;
        city: string | null;
        state: string | null;
      }>
    ).map((r) => ({
      company_id: r.id,
      name: r.name,
      city: r.city,
      state: r.state,
    }));
  }

  if (inputs.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no inputs resolved — check company_ids/searches/limit" },
      { status: 400 },
    );
  }

  // Build search strings + remember mapping
  const queries = inputs.map((i) => {
    const parts = [i.name];
    if (i.city) parts.push(i.city);
    if (i.state) parts.push(i.state);
    return parts.join(", ");
  });
  const queryToInput = new Map<string, Input>();
  for (let i = 0; i < inputs.length; i++) queryToInput.set(queries[i], inputs[i]);

  // ONE Apify call with a short timeout so we return partial results
  // within Cloudflare's ~100s edge window. 85s leaves a buffer for
  // the response payload to come back through. The Apify actor
  // returns whatever it's resolved when its timeout fires, so
  // partial results are fine for preview.
  let places;
  try {
    places = await apifyClient.runGoogleMapsScraper(queries, {
      maxPerSearch: 1,
      timeoutSecs: 85,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "Apify call failed",
        message: e instanceof Error ? e.message : String(e),
        inputs_attempted: inputs.length,
      },
      { status: 502 },
    );
  }

  // Re-import the helpers we need for the dry-run match (without
  // touching the DB). nameSimilarity + matchesCompany live in
  // google-maps-enrichment.ts but they're internal — we duplicate
  // the LOGIC here to keep this endpoint side-effect-free and
  // import-safe at build time.
  //
  // Source of truth: keep these in sync with
  // src/modules/sales/lib/google-maps-enrichment.ts. If matcher
  // tuning lands there, mirror it here too. (A small price for
  // a side-effect-free preview.)
  const nameSimilarity = (a: string, b: string): number => {
    if (!a || !b) return 0;
    const normWords = (s: string) =>
      s.toLowerCase()
        .replace(/\.com\b|\.co\b|\.net\b|\.org\b|\.shop\b|\.online\b/gi, " ")
        .replace(/&/g, "and")
        .replace(/[^a-z0-9 ]/g, " ")
        .replace(
          /\b(the|a|an|co|llc|inc|ltd|company|online|shop|store|boutique)\b/g,
          " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    const normCompressed = (s: string) =>
      s.toLowerCase()
        .replace(/\.com\b|\.co\b|\.net\b|\.org\b|\.shop\b|\.online\b/gi, "")
        .replace(/&/g, "and")
        .replace(/[^a-z0-9]/g, "");
    const aTokens = normWords(a);
    const bTokens = normWords(b);
    const aCompressed = normCompressed(a);
    const bCompressed = normCompressed(b);
    if (aCompressed && bCompressed && aCompressed === bCompressed) return 1;
    if (aCompressed && bCompressed) {
      const shorter =
        aCompressed.length < bCompressed.length ? aCompressed : bCompressed;
      const longer =
        aCompressed.length < bCompressed.length ? bCompressed : aCompressed;
      if (shorter.length >= 5 && longer.includes(shorter)) {
        const ratio = shorter.length / longer.length;
        return Math.max(0.7, ratio);
      }
    }
    if (!aTokens || !bTokens) return 0;
    if (aTokens === bTokens) return 1;
    const aTok = new Set(aTokens.split(" ").filter(Boolean));
    const bTok = new Set(bTokens.split(" ").filter(Boolean));
    if (aTok.size === 0 || bTok.size === 0) return 0;
    let inter = 0;
    for (const t of aTok) if (bTok.has(t)) inter++;
    const union = aTok.size + bTok.size - inter;
    return union > 0 ? inter / union : 0;
  };

  const matchesCompany = (place: Record<string, unknown>, input: Input) => {
    const sim = nameSimilarity(
      String(place.title || ""),
      input.name,
    );
    const placeCity = String((place.city as string) || "").toLowerCase().trim();
    const companyCity = (input.city || "").toLowerCase().trim();
    const bothCitiesPresent = !!placeCity && !!companyCity;
    const cityMatches = bothCitiesPresent && placeCity === companyCity;
    const cityExplicitlyDifferent =
      bothCitiesPresent && placeCity !== companyCity;
    if (sim >= 0.85) return { ok: true, reason: "matched_strong_name", similarity: sim };
    if (cityMatches && sim >= 0.5) return { ok: true, reason: "matched_name_and_city", similarity: sim };
    if (sim >= 0.7 && !cityExplicitlyDifferent) return { ok: true, reason: "matched_moderate", similarity: sim };
    if (sim < 0.5) return { ok: false, reason: `name_similarity_too_low (${sim.toFixed(2)})`, similarity: sim };
    if (cityExplicitlyDifferent) return { ok: false, reason: `city_mismatch (place=${placeCity}, company=${companyCity})`, similarity: sim };
    return { ok: false, reason: `name_similarity_too_low (${sim.toFixed(2)})`, similarity: sim };
  };

  // Index Apify results by searchString
  const placeByQuery = new Map<string, Record<string, unknown>>();
  for (const p of places) {
    const s = (p as Record<string, unknown>).searchString;
    if (typeof s === "string") placeByQuery.set(s, p as Record<string, unknown>);
  }

  // Build the comparison for each input
  const results = inputs.map((input, idx) => {
    const query = queries[idx];
    const place = placeByQuery.get(query) || null;
    if (!place) {
      return {
        decision: "no_match",
        decision_reason: "apify_returned_no_place_for_this_query",
        similarity: 0,
        input,
        search_string: query,
        apify: null,
      };
    }
    const m = matchesCompany(place, input);
    const closedFlagged = !!place.permanentlyClosed && m.similarity >= 0.5;
    let decision: string;
    let decisionReason: string;
    if (closedFlagged) {
      decision = "marked_closed";
      decisionReason = m.ok
        ? `${m.reason} + permanently_closed`
        : `${m.reason} (low-conf but permanently_closed)`;
    } else if (!m.ok) {
      decision = "skipped";
      decisionReason = m.reason;
    } else {
      decision = "accepted";
      decisionReason = m.reason;
    }
    return {
      decision,
      decision_reason: decisionReason,
      similarity: Number(m.similarity.toFixed(3)),
      input,
      search_string: query,
      apify: {
        title: place.title,
        address: place.address,
        city: place.city,
        state: place.state,
        phone: place.phone || place.phoneUnformatted || null,
        place_id: place.placeId,
        rating: place.totalScore,
        review_count: place.reviewsCount,
        permanently_closed: !!place.permanentlyClosed,
        temporarily_closed: !!place.temporarilyClosed,
        url: place.url,
      },
    };
  });

  // Aggregates
  const totals = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] || 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    dry_run: true,
    cost_estimate_usd: (results.length * 0.003).toFixed(3),
    inputs_count: inputs.length,
    apify_returned: places.length,
    decision_totals: totals,
    note: "NO database writes — this is a preview only. Re-running on the same inputs produces fresh Apify calls; iterate locally on matcher logic and re-test before committing.",
    results,
  });
}
