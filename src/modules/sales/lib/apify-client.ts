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
    opts: { maxPerSearch?: number; timeoutSecs?: number } = {},
  ): Promise<GoogleMapsPlace[]> {
    const token = this.resolveApiKey();
    if (!token) {
      throw new Error(
        "Apify not configured — set APIFY_API_TOKEN env or settings.apify_api_token",
      );
    }
    if (searchStrings.length === 0) return [];

    // Apify timeout: 180s (was 600). Observed overnight: ~half of
    // 25-place batches hit the 10-min client timeout exactly because
    // Apify hits a slow path on certain search strings. 3 min is
    // plenty for a 10-place batch — succeeded runs in the logs were
    // 13-42s — and fails fast on stuck batches so the cron tick
    // moves on. Caller can override via opts.timeoutSecs.
    const url = `${APIFY_BASE}/acts/${ACTOR_GMAPS}/run-sync-get-dataset-items?token=${token}&timeout=${opts.timeoutSecs ?? 180}`;
    const body = {
      searchStringsArray: searchStrings,
      // Search-result tuning
      maxCrawledPlacesPerSearch: opts.maxPerSearch ?? 1,
      language: "en",
      countryCode: "us",
      // Skip noise fields we don't use to keep response smaller
      includeReviews: false,
      includeImages: false,
      includeOpeningHours: true,
      includePeopleAlsoSearch: false,
      includePopularTimes: false,
      includeWebResults: false,
      scrapePlaceDetailPage: true,
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const wait = (attempt + 1) * 2000;
          console.log(`[apify] 429, backing off ${wait}ms (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Apify HTTP ${res.status}: ${text.slice(0, 500)}`,
          );
        }

        const data = (await res.json()) as GoogleMapsPlace[];
        if (!Array.isArray(data)) {
          throw new Error(
            `Apify returned non-array: ${JSON.stringify(data).slice(0, 300)}`,
          );
        }
        return data;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (attempt === this.maxRetries - 1) break;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastError ?? new Error("Apify request failed after retries");
  }
}

export const apifyClient = new ApifyClient();
