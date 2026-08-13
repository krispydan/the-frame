/**
 * Apify API client.
 *
 * Base URL: https://api.apify.com/v2
 * Auth:     ?token=<APIFY_API_TOKEN> query param
 *
 * Used for the Google Maps Scraper actor (compass/google-maps-scraper)
 * which enriches a boutique with phone, hours, address, rating, and
 * permanent-closed status from Google Maps.
 *
 * We use the run-sync-get-dataset-items endpoint so each batch call
 * returns the dataset rows directly without separate run-status polls.
 * Each call accepts a batch of searchStrings, which is dramatically
 * cheaper than 1 actor run per place (Apify charges per actor run +
 * per CU; batched runs amortize the overhead).
 */


const APIFY_BASE = "https://api.apify.com/v2";

/**
 * Apify Google Maps actor — the URL-encoded "username~actor-name" form.
 * Override at deploy time via env if Apify renames or you want to
 * point at a different actor.
 *
 * Verified working 2026-06-30: compass~crawler-google-places (actor
 * ID nwua9Gu5YrADL7ZDj). The previous name (google-maps-scraper)
 * returned 404 — Apify must have renamed or merged the listing.
 */
const ACTOR_GMAPS =
  process.env.APIFY_GMAPS_ACTOR_ID || "compass~crawler-google-places";

export interface GoogleMapsPlace {
  /** Stable Google place id. Store on the company. */
  placeId?: string;
  /** Maps URL — handy link for Sandra's notes. */
  url?: string;
  /** Business name as Google has it. */
  title?: string;
  /** Free-text full address. */
  address?: string;
  /** Decomposed parts (sometimes null even when address is set). */
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
  /** Lat/long for map plotting. */
  location?: { lat: number; lng: number };
  /** Phone — the prize. May include country code and formatting. */
  phone?: string;
  /** Phone in unformatted digits. */
  phoneUnformatted?: string;
  /** Business website per Google. */
  website?: string;
  /** Google's categorization. */
  categoryName?: string;
  categories?: string[];
  /** Granular sub-types per Google ("Bridal shop", "Maternity store",
   *  "Children's clothing store") — finer-grained than `categories`
   *  and what we key off of for ICP-disqualification. Field name has
   *  varied across actor revisions; we read whichever is present. */
  subTypes?: string[];
  subtitle?: string;
  /** Optional business description Google has on file. Many boutiques
   *  don't have one; nullable. */
  description?: string;
  /** Star rating + review count = ICP signal. */
  totalScore?: number;
  reviewsCount?: number;
  price?: string;
  /** Status flags. */
  temporarilyClosed?: boolean;
  permanentlyClosed?: boolean;
  /** Hours per day. Sandra needs these. */
  openingHours?: Array<{ day: string; hours: string }>;
  /** Whether the search string we sent actually matches this place
   *  with high confidence. Apify populates this on most results. */
  searchString?: string;
  /** Image URLs — useful for Christina's personalized email merge. */
  imageUrls?: string[];
  /** Catch-all for any other fields the actor returns. */
  [k: string]: unknown;
}

class ApifyClient {
  private envToken: string | null;
  private maxRetries = 3;

  constructor() {
    this.envToken = process.env.APIFY_API_TOKEN || null;
  }

  /**
   * Resolve token — env first, then settings.apify_api_token. Matches
   * the lookup pattern of phoneburner-client / instantly-client so the
   * settings UI can override without a restart.
   */
  private resolveApiKey(): string | null {
    if (this.envToken) return this.envToken;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { sqlite } = require("@/lib/db") as {
        sqlite: {
          prepare: (s: string) => { get: () => { value?: string } | undefined };
        };
      };
      const row = sqlite
        .prepare(`SELECT value FROM settings WHERE key='apify_api_token' LIMIT 1`)
        .get();
      const val = row?.value?.trim();
      return val && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  get isMock(): boolean {
    return !this.resolveApiKey();
  }

  /**
   * Run the Google Maps Scraper actor synchronously and return the
   * dataset rows. Apify holds the connection open until the actor
   * finishes (typically ~30-90 seconds for a 50-place batch).
   *
   * Batch hint: pass 20-50 search strings per call. Apify's per-actor
   * overhead is amortized over the batch, and the response stays
   * under a few MB.
   *
   * @param searchStrings  e.g. ["The Yellow Button, Brooklyn, NY", ...]
   * @param opts.maxPerSearch  cap the number of Google results per
   *   search string. Default 1 — we just want the top match.
   */
  async runGoogleMapsScraper(
    searchStrings: string[],
    opts: { maxPerSearch?: number; timeoutSecs?: number; fast?: boolean } = {},
  ): Promise<GoogleMapsPlace[]> {
    const token = this.resolveApiKey();
    if (!token) {
      throw new Error(
        "Apify not configured — set APIFY_API_TOKEN env or settings.apify_api_token",
      );
    }
    if (searchStrings.length === 0) return [];

    // run-sync-get-dataset-items has a hard 300-second ceiling — the error it
    // returns says so explicitly ("exceeded the timeout of 300 seconds for
    // this API endpoint"). We used to ask for 600, which Apify simply
    // ignored; asking for what we can actually get keeps the client-side
    // bound below honest rather than 5 minutes too generous.
    const apifyTimeoutSecs = opts.timeoutSecs ?? 300;
    const url = `${APIFY_BASE}/acts/${ACTOR_GMAPS}/run-sync-get-dataset-items?token=${token}&timeout=${apifyTimeoutSecs}`;
    const body = {
      searchStringsArray: searchStrings,
      // Search-result tuning
      maxCrawledPlacesPerSearch: opts.maxPerSearch ?? 1,
      language: "en",
      countryCode: "us",
      // Skip noise fields we don't use to keep response smaller
      includeReviews: false,
      includeImages: false,
      // fast mode: skip the per-place detail-page crawl + hours — the street
      // address, city/state, and postal code are in the search result, so we
      // don't need the (slow) detail page just to get a mailing address.
      includeOpeningHours: !opts.fast,
      includePeopleAlsoSearch: false,
      includePopularTimes: false,
      includeWebResults: false,
      scrapePlaceDetailPage: !opts.fast,
    };

    // Retry policy: 429 (rate-limit) gets backed off and retried up
    // to maxRetries. EVERYTHING ELSE fails fast — a timeout retried
    // 3 times is just 3 timeouts, wasting wall-clock. The enrichment
    // loader stamps failed batches as 'batch_error' so they don't
    // come back next tick.
    // Node's fetch has NO default timeout. Apify's sync endpoint is supposed
    // to answer within its own 300s ceiling, but a stalled connection just
    // hangs — and a hung call here holds whatever called it open forever. In
    // cron that means the job's in_progress lock is never released, so the
    // job only runs again when the 15-minute stale-lock window lets it, and
    // a "*/3" schedule silently becomes "*/15". Bound it client-side.
    const clientTimeoutMs = (apifyTimeoutSecs + 30) * 1000;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(clientTimeoutMs),
        });
      } catch (e) {
        // Surface as a normal error so callers' batch-error handling applies
        // (stamp and move on) rather than an opaque abort escaping upward.
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
          throw new Error(`Apify request timed out after ${Math.round(clientTimeoutMs / 1000)}s`);
        }
        throw e;
      }

      if (res.status === 429) {
        const wait = (attempt + 1) * 2000;
        console.log(`[apify] 429, backing off ${wait}ms (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 500)}`);
      }

      const data = (await res.json()) as GoogleMapsPlace[];
      if (!Array.isArray(data)) {
        throw new Error(
          `Apify returned non-array: ${JSON.stringify(data).slice(0, 300)}`,
        );
      }
      return data;
    }
    throw new Error("Apify request failed after rate-limit retries");
  }

  // ── Async run API ──
  //
  // run-sync-get-dataset-items (above) is right for the enrichment path: small
  // batches, answer needed on the call. It is WRONG for a wide crawl — it has
  // a hard 300-second ceiling, and a crawl that exceeds it loses the whole run
  // (the lesson from the customer backfill). These three methods start a run,
  // check on it, and collect it afterwards, so wall-clock stops mattering.

  /** Kick off a run and return immediately. */
  async startRun(input: Record<string, unknown>, actorId = ACTOR_GMAPS): Promise<{ runId: string; datasetId: string }> {
    const token = this.resolveApiKey();
    if (!token) throw new Error("Apify not configured — set APIFY_API_TOKEN env or settings.apify_api_token");

    const res = await fetch(`${APIFY_BASE}/acts/${actorId}/runs?token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Apify start HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const j = (await res.json()) as { data: { id: string; defaultDatasetId: string } };
    return { runId: j.data.id, datasetId: j.data.defaultDatasetId };
  }

  /** READY | RUNNING | SUCCEEDED | FAILED | ABORTED | TIMED-OUT */
  async getRunStatus(runId: string): Promise<{ status: string; stats: Record<string, unknown> | null }> {
    const token = this.resolveApiKey();
    if (!token) throw new Error("Apify not configured");
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Apify run status HTTP ${res.status}`);
    const j = (await res.json()) as { data: { status: string; stats?: Record<string, unknown> } };
    return { status: j.data.status, stats: j.data.stats ?? null };
  }

  /**
   * What a run actually cost. These actors bill per event, so the only honest
   * cost figure comes from the run record itself rather than from multiplying
   * rows by a list price. Reading a run is a plain API call, not an actor run,
   * so this still answers after the account has hit its usage limit — which is
   * exactly when you need it.
   */
  async getRunCost(runId: string): Promise<{
    status: string; usageTotalUsd: number | null;
    chargedEventCounts: Record<string, number> | null;
    usageUsd: Record<string, number> | null;
    startedAt: string | null; finishedAt: string | null;
  }> {
    const token = this.resolveApiKey();
    if (!token) throw new Error("Apify not configured");
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${token}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Apify run info HTTP ${res.status}`);
    const d = (await res.json()).data as Record<string, unknown>;
    return {
      status: String(d.status),
      usageTotalUsd: typeof d.usageTotalUsd === "number" ? d.usageTotalUsd : null,
      chargedEventCounts: (d.chargedEventCounts as Record<string, number>) ?? null,
      usageUsd: (d.usageUsd as Record<string, number>) ?? null,
      startedAt: (d.startedAt as string) ?? null,
      finishedAt: (d.finishedAt as string) ?? null,
    };
  }

  async getDatasetItems(datasetId: string, limit = 1000): Promise<GoogleMapsPlace[]> {
    const token = this.resolveApiKey();
    if (!token) throw new Error("Apify not configured");
    const res = await fetch(
      `${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&clean=true&format=json&limit=${limit}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) throw new Error(`Apify dataset HTTP ${res.status}`);
    const data = (await res.json()) as GoogleMapsPlace[];
    return Array.isArray(data) ? data : [];
  }
}

export const apifyClient = new ApifyClient();
