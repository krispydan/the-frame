/**
 * Apify qualifier bench.
 *
 * Question it answers: if we point the Google Maps actor at a market, which
 * search term and which geography give us the highest share of leads that look
 * like the boutiques who actually buy?
 *
 * Design: ten cells, ONE variable changed per cell, sharing an anchor so both
 * sweeps are comparable against the same baseline.
 *
 *   cells 1-5   qualifier sweep — market pinned to the largest proven market
 *   cells 1,6-10 market sweep   — qualifier pinned to the strongest term
 *
 * Execution is deliberately two-phase (start, then collect on a later call)
 * rather than a synchronous run. Apify's run-sync endpoint has a hard
 * 300-second ceiling that a 100-place crawl can blow through, and the Railway
 * proxy hangs up on an idle request at ~60s regardless. Starting runs and
 * collecting them on subsequent polls means neither limit can lose a run.
 *
 * The buyer profile is read LIVE from getGmapsProfile() rather than pinned, so
 * as the customer backfill fills in, the bench scores against a better picture
 * of who buys without anyone editing this file.
 */

import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";
import { apifyClient } from "./apify-client";
import { getGmapsProfile } from "./gmaps-profile";
import type { GoogleMapsPlace } from "./apify-client";

export interface TestCell {
  cellId: string;
  sweep: "qualifier" | "market";
  term: string;
  location: string;
}

/** The default experiment. Overridable per-batch from the ops endpoint. */
export const DEFAULT_MATRIX: TestCell[] = [
  // qualifier sweep · market held at New York
  { cellId: "q1-giftshop-ny", sweep: "qualifier", term: "Gift shop", location: "New York, New York" },
  { cellId: "q2-boutique-ny", sweep: "qualifier", term: "Boutique", location: "New York, New York" },
  { cellId: "q3-womens-ny", sweep: "qualifier", term: "Women's clothing store", location: "New York, New York" },
  { cellId: "q4-vintage-ny", sweep: "qualifier", term: "Vintage clothing store", location: "New York, New York" },
  { cellId: "q5-jewelry-ny", sweep: "qualifier", term: "Jewelry store", location: "New York, New York" },
  // market sweep · qualifier held at "Gift shop" (cell 1 is the shared anchor)
  { cellId: "m6-giftshop-seattle", sweep: "market", term: "Gift shop", location: "Seattle, Washington" },
  { cellId: "m7-giftshop-la", sweep: "market", term: "Gift shop", location: "Los Angeles, California" },
  { cellId: "m8-giftshop-austin", sweep: "market", term: "Gift shop", location: "Austin, Texas" },
  { cellId: "m9-giftshop-nashville", sweep: "market", term: "Gift shop", location: "Nashville, Tennessee" },
  { cellId: "m10-giftshop-denver", sweep: "market", term: "Gift shop", location: "Denver, Colorado" },
];

export const PLACES_PER_CELL = 100;

function actorInput(cell: TestCell, perCell: number): Record<string, unknown> {
  return {
    searchStringsArray: [cell.term],
    locationQuery: cell.location,
    maxCrawledPlacesPerSearch: perCell,
    // No server-side filters. The first batch ran with placeMinimumStars and
    // skipClosedPlaces set here and was billed 1660 `filter-applied` events on
    // 850 places — $1.66 of a $5.06 bench, a third of the cost, for two rules
    // we can evaluate ourselves. Rating and closed-status both arrive on the
    // returned row, so scoreLead applies them for nothing.
    //
    // Worth recording what this did NOT cost, since it is the intuitive fear:
    // billed places exactly equalled kept places (850/850), so filtering at the
    // actor did not make it scrape-and-discard. The waste was the filter charge
    // alone, not hidden over-scraping.
    website: "allPlaces",
    language: "en",
    countryCode: "us",
    // List-level fields carry everything the scoring needs. The detail-page
    // crawl is the expensive half of this actor and buys us nothing here.
    scrapePlaceDetailPage: false,
    includeReviews: false,
    includeImages: false,
    includeOpeningHours: false,
    includePeopleAlsoSearch: false,
    includeWebResults: false,
  };
}

interface BuyerProfile {
  categories: Set<string>;
  subTypes: Set<string>;
  p25: number;
  p75: number;
  basis: { customerListings: number; controlListings: number };
}

/** Who buys, according to the listings we have captured so far. */
export function buyerProfile(): BuyerProfile {
  const p = getGmapsProfile();
  return {
    categories: new Set(p.categories.filter((c) => c.customers >= 2).map((c) => c.value)),
    subTypes: new Set(p.subTypes.filter((s) => s.customers >= 2).map((s) => s.value)),
    p25: p.reviews.customerP25 ?? 0,
    p75: p.reviews.customerP75 ?? Number.MAX_SAFE_INTEGER,
    basis: { customerListings: p.customerListings, controlListings: p.controlListings },
  };
}

/**
 * Hard ceiling on review count. Above this a Google listing is usually a chain
 * store or a tourist-volume destination, neither of which buys wholesale the
 * way an owner-operated boutique does.
 *
 * This is an EXCLUSION, not a score penalty: a chain is not a weak lead, it is
 * the wrong lead, and letting it score partial credit only pushes a real
 * prospect off the bottom of the list.
 *
 * Known limit, worth stating rather than burying: a review ceiling catches
 * high-traffic independents more reliably than it catches chains. A mall
 * location of a national brand often sits comfortably inside the band on its
 * own listing. `chainSuspects()` covers that gap by name repetition.
 */
export const CHAIN_REVIEW_CEILING = 150;

/** Buyer P10 rating. Applied here rather than at the actor — see actorInput(). */
export const MIN_RATING = 4.0;

export interface LeadScore {
  score: number; catHit: number; subHit: number; inBand: number; hasSite: number;
  excluded: number; excludeReason: string | null;
}

/**
 * 0-100 against the buyer profile. Weights say what we believe: what a shop
 * IS matters most, how big it is matters nearly as much (buyers cluster in a
 * narrow review band), and having a website is table stakes rather than a
 * differentiator.
 */
export function scoreLead(p: GoogleMapsPlace, prof: BuyerProfile): LeadScore {
  const subs = p.subTypes ?? p.categories ?? [];
  const reviews = Number(p.reviewsCount ?? 0);

  // The primary category is checked against the buyer's PRIMARY categories and
  // their SUB-TYPES together. Checking only the former was a real bug: a shop
  // whose Google primary is "Jewelry store" scored zero category credit and so
  // could never clear the qualified bar, even though jewellery is a sub-type on
  // 14% of our buyers. Which of the two lists a label happens to land in is an
  // artefact of how Google files a business, not a statement about whether that
  // kind of shop buys from us.
  const catHit =
    p.categoryName && (prof.categories.has(p.categoryName) || prof.subTypes.has(p.categoryName)) ? 1 : 0;
  const subHit = subs.some((s) => prof.subTypes.has(s)) ? 1 : 0;
  const inBand = reviews >= prof.p25 && reviews <= prof.p75 ? 1 : 0;
  const hasSite = p.website ? 1 : 0;
  const closed = p.permanentlyClosed || p.temporarilyClosed ? 1 : 0;
  const open = closed ? 0 : 1;
  const rating = Number(p.totalScore ?? 0);

  // Exclusions, all evaluated from fields already on the row so they cost
  // nothing. These used to be split between here and the actor input; asking
  // Apify to apply the rating and closed-status rules was billed per filter and
  // told us nothing our own data could not.
  let excludeReason: string | null = null;
  if (reviews > CHAIN_REVIEW_CEILING) excludeReason = `${reviews} reviews (chain ceiling ${CHAIN_REVIEW_CEILING})`;
  else if (closed) excludeReason = "permanently or temporarily closed";
  else if (rating > 0 && rating < MIN_RATING) excludeReason = `${rating} stars (floor ${MIN_RATING})`;

  return {
    score: catHit * 40 + subHit * 15 + inBand * 30 + hasSite * 10 + open * 5,
    catHit, subHit, inBand, hasSite,
    excluded: excludeReason ? 1 : 0,
    excludeReason,
  };
}

export const QUALIFIED_AT = 70;

// ── phase 1: start ──

/**
 * The Apify account has a ceiling on memory across all concurrent runs (16GB
 * at time of writing, and this actor asks for 4GB), so only a handful of cells
 * can be in flight at once. That is a CAPACITY signal, not a failure: a cell
 * that cannot start yet goes back in the queue and starts when a slot frees.
 * Treating it as a failure would mean a ten-cell bench silently became a
 * four-cell one.
 */
function isCapacityError(msg: string): boolean {
  return /memory-limit-exceeded|memory limit|402/i.test(msg);
}

/** Start as many queued cells as the account will accept right now. */
function startQueued(batch: string, perCell: number): Promise<{ started: number; blocked: string | null }> {
  const queued = sqlite
    .prepare("SELECT * FROM apify_test_runs WHERE batch = ? AND status = 'queued' ORDER BY cell_id")
    .all(batch) as Array<{ id: string; cell_id: string; sweep: string; term: string; location: string }>;

  return (async () => {
    let started = 0;
    for (const row of queued) {
      const cell: TestCell = {
        cellId: row.cell_id, sweep: row.sweep as TestCell["sweep"],
        term: row.term, location: row.location,
      };
      try {
        const { runId, datasetId } = await apifyClient.startRun(actorInput(cell, perCell));
        sqlite
          .prepare("UPDATE apify_test_runs SET status='running', apify_run_id=?, dataset_id=?, error=NULL WHERE id=?")
          .run(runId, datasetId, row.id);
        started++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isCapacityError(msg)) {
          // Account is full. Everything after this would hit the same wall, so
          // stop asking and leave the rest queued for the next poll.
          sqlite.prepare("UPDATE apify_test_runs SET error=? WHERE id=?").run("waiting for a free Apify slot", row.id);
          return { started, blocked: "apify memory limit — remaining cells wait for a slot" };
        }
        sqlite.prepare("UPDATE apify_test_runs SET status='failed', error=? WHERE id=?").run(msg, row.id);
      }
    }
    return { started, blocked: null };
  })();
}

export async function startBatch(
  matrix: TestCell[] = DEFAULT_MATRIX,
  perCell = PLACES_PER_CELL,
): Promise<{ batch: string; started: number; queued: number; blocked: string | null }> {
  const batch = `batch_${new Date().toISOString().replace(/[:.]/g, "-")}`;

  // Record the whole matrix up front, then start what fits. The batch is the
  // ten cells whether or not Apify has room for them yet.
  const insert = sqlite.prepare(
    `INSERT INTO apify_test_runs (id, batch, cell_id, sweep, term, location, status)
     VALUES (?,?,?,?,?,?,'queued')`,
  );
  sqlite.transaction(() => {
    for (const c of matrix) insert.run(randomUUID(), batch, c.cellId, c.sweep, c.term, c.location);
  })();

  const { started, blocked } = await startQueued(batch, perCell);
  return { batch, started, queued: matrix.length - started, blocked };
}

// ── phase 2: collect ──

/**
 * Check every still-running cell, ingest the finished ones, then fill the
 * freed slots from the queue. Callers drive this until nothing is left.
 */
export async function pollBatch(
  batch: string,
  perCell = PLACES_PER_CELL,
  opts: { startQueued?: boolean } = {},
): Promise<{ ingested: number; stillRunning: number; started: number; queued: number; blocked: string | null }> {
  // A cell that failed only because the account was full is not a failed cell.
  sqlite
    .prepare("UPDATE apify_test_runs SET status='queued' WHERE batch=? AND status='failed' AND error LIKE '%memory-limit%'")
    .run(batch);

  const running = sqlite
    .prepare("SELECT * FROM apify_test_runs WHERE batch = ? AND status = 'running'")
    .all(batch) as Array<{ id: string; cell_id: string; apify_run_id: string; dataset_id: string }>;

  const prof = buyerProfile();
  let ingested = 0;
  let stillRunning = 0;

  for (const r of running) {
    let status: string;
    let stats: Record<string, unknown> | null = null;
    try {
      ({ status, stats } = await apifyClient.getRunStatus(r.apify_run_id));
    } catch (e) {
      // A status check that fails is not a run that failed — leave it running
      // and try again on the next poll. But RECORD why: a silent catch here
      // meant a batch could sit at "still running" forever with the reason
      // visible only in logs nobody was reading.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[qualifier-test] status check ${r.cell_id}:`, e);
      sqlite.prepare("UPDATE apify_test_runs SET error=? WHERE id=?").run(`status check: ${msg}`, r.id);
      stillRunning++;
      continue;
    }

    if (status === "READY" || status === "RUNNING") { stillRunning++; continue; }

    if (status !== "SUCCEEDED") {
      sqlite
        .prepare("UPDATE apify_test_runs SET status='failed', error=?, finished_at=datetime('now') WHERE id=?")
        .run(status, r.id);
      continue;
    }

    let items: GoogleMapsPlace[];
    try {
      if (!r.dataset_id) throw new Error("no dataset_id recorded for this run");
      items = await apifyClient.getDatasetItems(r.dataset_id, PLACES_PER_CELL * 2);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[qualifier-test] dataset ${r.cell_id}:`, e);
      sqlite.prepare("UPDATE apify_test_runs SET error=? WHERE id=?").run(`dataset fetch: ${msg}`, r.id);
      stillRunning++;
      continue;
    }

    const insert = sqlite.prepare(
      `INSERT INTO apify_test_leads
         (id, run_id, batch, place_id, title, category, sub_types_json, address, city, state,
          postal_code, phone, website, maps_url, rating, review_count, score, cat_hit, sub_hit, in_band,
          has_site, excluded, exclude_reason, closed)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    let qualified = 0;
    let totalScore = 0;
    let eligible = 0;
    // One transaction per cell: 100 synchronous inserts, and better-sqlite3
    // blocks the event loop for the duration either way — batching keeps that
    // window as short as possible. No network calls inside.
    sqlite.transaction(() => {
      sqlite.prepare("DELETE FROM apify_test_leads WHERE run_id = ?").run(r.id);
      for (const p of items) {
        const s = scoreLead(p, prof);
        // Excluded rows are kept, not dropped — being able to see what the
        // chain filter removed is how you tell a good ceiling from a greedy one.
        if (!s.excluded) { totalScore += s.score; eligible++; if (s.score >= QUALIFIED_AT) qualified++; }
        insert.run(
          randomUUID(), r.id, batch, p.placeId ?? null, p.title ?? null, p.categoryName ?? null,
          JSON.stringify(p.subTypes ?? p.categories ?? []), p.address ?? null, p.city ?? null,
          p.state ?? null, p.postalCode ?? null, p.phone ?? null, p.website ?? null, p.url ?? null,
          Number(p.totalScore ?? 0) || null, Number(p.reviewsCount ?? 0) || 0,
          s.score, s.catHit, s.subHit, s.inBand, s.hasSite, s.excluded, s.excludeReason,
          p.permanentlyClosed || p.temporarilyClosed ? 1 : 0,
        );
      }
    })();

    sqlite
      .prepare(
        `UPDATE apify_test_runs
            SET status='done', scraped=?, qualified=?, avg_score=?, stats_json=?, finished_at=datetime('now')
          WHERE id=?`,
      )
      .run(items.length, qualified, eligible ? totalScore / eligible : 0, JSON.stringify(stats), r.id);
    ingested++;
  }

  // Slots may have just freed up — pull the next wave in. Collection-only
  // callers skip this: recovering data we already paid for must never be able
  // to start new work as a side effect.
  const { started, blocked } = opts.startQueued === false
    ? { started: 0, blocked: null as string | null }
    : await startQueued(batch, perCell);
  const queued = (sqlite
    .prepare("SELECT COUNT(*) n FROM apify_test_runs WHERE batch=? AND status='queued'")
    .get(batch) as { n: number }).n;

  return { ingested, stillRunning: stillRunning + started, started, queued, blocked };
}

// ── reporting ──

/**
 * Recompute every stored lead's score against the current rules.
 *
 * Everything scoring reads — category, sub-types, review count, website — is
 * stored on the row, so a scoring change can be applied to a finished batch for
 * free. Without this, fixing a scoring bug would mean re-scraping to see the
 * corrected numbers, and the cost of that would be a standing argument against
 * fixing scoring bugs.
 */
export function rescoreBatch(batch: string): { rescored: number; changed: number } {
  const prof = buyerProfile();
  const rows = sqlite
    .prepare(
      `SELECT id, category, sub_types_json, review_count, website, score, rating, closed
         FROM apify_test_leads WHERE batch = ?`,
    )
    .all(batch) as Array<{
      id: string; category: string | null; sub_types_json: string | null;
      review_count: number; website: string | null; score: number;
      rating: number | null; closed: number;
    }>;

  const upd = sqlite.prepare(
    `UPDATE apify_test_leads
        SET score=?, cat_hit=?, sub_hit=?, in_band=?, has_site=?, excluded=?, exclude_reason=?
      WHERE id=?`,
  );

  let changed = 0;
  sqlite.transaction(() => {
    for (const r of rows) {
      let subs: string[] = [];
      try { subs = r.sub_types_json ? (JSON.parse(r.sub_types_json) as string[]) : []; } catch { /* keep [] */ }
      const s = scoreLead(
        {
          categoryName: r.category ?? undefined,
          subTypes: subs,
          reviewsCount: r.review_count,
          website: r.website ?? undefined,
          totalScore: r.rating ?? undefined,
          permanentlyClosed: !!r.closed,
        } as GoogleMapsPlace,
        prof,
      );
      if (s.score !== r.score) changed++;
      upd.run(s.score, s.catHit, s.subHit, s.inBand, s.hasSite, s.excluded, s.excludeReason, r.id);
    }
  })();

  applyChainFilter(batch);
  return { rescored: rows.length, changed };
}

/** Put failed cells back in the queue — an ABORTED Apify run is worth one retry. */
export function retryFailedCells(batch: string): { requeued: number } {
  const res = sqlite
    .prepare(
      `UPDATE apify_test_runs SET status='queued', error=NULL, apify_run_id=NULL, dataset_id=NULL
        WHERE batch=? AND status='failed'`,
    )
    .run(batch);
  return { requeued: res.changes };
}

/**
 * Re-apply the chain ceiling to leads already stored, and refresh each cell's
 * qualified count. Cheap, idempotent, and safe to call on every read — it is
 * how a rule change reaches a batch that was scored under the old one, without
 * paying Apify to scrape it again.
 */
export function applyChainFilter(batch: string): { excluded: number } {
  sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE apify_test_leads
            SET excluded = 1, exclude_reason = review_count || ' reviews (chain ceiling ${CHAIN_REVIEW_CEILING})'
          WHERE batch = ? AND review_count > ${CHAIN_REVIEW_CEILING} AND excluded = 0`,
      )
      .run(batch);
    sqlite
      .prepare(
        // Scoped to chain-ceiling exclusions only — clearing every excluded row
        // would silently readmit the closed and low-rated ones.
        `UPDATE apify_test_leads SET excluded = 0, exclude_reason = NULL
          WHERE batch = ? AND review_count <= ${CHAIN_REVIEW_CEILING} AND excluded = 1
            AND exclude_reason LIKE '%chain ceiling%'`,
      )
      .run(batch);
    sqlite
      .prepare(
        `UPDATE apify_test_runs SET
           qualified = (SELECT COUNT(*) FROM apify_test_leads l
                         WHERE l.run_id = apify_test_runs.id AND l.excluded = 0 AND l.score >= ${QUALIFIED_AT}),
           avg_score = (SELECT AVG(score) FROM apify_test_leads l
                         WHERE l.run_id = apify_test_runs.id AND l.excluded = 0)
         WHERE batch = ? AND status = 'done'`,
      )
      .run(batch);
  })();

  const n = sqlite
    .prepare("SELECT COUNT(*) n FROM apify_test_leads WHERE batch = ? AND excluded = 1")
    .get(batch) as { n: number };
  return { excluded: n.n };
}

/**
 * Chains the review ceiling cannot see: the same business name at more than one
 * address. A mall location of a national brand often has a perfectly ordinary
 * review count on its own listing, so name repetition catches what volume misses.
 */
export function chainSuspects(batch: string): Array<{ title: string; locations: number; maxReviews: number }> {
  return sqlite
    .prepare(
      `SELECT title, COUNT(DISTINCT COALESCE(address, place_id)) locations, MAX(review_count) maxReviews
         FROM apify_test_leads
        WHERE batch = ? AND excluded = 0 AND title IS NOT NULL
        GROUP BY LOWER(title) HAVING locations > 1
        ORDER BY locations DESC, maxReviews DESC LIMIT 25`,
    )
    .all(batch) as Array<{ title: string; locations: number; maxReviews: number }>;
}

export function batchSummary(batch: string) {
  applyChainFilter(batch);
  const runs = sqlite
    .prepare("SELECT * FROM apify_test_runs WHERE batch = ? ORDER BY cell_id")
    .all(batch) as Array<Record<string, unknown>>;

  const cells = runs.map((r) => {
    const runId = String(r.id);
    // Every rate below is over ELIGIBLE leads (chains removed). Reporting them
    // over the raw scrape would flatter whichever term pulled in the most
    // chain stores.
    const agg = sqlite
      .prepare(
        `SELECT COUNT(*) n,
                AVG(cat_hit)*100 catPct, AVG(sub_hit)*100 subPct,
                AVG(in_band)*100 bandPct, AVG(has_site)*100 sitePct,
                AVG(review_count) avgReviews, AVG(rating) avgRating
           FROM apify_test_leads WHERE run_id = ? AND excluded = 0`,
      )
      .get(runId) as Record<string, number>;
    const excluded = (sqlite
      .prepare("SELECT COUNT(*) n FROM apify_test_leads WHERE run_id = ? AND excluded = 1")
      .get(runId) as { n: number }).n;
    const medRow = sqlite
      .prepare(
        `SELECT review_count FROM apify_test_leads WHERE run_id = ? AND excluded = 0
          ORDER BY review_count LIMIT 1
         OFFSET (SELECT COUNT(*)/2 FROM apify_test_leads WHERE run_id = ? AND excluded = 0)`,
      )
      .get(runId, runId) as { review_count: number } | undefined;

    const round = (x: number | null | undefined, d = 1) =>
      x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

    return {
      cellId: r.cell_id, sweep: r.sweep, term: r.term, location: r.location,
      status: r.status, error: r.error,
      scraped: r.scraped ?? 0,
      chainsExcluded: excluded,
      eligible: agg?.n ?? 0,
      qualified: r.qualified ?? 0,
      qualifiedPct: agg?.n ? round((Number(r.qualified) / agg.n) * 100) : null,
      avgScore: round(Number(r.avg_score)),
      categoryMatchPct: round(agg?.catPct),
      subTypeMatchPct: round(agg?.subPct),
      reviewBandPct: round(agg?.bandPct),
      hasWebsitePct: round(agg?.sitePct),
      medianReviews: medRow?.review_count ?? null,
      avgRating: round(agg?.avgRating, 2),
    };
  });

  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) scraped,
              SUM(excluded) chainsExcluded,
              SUM(excluded = 0) eligible,
              SUM(excluded = 0 AND score >= ${QUALIFIED_AT}) qualified,
              AVG(CASE WHEN excluded = 0 THEN score END) avgScore
         FROM apify_test_leads WHERE batch = ?`,
    )
    .get(batch) as Record<string, number>;

  const prof = buyerProfile();
  return {
    batch,
    cells,
    totals: {
      scraped: totals?.scraped ?? 0,
      chainsExcluded: totals?.chainsExcluded ?? 0,
      eligible: totals?.eligible ?? 0,
      qualified: totals?.qualified ?? 0,
      qualifiedPct: totals?.eligible ? Math.round((totals.qualified / totals.eligible) * 1000) / 10 : 0,
      avgScore: totals?.avgScore ? Math.round(totals.avgScore * 10) / 10 : 0,
    },
    chainFilter: {
      reviewCeiling: CHAIN_REVIEW_CEILING,
      suspectsByName: chainSuspects(batch),
      note:
        "The ceiling removes high-volume listings. Multi-location names below it are listed as suspectsByName — a chain's individual store often has an ordinary review count.",
    },
    scoredAgainst: {
      categories: [...prof.categories],
      reviewBand: [prof.p25, prof.p75],
      ...prof.basis,
      caveat:
        prof.basis.controlListings < 30
          ? `Only ${prof.basis.controlListings} control listings captured, so this scores against what buyers look like, not against what separates buyers from non-buyers.`
          : null,
    },
  };
}

/**
 * What the bench actually cost, per cell, straight from Apify's run records.
 *
 * Worth knowing what the event names mean when reading this: `place-scraped`
 * bills EVERY place the crawler looked at, not just the ones it returned, and
 * `filter-applied` bills the filtering itself. So a server-side filter is paid
 * for twice over — once for the places it discards, once for the discarding —
 * and any filter we can evaluate ourselves from the returned row is cheaper
 * applied here than asked of the actor.
 */
export async function batchCosts(batch: string) {
  const runs = sqlite
    .prepare(
      `SELECT cell_id, term, location, apify_run_id, scraped FROM apify_test_runs
        WHERE batch = ? AND apify_run_id IS NOT NULL ORDER BY cell_id`,
    )
    .all(batch) as Array<{ cell_id: string; term: string; location: string; apify_run_id: string; scraped: number | null }>;

  const cells: Array<Record<string, unknown>> = [];
  let total = 0;
  const eventTotals: Record<string, number> = {};

  for (const r of runs) {
    try {
      const c = await apifyClient.getRunCost(r.apify_run_id);
      total += c.usageTotalUsd ?? 0;
      for (const [k, v] of Object.entries(c.chargedEventCounts ?? {})) {
        eventTotals[k] = (eventTotals[k] ?? 0) + Number(v);
      }
      cells.push({
        cellId: r.cell_id, term: r.term, location: r.location,
        status: c.status, kept: r.scraped ?? 0,
        usd: c.usageTotalUsd,
        events: c.chargedEventCounts,
        costPerKeptLead: r.scraped ? Math.round(((c.usageTotalUsd ?? 0) / r.scraped) * 10000) / 10000 : null,
      });
    } catch (e) {
      cells.push({ cellId: r.cell_id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const placesBilled = eventTotals["place-scraped"] ?? 0;
  const kept = runs.reduce((a, r) => a + (r.scraped ?? 0), 0);

  // Account-level context: without it a batch cost is unreadable, because it
  // cannot say whether this work spent the month or arrived at the end of one.
  let account: Record<string, unknown> | null = null;
  try { account = await apifyClient.getAccountUsage(); }
  catch (e) { account = { error: e instanceof Error ? e.message : String(e) }; }

  return {
    batch,
    account,
    totalUsd: Math.round(total * 100) / 100,
    batchShareOfMonthPct:
      account && typeof account.monthlyUsageUsd === "number" && account.monthlyUsageUsd > 0
        ? Math.round((total / account.monthlyUsageUsd) * 1000) / 10
        : null,
    eventTotals,
    placesBilled,
    placesKept: kept,
    // The number that explains a surprising bill: how many places we paid to
    // look at for each one we actually got back.
    billedPerKept: kept ? Math.round((placesBilled / kept) * 100) / 100 : null,
  };
}

/**
 * Collect every batch that has finished runs whose results were never ingested.
 *
 * Exists because a bug started seven unintended batches: the scrapes ran and
 * were billed, but nothing ever read their datasets back. The money is spent
 * either way, so the only question left is whether we get the leads for it.
 * Reading a dataset costs essentially nothing, and this explicitly cannot
 * start new runs.
 */
export async function collectOrphanBatches(): Promise<{
  batches: Array<{ batch: string; ingested: number; stillRunning: number; errors: string[] }>;
  totalIngested: number;
}> {
  const rows = sqlite
    .prepare("SELECT DISTINCT batch FROM apify_test_runs WHERE status IN ('running','queued') ORDER BY batch")
    .all() as Array<{ batch: string }>;

  const out: Array<{ batch: string; ingested: number; stillRunning: number; errors: string[] }> = [];
  let totalIngested = 0;
  for (const r of rows) {
    const res = await pollBatch(r.batch, PLACES_PER_CELL, { startQueued: false });
    const errs = sqlite
      .prepare("SELECT DISTINCT error FROM apify_test_runs WHERE batch=? AND error IS NOT NULL LIMIT 3")
      .all(r.batch) as Array<{ error: string }>;
    out.push({
      batch: r.batch, ingested: res.ingested, stillRunning: res.stillRunning,
      errors: errs.map((e) => e.error),
    });
    totalIngested += res.ingested;
  }
  return { batches: out, totalIngested };
}

/** Leads across every batch, deduplicated on Google place id. */
export function allLeadsSummary() {
  const t = sqlite
    .prepare(
      `SELECT COUNT(*) rows, COUNT(DISTINCT place_id) uniquePlaces,
              SUM(excluded) chainsExcluded,
              SUM(excluded = 0 AND score >= ${QUALIFIED_AT}) qualified
         FROM apify_test_leads`,
    )
    .get() as Record<string, number>;
  const byBatch = sqlite
    .prepare(
      `SELECT batch, COUNT(*) leads, COUNT(DISTINCT place_id) uniquePlaces
         FROM apify_test_leads GROUP BY batch ORDER BY batch`,
    )
    .all() as Array<Record<string, unknown>>;
  return { ...t, byBatch };
}

export function listBatches(): Array<Record<string, unknown>> {
  return sqlite
    .prepare(
      `SELECT batch, COUNT(*) cells, SUM(status='done') done, SUM(status='running') running,
              SUM(status='failed') failed, MIN(created_at) started
         FROM apify_test_runs GROUP BY batch ORDER BY started DESC LIMIT 20`,
    )
    .all() as Array<Record<string, unknown>>;
}

/** Excluded chains are omitted unless explicitly asked for. */
export function exportLeads(
  batch: string,
  minScore = 0,
  includeExcluded = false,
): Array<Record<string, unknown>> {
  applyChainFilter(batch);
  return sqlite
    .prepare(
      `SELECT r.cell_id, r.term, r.location, l.title, l.category, l.address, l.city, l.state,
              l.postal_code, l.phone, l.website, l.maps_url, l.rating, l.review_count, l.score,
              l.excluded, l.exclude_reason
         FROM apify_test_leads l JOIN apify_test_runs r ON r.id = l.run_id
        WHERE l.batch = ? AND l.score >= ? ${includeExcluded ? "" : "AND l.excluded = 0"}
        ORDER BY l.score DESC, l.review_count DESC`,
    )
    .all(batch, minScore) as Array<Record<string, unknown>>;
}
