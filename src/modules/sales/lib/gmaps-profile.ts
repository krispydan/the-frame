/**
 * Customer Google Maps profiling — reverse-engineering the search that finds
 * more of our buyers.
 *
 * The Apify actor (compass~crawler-google-places) exposes a fixed set of
 * discovery inputs. Everything here is organised around them, because a
 * profile that doesn't map onto a knob you can turn is trivia:
 *
 *   searchStringsArray      ← what Google calls our customers (categoryName)
 *   categoryFilterWords     ← the same, as a hard filter
 *   placeMinimumStars       ← our customers' rating floor
 *   website                 ← do our customers have sites?
 *   skipClosedPlaces        ← always true, but measured not assumed
 *   locationQuery           ← where they cluster
 *   maxCrawledPlacesPerSearch ← sized from addressable counts
 *
 * Review count isn't a native filter, so it becomes a post-scrape score
 * threshold — which is why we store it rather than only filtering on it.
 *
 * Phase 1 captures listings for companies that have actually bought. Phase 2
 * (getGmapsProfile) turns them into concrete actor input, contrasted against
 * called-but-never-bought companies so the output is the DISCRIMINATING
 * features rather than merely the common ones.
 */

import { sqlite } from "@/lib/db";
import { apifyClient, type GoogleMapsPlace } from "./apify-client";
import { verifyApifyMatch } from "./apify-match-verifier";

/** Companies that have actually bought — status alone misses unreclassified buyers. */
export const IS_CUSTOMER_SQL = `(c.status = 'customer' OR EXISTS (
  SELECT 1 FROM orders o WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned')))`;

interface Target {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}

export interface CaptureResult {
  attempted: number;
  captured: number;
  noMatch: number;
  rejected: number;
  errors: Array<{ company: string; reason: string }>;
  remaining: number;
}

/**
 * Apify's run-sync-get-dataset-items endpoint has a hard 300-second ceiling —
 * the `timeout` query param can't raise it, and overrunning returns HTTP 408
 * with the whole batch's work discarded. Profiling asks for the detail page
 * (hours, description), which is the slow part, so three per run leaves
 * headroom on boutique-shaped queries. Five was landing right on the line and
 * losing every store in the batch when it tipped over.
 */
const BATCH_SIZE = 3;

function loadTargets(limit: number, opts: { cohort: "customers" | "called-no-order" }): Target[] {
  const base = opts.cohort === "customers"
    ? `WHERE ${IS_CUSTOMER_SQL}`
    // The control group: called at least once, never ordered. Profiling only
    // buyers tells you what a boutique looks like, not what a BUYER looks
    // like — the difference between the two groups is the whole signal.
    : `WHERE NOT ${IS_CUSTOMER_SQL}
         AND EXISTS (SELECT 1 FROM phoneburner_call_log pb WHERE pb.company_id = c.id)`;

  return sqlite
    .prepare(
      `SELECT c.id, c.name, c.city, c.state
         FROM companies c
        ${base}
          AND TRIM(COALESCE(c.name,'')) <> ''
          AND NOT EXISTS (SELECT 1 FROM gmaps_listings g WHERE g.company_id = c.id)
        ORDER BY c.name
        LIMIT ?`,
    )
    .all(limit) as Target[];
}

export function countRemaining(cohort: "customers" | "called-no-order"): number {
  const base = cohort === "customers"
    ? `WHERE ${IS_CUSTOMER_SQL}`
    : `WHERE NOT ${IS_CUSTOMER_SQL}
         AND EXISTS (SELECT 1 FROM phoneburner_call_log pb WHERE pb.company_id = c.id)`;
  return (sqlite
    .prepare(
      `SELECT COUNT(*) n FROM companies c ${base}
         AND TRIM(COALESCE(c.name,'')) <> ''
         AND NOT EXISTS (SELECT 1 FROM gmaps_listings g WHERE g.company_id = c.id)`,
    )
    .get() as { n: number }).n;
}

/**
 * How many control listings we already hold. The backfill caps on this rather
 * than on `countRemaining`, because the control pool is ~3k companies and we
 * only need enough of them to establish a baseline share.
 */
export function countControlListings(): number {
  return (sqlite
    .prepare(
      `SELECT COUNT(*) n FROM gmaps_listings g
         JOIN companies c ON c.id = g.company_id
        WHERE NOT ${IS_CUSTOMER_SQL}`,
    )
    .get() as { n: number }).n;
}

function searchStringFor(t: Target): string {
  return [t.name, t.city, t.state].filter(Boolean).join(", ");
}

/** Loose name similarity, used only to pair a result back to its query. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const insertStmt = () =>
  sqlite.prepare(
    `INSERT INTO gmaps_listings (
       id, company_id, place_id, title, category_name, categories, sub_types,
       rating, review_count, price, website, has_website, phone, address, city, state,
       postal_code, lat, lng, permanently_closed, temporarily_closed, opening_hours,
       description, maps_url, image_count, raw, match_decision, match_reason
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id) DO UPDATE SET
       place_id = excluded.place_id, title = excluded.title,
       category_name = excluded.category_name, categories = excluded.categories,
       sub_types = excluded.sub_types, rating = excluded.rating,
       review_count = excluded.review_count, price = excluded.price,
       website = excluded.website, has_website = excluded.has_website,
       raw = excluded.raw, scraped_at = datetime('now')`,
  );

/**
 * Capture Google Maps listings for a cohort.
 *
 * Runs with full detail (not the enrichment's `fast` mode) because categories
 * and opening hours only come from the detail page — and categories are the
 * single most important field here, since they become the search terms.
 */
export async function captureListings(
  opts: { cohort?: "customers" | "called-no-order"; limit?: number; verify?: boolean } = {},
): Promise<CaptureResult> {
  const cohort = opts.cohort ?? "customers";
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const targets = loadTargets(limit, { cohort });

  const result: CaptureResult = {
    attempted: targets.length, captured: 0, noMatch: 0, rejected: 0, errors: [],
    remaining: 0,
  };
  if (targets.length === 0) {
    result.remaining = countRemaining(cohort);
    return result;
  }

  const ins = insertStmt();

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);
    let places: GoogleMapsPlace[] = [];
    try {
      places = await apifyClient.runGoogleMapsScraper(
        batch.map(searchStringFor),
        { maxPerSearch: 1, fast: false },
      );
    } catch (e) {
      // A batch dies as a unit: one store whose detail page crawls slowly
      // takes its neighbours' results down with it when the run hits Apify's
      // 300s ceiling. Retry the batch one store at a time so we keep the ones
      // that would have resolved fine, and only lose the actual straggler.
      const reason = e instanceof Error ? e.message.slice(0, 160) : String(e);
      console.log(`[gmaps-profile] batch failed (${reason}) — retrying ${batch.length} singly`);
      for (const t of batch) {
        try {
          const solo = await apifyClient.runGoogleMapsScraper([searchStringFor(t)], {
            maxPerSearch: 1,
            fast: false,
          });
          places.push(...solo);
        } catch (inner) {
          result.errors.push({
            company: t.name,
            reason: inner instanceof Error ? inner.message.slice(0, 160) : String(inner),
          });
        }
      }
    }

    for (const t of batch) {
      // Pair the result back to its query: prefer the searchString the actor
      // echoes, else fall back to name similarity.
      const wanted = searchStringFor(t);
      const place =
        places.find((p) => p.searchString === wanted) ??
        places.find((p) => p.title && normalize(p.title).includes(normalize(t.name).slice(0, 10)));

      if (!place) { result.noMatch++; continue; }

      // Optional AI check that the place really is this business. Off by
      // default for profiling — a wrong match distorts an aggregate slightly,
      // whereas for phone-filling it would put a stranger's number on a record.
      let decision = "unverified";
      let reason = "verification skipped";
      if (opts.verify) {
        const v = await verifyApifyMatch({
          companyName: t.name, companyCity: t.city, companyState: t.state,
          apifyTitle: place.title ?? "", apifyAddress: place.address ?? null,
          apifyCity: place.city ?? null, apifyState: place.state ?? null,
          apifyCategories: [place.categoryName, ...(place.categories ?? [])].filter(Boolean).join(", ") || null,
        });
        decision = v.decision;
        reason = v.reason;
        if (v.decision === "no") { result.rejected++; continue; }
      }

      const subTypes = Array.isArray(place.subTypes) ? place.subTypes
        : Array.isArray(place.categories) ? place.categories : [];

      ins.run(
        crypto.randomUUID(), t.id, place.placeId ?? null, place.title ?? null,
        place.categoryName ?? null,
        Array.isArray(place.categories) ? JSON.stringify(place.categories) : null,
        subTypes.length ? JSON.stringify(subTypes) : null,
        place.totalScore ?? null, place.reviewsCount ?? null, place.price ?? null,
        place.website ?? null, place.website ? 1 : 0,
        place.phone ?? place.phoneUnformatted ?? null,
        place.address ?? null, place.city ?? null, place.state ?? null, place.postalCode ?? null,
        place.location?.lat ?? null, place.location?.lng ?? null,
        place.permanentlyClosed ? 1 : 0, place.temporarilyClosed ? 1 : 0,
        place.openingHours ? JSON.stringify(place.openingHours) : null,
        place.description ?? null, place.url ?? null,
        Array.isArray(place.imageUrls) ? place.imageUrls.length : null,
        JSON.stringify(place), decision, reason,
      );
      result.captured++;
    }
  }

  result.remaining = countRemaining(cohort);
  return result;
}

/**
 * Capture (or refresh) the listing for ONE company.
 *
 * Used on conversion — a store's Google presence is the richest free context a
 * rep can have before a call, and it goes stale, so we take a fresh copy when
 * someone becomes a customer rather than trusting whatever a prospect-era
 * enrichment left behind.
 */
export async function captureOneListing(
  companyId: string,
  opts: { force?: boolean; maxAgeDays?: number } = {},
): Promise<{ companyId: string; status: "captured" | "fresh" | "no-match" | "skipped" | "error"; reason?: string }> {
  const c = sqlite
    .prepare("SELECT id, name, city, state FROM companies WHERE id = ?")
    .get(companyId) as Target | undefined;
  if (!c || !c.name?.trim()) return { companyId, status: "skipped", reason: "no company or name" };

  if (!opts.force) {
    const existing = sqlite
      .prepare(
        `SELECT 1 FROM gmaps_listings
          WHERE company_id = ?
            AND scraped_at >= datetime('now', ?)`,
      )
      .get(companyId, `-${Math.max(1, opts.maxAgeDays ?? 90)} days`);
    if (existing) return { companyId, status: "fresh" };
  }

  try {
    const places = await apifyClient.runGoogleMapsScraper([searchStringFor(c)], {
      maxPerSearch: 1,
      fast: false,
    });
    const place = places[0];
    if (!place) return { companyId, status: "no-match" };

    const subTypes = Array.isArray(place.subTypes) ? place.subTypes
      : Array.isArray(place.categories) ? place.categories : [];

    insertStmt().run(
      crypto.randomUUID(), c.id, place.placeId ?? null, place.title ?? null,
      place.categoryName ?? null,
      Array.isArray(place.categories) ? JSON.stringify(place.categories) : null,
      subTypes.length ? JSON.stringify(subTypes) : null,
      place.totalScore ?? null, place.reviewsCount ?? null, place.price ?? null,
      place.website ?? null, place.website ? 1 : 0,
      place.phone ?? place.phoneUnformatted ?? null,
      place.address ?? null, place.city ?? null, place.state ?? null, place.postalCode ?? null,
      place.location?.lat ?? null, place.location?.lng ?? null,
      place.permanentlyClosed ? 1 : 0, place.temporarilyClosed ? 1 : 0,
      place.openingHours ? JSON.stringify(place.openingHours) : null,
      place.description ?? null, place.url ?? null,
      Array.isArray(place.imageUrls) ? place.imageUrls.length : null,
      JSON.stringify(place), "unverified", "single-company capture",
    );
    return { companyId, status: "captured" };
  } catch (e) {
    return { companyId, status: "error", reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/** The listing as the UI and Pipedrive need it. */
export interface CompanyListing {
  placeId: string | null;
  title: string | null;
  categoryName: string | null;
  categories: string[];
  subTypes: string[];
  rating: number | null;
  reviewCount: number | null;
  price: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  permanentlyClosed: boolean;
  temporarilyClosed: boolean;
  openingHours: Array<{ day: string; hours: string }>;
  description: string | null;
  mapsUrl: string | null;
  imageCount: number | null;
  scrapedAt: string | null;
}

export function getCompanyListing(companyId: string): CompanyListing | null {
  const r = sqlite
    .prepare("SELECT * FROM gmaps_listings WHERE company_id = ?")
    .get(companyId) as Record<string, unknown> | undefined;
  if (!r) return null;
  const json = <T,>(v: unknown, fallback: T): T => {
    try { return v ? (JSON.parse(String(v)) as T) : fallback; } catch { return fallback; }
  };
  return {
    placeId: (r.place_id as string) ?? null,
    title: (r.title as string) ?? null,
    categoryName: (r.category_name as string) ?? null,
    categories: json<string[]>(r.categories, []),
    subTypes: json<string[]>(r.sub_types, []),
    rating: r.rating != null ? Number(r.rating) : null,
    reviewCount: r.review_count != null ? Number(r.review_count) : null,
    price: (r.price as string) ?? null,
    website: (r.website as string) ?? null,
    phone: (r.phone as string) ?? null,
    address: (r.address as string) ?? null,
    city: (r.city as string) ?? null,
    state: (r.state as string) ?? null,
    lat: r.lat != null ? Number(r.lat) : null,
    lng: r.lng != null ? Number(r.lng) : null,
    permanentlyClosed: Number(r.permanently_closed) === 1,
    temporarilyClosed: Number(r.temporarily_closed) === 1,
    openingHours: json<Array<{ day: string; hours: string }>>(r.opening_hours, []),
    description: (r.description as string) ?? null,
    mapsUrl: (r.maps_url as string) ?? null,
    imageCount: r.image_count != null ? Number(r.image_count) : null,
    scrapedAt: (r.scraped_at as string) ?? null,
  };
}

/**
 * Cron: refresh customer listings that have gone stale.
 *
 * Ratings, review counts and opening hours drift, and a permanently-closed
 * flag we never re-check is how a rep ends up calling a shut store.
 */
export async function refreshStaleCustomerListings(
  limit = 20,
  maxAgeDays = 120,
): Promise<{ refreshed: number; noMatch: number; errors: number }> {
  const rows = sqlite
    .prepare(
      `SELECT c.id FROM companies c
        WHERE ${IS_CUSTOMER_SQL}
          AND EXISTS (SELECT 1 FROM gmaps_listings g
                       WHERE g.company_id = c.id AND g.scraped_at < datetime('now', ?))
        LIMIT ?`,
    )
    .all(`-${maxAgeDays} days`, limit) as Array<{ id: string }>;

  let refreshed = 0, noMatch = 0, errors = 0;
  for (const r of rows) {
    const res = await captureOneListing(r.id, { force: true });
    if (res.status === "captured") refreshed++;
    else if (res.status === "no-match") noMatch++;
    else if (res.status === "error") errors++;
  }
  return { refreshed, noMatch, errors };
}

// ── Phase 2: turn listings into actor input ──

export interface FeatureLift {
  value: string;
  customers: number;
  controls: number;
  customerPct: number;
  controlPct: number;
  /** customerPct / controlPct. >1 means over-represented among buyers. */
  lift: number;
}

export interface GmapsProfile {
  customerListings: number;
  controlListings: number;
  /** Google categories over-represented among buyers — these become search terms. */
  categories: FeatureLift[];
  subTypes: FeatureLift[];
  reviews: {
    customerMedian: number | null;
    controlMedian: number | null;
    customerP25: number | null;
    customerP75: number | null;
    bands: Array<{ band: string; customers: number; controls: number; lift: number }>;
  };
  rating: {
    customerMedian: number | null;
    controlMedian: number | null;
    /** The placeMinimumStars value that keeps ~90% of buyers. */
    suggestedMinimumStars: string;
  };
  website: { customerHasPct: number; controlHasPct: number; suggested: string };
  topStates: Array<{ state: string; customers: number }>;
  /** Ready-to-paste actor input. */
  suggestedActorInput: Record<string, unknown>;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

/** Apify accepts only these words for placeMinimumStars. */
function starsWord(x: number): string {
  const bands: Array<[number, string]> = [
    [4.5, "fourAndHalf"], [4, "four"], [3.5, "threeAndHalf"],
    [3, "three"], [2.5, "twoAndHalf"], [2, "two"],
  ];
  for (const [n, w] of bands) if (x >= n) return w;
  return "";
}

export function getGmapsProfile(): GmapsProfile {
  const rows = sqlite
    .prepare(
      `SELECT g.*, (${IS_CUSTOMER_SQL}) AS isCustomer
         FROM gmaps_listings g JOIN companies c ON c.id = g.company_id
        WHERE COALESCE(g.permanently_closed,0) = 0`,
    )
    .all() as Array<Record<string, unknown>>;

  const cust = rows.filter((r) => Number(r.isCustomer) === 1);
  const ctrl = rows.filter((r) => Number(r.isCustomer) !== 1);

  const liftOf = (pick: (r: Record<string, unknown>) => string[]): FeatureLift[] => {
    const c = new Map<string, number>();
    const k = new Map<string, number>();
    for (const r of cust) for (const v of new Set(pick(r))) c.set(v, (c.get(v) ?? 0) + 1);
    for (const r of ctrl) for (const v of new Set(pick(r))) k.set(v, (k.get(v) ?? 0) + 1);
    const out: FeatureLift[] = [];
    for (const [value, n] of c) {
      const cn = k.get(value) ?? 0;
      const customerPct = cust.length ? (n / cust.length) * 100 : 0;
      // Smooth the denominator: a category with zero controls would otherwise
      // show infinite lift off a single customer.
      const controlPct = ctrl.length ? (cn / ctrl.length) * 100 : 0;
      out.push({
        value, customers: n, controls: cn,
        customerPct: Math.round(customerPct * 10) / 10,
        controlPct: Math.round(controlPct * 10) / 10,
        lift: Math.round((customerPct / Math.max(controlPct, 0.5)) * 100) / 100,
      });
    }
    return out.sort((a, b) => b.customers - a.customers || b.lift - a.lift);
  };

  const cats = liftOf((r) => (r.category_name ? [String(r.category_name)] : []));
  const subs = liftOf((r) => {
    try { return r.sub_types ? (JSON.parse(String(r.sub_types)) as string[]) : []; } catch { return []; }
  });

  const custReviews = cust.map((r) => Number(r.review_count)).filter((n) => Number.isFinite(n));
  const ctrlReviews = ctrl.map((r) => Number(r.review_count)).filter((n) => Number.isFinite(n));
  const custRatings = cust.map((r) => Number(r.rating)).filter((n) => Number.isFinite(n) && n > 0);
  const ctrlRatings = ctrl.map((r) => Number(r.rating)).filter((n) => Number.isFinite(n) && n > 0);

  const bandOf = (n: number) => n < 25 ? "0-24" : n < 100 ? "25-99" : n < 500 ? "100-499" : "500+";
  const bandNames = ["0-24", "25-99", "100-499", "500+"];
  const bands = bandNames.map((band) => {
    const c = custReviews.filter((n) => bandOf(n) === band).length;
    const k = ctrlReviews.filter((n) => bandOf(n) === band).length;
    const cp = custReviews.length ? (c / custReviews.length) * 100 : 0;
    const kp = ctrlReviews.length ? (k / ctrlReviews.length) * 100 : 0;
    return { band, customers: c, controls: k, lift: Math.round((cp / Math.max(kp, 0.5)) * 100) / 100 };
  });

  const custWebPct = cust.length ? (cust.filter((r) => Number(r.has_website) === 1).length / cust.length) * 100 : 0;
  const ctrlWebPct = ctrl.length ? (ctrl.filter((r) => Number(r.has_website) === 1).length / ctrl.length) * 100 : 0;

  const states = new Map<string, number>();
  for (const r of cust) {
    const st = String(r.state || "").trim();
    if (st) states.set(st, (states.get(st) ?? 0) + 1);
  }

  // Keep ~90% of buyers rather than the median — a minimum-stars filter set at
  // the median throws away half of the very population we're trying to clone.
  const ratingFloor = percentile(custRatings, 10) ?? 0;
  const p25Reviews = percentile(custReviews, 25);

  const topCats = cats.filter((c) => c.customers >= 2).slice(0, 12);

  return {
    customerListings: cust.length,
    controlListings: ctrl.length,
    categories: topCats,
    subTypes: subs.filter((s) => s.customers >= 2).slice(0, 20),
    reviews: {
      customerMedian: median(custReviews),
      controlMedian: median(ctrlReviews),
      customerP25: p25Reviews,
      customerP75: percentile(custReviews, 75),
      bands,
    },
    rating: {
      customerMedian: median(custRatings),
      controlMedian: median(ctrlRatings),
      suggestedMinimumStars: starsWord(ratingFloor),
    },
    website: {
      customerHasPct: Math.round(custWebPct * 10) / 10,
      controlHasPct: Math.round(ctrlWebPct * 10) / 10,
      // Only worth filtering on if buyers clearly differ from non-buyers.
      suggested: custWebPct >= 85 && custWebPct - ctrlWebPct > 10 ? "withWebsite" : "allPlaces",
    },
    topStates: [...states.entries()].map(([state, customers]) => ({ state, customers }))
      .sort((a, b) => b.customers - a.customers).slice(0, 15),
    suggestedActorInput: {
      searchStringsArray: topCats.slice(0, 6).map((c) => c.value),
      categoryFilterWords: topCats.slice(0, 6).map((c) => c.value),
      placeMinimumStars: starsWord(ratingFloor),
      website: custWebPct >= 85 && custWebPct - ctrlWebPct > 10 ? "withWebsite" : "allPlaces",
      skipClosedPlaces: true,
      language: "en",
      countryCode: "us",
      maxCrawledPlacesPerSearch: 200,
      // locationQuery is intentionally left to the caller — geography is a
      // territory decision, not something to infer from where we happen to
      // have sold already.
      locationQuery: "<city, state>",
      _postFilter: {
        minReviewCount: p25Reviews,
        note: "Review count isn't a native actor filter; apply it when scoring the scrape.",
      },
    },
  };
}
