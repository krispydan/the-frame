export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { apifyClient } from "@/modules/sales/lib/apify-client";

/**
 * POST /api/admin/sales/enrich-via-apify/preview
 *
 * Dispatches a side-effect-free Apify preview run and returns a
 * `preview_id` immediately. The Apify call (which often takes 1-3
 * minutes) continues in the background and writes the result to
 * apify_preview_runs.
 *
 * To fetch the result, poll:
 *   GET /api/admin/sales/enrich-via-apify/preview?id=<preview_id>
 *
 * Body — pass ONE of:
 *   { company_ids: ["abc","def"] }
 *       Test specific companies (pull from skip log to verify a
 *       case now matches correctly).
 *
 *   { searches: [{name, city, state}, ...] }
 *       Test arbitrary search strings — no DB row needed. Useful
 *       for synthetic edge cases.
 *
 *   { limit: 5, tier?: "A,B" }
 *       Random sample N from the cohort (default 5, max 10).
 *
 * Hard limit: 10 inputs per call.
 *
 * NO DATABASE WRITES to companies/contacts/etc. — only the preview's
 * own audit row in apify_preview_runs.
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

  type Input = {
    name: string;
    city: string | null;
    state: string | null;
    company_id: string | null;
  };
  let inputs: Input[] = [];

  if (Array.isArray(body.company_ids) && body.company_ids.length > 0) {
    const ids = body.company_ids.slice(0, 10);
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
    inputs = body.searches.slice(0, 10).map((s) => ({
      company_id: null,
      name: String(s.name || ""),
      city: s.city ? String(s.city) : null,
      state: s.state ? String(s.state) : null,
    }));
  } else {
    const limit = Math.min(10, Math.max(1, body.limit ?? 5));
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

  // Insert pending row + dispatch async — return preview_id NOW so
  // Cloudflare doesn't kill the response while Apify takes 2-3 min.
  const previewId = `prev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  sqlite
    .prepare(
      `INSERT INTO apify_preview_runs (id, inputs_json, status)
       VALUES (?, ?, 'running')`,
    )
    .run(previewId, JSON.stringify(inputs));

  // Fire-and-forget the actual Apify call. .catch swallows so the
  // unhandled-rejection trap doesn't fire.
  void runPreview(previewId, inputs).catch((e) => {
    console.error(`[apify-preview ${previewId}] threw:`, e);
  });

  return NextResponse.json({
    ok: true,
    preview_id: previewId,
    status: "running",
    inputs_count: inputs.length,
    cost_estimate_usd: (inputs.length * 0.003).toFixed(3),
    poll_url: `/api/admin/sales/enrich-via-apify/preview?id=${previewId}`,
    note: "Poll the preview_id via GET to fetch the result. Typical wait: 1-3 minutes.",
  });
}

/**
 * GET /api/admin/sales/enrich-via-apify/preview?id=<preview_id>
 *
 * Fetch the result of a previously-dispatched preview run.
 * Returns {status: 'running'} while in flight, full result body
 * when completed, or {status: 'failed', error_message} on Apify
 * failure.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "?id=<preview_id> required" },
      { status: 400 },
    );
  }
  const row = sqlite
    .prepare(
      `SELECT id, status, started_at, completed_at, result_json, error_message
         FROM apify_preview_runs WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        status: string;
        started_at: string;
        completed_at: string | null;
        result_json: string | null;
        error_message: string | null;
      }
    | undefined;
  if (!row) {
    return NextResponse.json(
      { error: `unknown preview id: ${id}` },
      { status: 404 },
    );
  }
  const result = row.result_json ? JSON.parse(row.result_json) : null;
  return NextResponse.json({
    ok: true,
    id: row.id,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error_message: row.error_message,
    ...result,
  });
}

// ─────────────────────────────────────────────────────────────────
// Background runner — invoked via void from POST, so its errors
// don't escape but its DB writes do.
// ─────────────────────────────────────────────────────────────────

type PreviewInput = {
  name: string;
  city: string | null;
  state: string | null;
  company_id: string | null;
};

async function runPreview(previewId: string, inputs: PreviewInput[]): Promise<void> {
  const queries = inputs.map((i) => {
    const parts = [i.name];
    if (i.city) parts.push(i.city);
    if (i.state) parts.push(i.state);
    return parts.join(", ");
  });

  let places;
  try {
    places = await apifyClient.runGoogleMapsScraper(queries, {
      maxPerSearch: 1,
      timeoutSecs: 240,
    });
  } catch (e) {
    sqlite
      .prepare(
        `UPDATE apify_preview_runs
            SET status = 'failed',
                completed_at = datetime('now'),
                error_message = ?
          WHERE id = ?`,
      )
      .run(
        e instanceof Error ? e.message.slice(0, 1000) : String(e).slice(0, 1000),
        previewId,
      );
    return;
  }

  // ─── matcher logic mirrors google-maps-enrichment.ts ─────────────
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

  const matchesCompany = (
    place: Record<string, unknown>,
    input: PreviewInput,
  ) => {
    const sim = nameSimilarity(String(place.title || ""), input.name);
    const placeCity = String((place.city as string) || "").toLowerCase().trim();
    const companyCity = (input.city || "").toLowerCase().trim();
    const bothCitiesPresent = !!placeCity && !!companyCity;
    const cityMatches = bothCitiesPresent && placeCity === companyCity;
    const cityExplicitlyDifferent =
      bothCitiesPresent && placeCity !== companyCity;
    if (sim >= 0.85)
      return { ok: true, reason: "matched_strong_name", similarity: sim };
    if (cityMatches && sim >= 0.5)
      return { ok: true, reason: "matched_name_and_city", similarity: sim };
    if (sim >= 0.7 && !cityExplicitlyDifferent)
      return { ok: true, reason: "matched_moderate", similarity: sim };
    if (sim < 0.5)
      return {
        ok: false,
        reason: `name_similarity_too_low (${sim.toFixed(2)})`,
        similarity: sim,
      };
    if (cityExplicitlyDifferent)
      return {
        ok: false,
        reason: `city_mismatch (place=${placeCity}, company=${companyCity})`,
        similarity: sim,
      };
    return {
      ok: false,
      reason: `name_similarity_too_low (${sim.toFixed(2)})`,
      similarity: sim,
    };
  };

  const ICP_DISQUALIFY = [
    { pattern: "bridal", reason: "out_of_scope_bridal_shop" },
    { pattern: "wedding dress", reason: "out_of_scope_wedding_shop" },
    { pattern: "maternity", reason: "out_of_scope_maternity_store" },
    { pattern: "children's clothing", reason: "out_of_scope_kids_store" },
    { pattern: "baby store", reason: "out_of_scope_kids_store" },
    { pattern: "baby clothing", reason: "out_of_scope_kids_store" },
    { pattern: "kids clothing", reason: "out_of_scope_kids_store" },
    { pattern: "toddler", reason: "out_of_scope_kids_store" },
    { pattern: "infant", reason: "out_of_scope_kids_store" },
  ];

  const placeByQuery = new Map<string, Record<string, unknown>>();
  for (const p of places) {
    const s = (p as Record<string, unknown>).searchString;
    if (typeof s === "string") placeByQuery.set(s, p as Record<string, unknown>);
  }

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
    const placeTitleLower = String(place.title || "").toLowerCase().trim();
    const companyCityLower = (input.city || "").toLowerCase().trim();
    const placeAddress = String(place.address || "").trim();
    if (
      placeTitleLower &&
      companyCityLower &&
      (placeTitleLower === companyCityLower ||
        placeTitleLower.includes(companyCityLower)) &&
      !placeAddress
    ) {
      return {
        decision: "no_match",
        decision_reason: `apify_returned_city_only (got '${placeTitleLower}')`,
        similarity: 0,
        input,
        search_string: query,
        apify: {
          title: place.title,
          address: place.address || null,
          city: place.city,
          state: place.state,
          phone: null,
          place_id: place.placeId,
          rating: null,
          review_count: null,
          permanently_closed: false,
          temporarily_closed: false,
          url: place.url,
        },
      };
    }
    const m = matchesCompany(place, input);
    const closedFlagged = !!place.permanentlyClosed && m.similarity >= 0.5;
    const categoryHaystack = [
      String(place.categoryName || ""),
      ...((Array.isArray(place.categories) ? place.categories : []) as string[]),
      ...((Array.isArray(place.subTypes) ? place.subTypes : []) as string[]),
    ]
      .filter(Boolean)
      .join(" | ")
      .toLowerCase();
    const disqualifyMatch = ICP_DISQUALIFY.find((p) =>
      categoryHaystack.includes(p.pattern),
    );
    let decision: string;
    let decisionReason: string;
    if (disqualifyMatch && m.ok) {
      decision = "accepted_but_disqualified";
      decisionReason = `${m.reason}; would mark not_qualified: ${disqualifyMatch.reason}`;
    } else if (closedFlagged) {
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
        postal_code: place.postalCode,
        country_code: place.countryCode,
        phone: place.phone || place.phoneUnformatted || null,
        website: place.website,
        url: place.url,
        place_id: place.placeId,
        rating: place.totalScore,
        review_count: place.reviewsCount,
        category_name: place.categoryName,
        categories: place.categories,
        sub_types: place.subTypes,
        description: place.description,
        permanently_closed: !!place.permanentlyClosed,
        temporarily_closed: !!place.temporarilyClosed,
        would_disqualify: disqualifyMatch?.reason || null,
      },
    };
  });

  const totals = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] || 0) + 1;
    return acc;
  }, {});

  sqlite
    .prepare(
      `UPDATE apify_preview_runs
          SET status = 'completed',
              completed_at = datetime('now'),
              result_json = ?
        WHERE id = ?`,
    )
    .run(
      JSON.stringify({
        decision_totals: totals,
        inputs_count: inputs.length,
        apify_returned: places.length,
        cost_estimate_usd: (results.length * 0.003).toFixed(3),
        results,
      }),
      previewId,
    );
}
