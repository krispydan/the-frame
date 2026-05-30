/**
 * StoreLeads.app API client.
 *
 * Auth:    Bearer token via Authorization header (STORELEADS_API_KEY env).
 * Errors:  Standard HTTP codes — 4xx for caller errors, 5xx for theirs.
 * 429s:    Honour the Retry-After header; one automatic retry per call.
 * HTTPS-only — the docs explicitly say plain HTTP requests fail.
 *
 * Doc references (Daniel's saved snapshot, May 2026):
 *   - Auth + errors + rate limits      → §Authentication / Errors / Rate Limits
 *   - GET   /domain/{name}             → Retrieve a Domain by Name
 *   - POST  /domain/bulk               → Bulk Retrieve Domains By Name (≤100/req)
 *   - GET   /domain?<f:*>              → List Domains (advanced search, cursor pagination)
 *   - PUT   /list/{name}/add-domains   → Add Domains to List (≤10,000/req)
 *
 * Per-endpoint rate limits on Pro/Elite (our tier):
 *   - Single-domain GET   : 5 req/s
 *   - Bulk POST           : 5 req/s
 *   - List Domains        : 2 req/s (cursor=all = 1/min)
 *   - Add to list (PUT)   : 3 req/s
 *
 * The client doesn't pace pre-emptively — it lets the API throw 429 and
 * retries once with the server-provided Retry-After. Callers that loop
 * (the lookalike search, bulk enrichment) should add their own per-call
 * sleep matching the endpoint they're hitting.
 */

const BASE_URL = "https://storeleads.app/json/api/v1/all";

function getApiKey(): string {
  const k = process.env.STORELEADS_API_KEY;
  if (!k) throw new Error("STORELEADS_API_KEY is not configured");
  return k;
}

export function isConfigured(): boolean {
  return !!process.env.STORELEADS_API_KEY;
}

interface RequestOpts {
  /** AbortSignal so long-running UI calls can be cancelled. */
  signal?: AbortSignal;
  /** Caller-friendly label for error messages. */
  label?: string;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown | undefined,
  opts: RequestOpts = {},
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getApiKey()}`,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const init: RequestInit = {
    method,
    headers,
    signal: opts.signal,
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  let res = await fetch(url, init);

  // One retry on 429 honouring Retry-After (seconds). If the second
  // request also 429s we surface the error so the caller can back off
  // further — retrying indefinitely would chew through the rate budget.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("Retry-After") || "1");
    const waitMs = Math.max(1, Math.min(60, retryAfter)) * 1000;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(url, init);
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new StoreLeadsError(
      `StoreLeads ${opts.label ?? method + " " + path} failed: ${res.status} ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 300)}` : ""}`,
      res.status,
      bodyText,
    );
  }

  return (await res.json()) as T;
}

export class StoreLeadsError extends Error {
  constructor(message: string, public status: number, public bodyPreview: string) {
    super(message);
    this.name = "StoreLeadsError";
  }
}

// ─── Domain object — only the fields we currently care about ──────────────
//
// The full StoreLeads domain object has ~150 attributes (themes, apps,
// historical platform changes, A/B test data, …). We type only the ones
// we read in the importer + enrichment paths and leave a passthrough
// `[key: string]: unknown` escape hatch so unanticipated fields don't
// silently fail the JSON parse.

export interface ContactInfoEntry {
  /** The email / phone / URL. */
  value: string;
  /** Relative URL of the page where we found this. */
  source?: string;
  /** "email" | "phone" | "twitter" | "facebook" | "instagram" | "pinterest"
   *  | "tiktok" | "youtube" | "snapchat" | "linkedin" | "yelp" | … */
  type: string;
  /** Follower count (Twitter / Pinterest / TikTok / YouTube). */
  followers?: number;
}

export interface StoreLeadsDomain {
  /** Public domain name (e.g. "merchant.com"). */
  domain: string;
  /** Platform domain (e.g. "merchant.myshopify.com") when applicable. */
  platform_domain?: string;
  /** The ecommerce platform — "shopify" / "woocommerce" / "magento" / … */
  platform?: string;
  /** Merchant display name. */
  merchant_name?: string;
  description?: string;
  /** "/Apparel/Women's Clothing" style slugs. */
  categories?: string[];
  /** "shopify_plus" | "shopify_basic" | … (Shopify only). */
  plan?: string;
  /** State / county (administrative_area_level_1 in StoreLeads). */
  state?: string;
  city?: string;
  country_code?: string;
  language_code?: string;
  currency_code?: string;
  employee_count?: number;
  estimated_visits?: number;
  estimated_page_views?: number;
  /** USD cents — monthly. */
  estimated_sales?: number;
  /** USD cents — yearly. */
  estimated_sales_yearly?: number;
  /** USD cents — average product price. */
  avg_price_usd?: number;
  max_price_usd?: number;
  /** When StoreLeads first saw this store. */
  created_at?: string;
  last_updated_at?: string;
  /** Set on domains they consider inactive (closed shop). */
  inactive_at?: string;
  /** Site-pull excerpt + per-channel social handles. */
  contact_info?: ContactInfoEntry[];
  contact_page?: string;
  /** Tech-stack apps installed; shape varies by platform. */
  apps?: Array<{ platform: string; name?: string; token?: string }>;
  /** Anything else they ship that we haven't typed yet. */
  [key: string]: unknown;
}

// ─── Endpoints ────────────────────────────────────────────────────────────

/**
 * GET /domain/{name} — Retrieve a single Domain by name.
 *
 * @param name      Public domain (`merchant.com`) or platform domain
 *                  (`merchant.myshopify.com`).
 * @param opts.followRedirects When true, if the domain redirects to another
 *                  StoreLeads returns that final domain's data in one call
 *                  instead of forcing us to make a 2nd lookup.
 */
export async function getStoreByDomain(
  name: string,
  opts: { followRedirects?: boolean } & RequestOpts = {},
): Promise<StoreLeadsDomain | null> {
  const params = new URLSearchParams();
  if (opts.followRedirects) params.set("follow_redirects", "true");
  const qs = params.toString();
  const path = `/domain/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`;
  try {
    const res = await request<{ domain: StoreLeadsDomain }>(
      "GET",
      path,
      undefined,
      { ...opts, label: `getStoreByDomain(${name})` },
    );
    return res.domain ?? null;
  } catch (e) {
    if (e instanceof StoreLeadsError && e.status === 404) return null;
    throw e;
  }
}

/**
 * POST /domain/bulk — Bulk Retrieve Domains By Name (≤100 per request).
 *
 * Unrecognised domains are silently omitted from the response — the order
 * is NOT guaranteed, so we return a keyed map.
 */
export async function bulkGetStoresByDomain(
  domains: string[],
  opts: { followRedirects?: boolean } & RequestOpts = {},
): Promise<Record<string, StoreLeadsDomain>> {
  if (domains.length === 0) return {};
  if (domains.length > 100) {
    throw new Error(`bulkGetStoresByDomain: max 100 per request, got ${domains.length}`);
  }
  const body: Record<string, unknown> = { domains };
  if (opts.followRedirects) body.follow_redirects = true;
  const res = await request<{ domains: StoreLeadsDomain[] }>(
    "POST",
    "/domain/bulk",
    body,
    { ...opts, label: `bulkGetStoresByDomain(${domains.length})` },
  );
  const map: Record<string, StoreLeadsDomain> = {};
  // The bulk response has no top-level `domain` field on each record —
  // identifying fields are `cluster_best_ranked` (the canonical public
  // domain) and `platform_domain` (e.g. *.myshopify.com). We key by the
  // ORIGINAL requested domain so callers can match input→output, then
  // also index by cluster_best_ranked + platform_domain as fallbacks
  // for cases where StoreLeads redirected and the input/output strings
  // differ.
  const requested = new Set(domains.map((d) => d.toLowerCase()));
  for (const d of res.domains ?? []) {
    const candidates = [
      (d as { domain?: string }).domain,
      (d as { cluster_best_ranked?: string }).cluster_best_ranked,
      (d as { platform_domain?: string }).platform_domain,
    ];
    for (const c of candidates) {
      if (!c) continue;
      const k = c.toLowerCase();
      if (requested.has(k)) map[k] = d;
      // Always also store under cluster_best_ranked so subsequent callers
      // can look up by canonical domain without the original request set.
      if (!map[k]) map[k] = d;
    }
  }
  return map;
}

/**
 * GET /domain?<f:*> — List Domains (advanced search).
 *
 * Pass StoreLeads `f:*` filters as a flat record (e.g.
 *   `{ "f:cc": "US", "f:platform": "shopify", "f:cat": "/Apparel/" }`).
 * Returns one page; pass back the `next_cursor` for the next page.
 *
 * Note: this endpoint is rate-limited harder (2 rps on Pro/Elite). The
 * lookalike search loops this; pace 600ms+ between calls.
 */
export async function searchDomains(opts: {
  filters?: Record<string, string | number | boolean>;
  /** Advanced-search query string (mutually exclusive with f:* filters). */
  aq?: string;
  pageSize?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<{ domains: StoreLeadsDomain[]; nextCursor: string | null; total?: number }> {
  const params = new URLSearchParams();
  if (opts.aq) params.set("aq", opts.aq);
  if (opts.pageSize) params.set("page_size", String(opts.pageSize));
  if (opts.cursor) params.set("cursor", opts.cursor);
  for (const [k, v] of Object.entries(opts.filters ?? {})) {
    params.set(k, String(v));
  }
  const res = await request<{
    domains?: StoreLeadsDomain[];
    next_cursor?: string;
    total?: number;
  }>("GET", `/domain?${params.toString()}`, undefined, {
    signal: opts.signal,
    label: "searchDomains",
  });
  return {
    domains: res.domains ?? [],
    nextCursor: res.next_cursor ?? null,
    total: res.total,
  };
}

/**
 * PUT /list/{name}/add-domains — Add domains to a named List (≤10k per req).
 *
 * Returns the count of successfully-added domains + the unrecognised ones
 * StoreLeads didn't find in their database. Per docs: do NOT send
 * concurrent requests to this endpoint, and the list cannot be one
 * created by saving a search.
 */
export async function addDomainsToList(opts: {
  listName: string;
  domains: string[];
  signal?: AbortSignal;
}): Promise<{
  list: { id: number; name: string; author_email?: string };
  countAdded: number;
  unrecognized: string[];
}> {
  if (opts.domains.length === 0) {
    throw new Error("addDomainsToList: empty domains array");
  }
  if (opts.domains.length > 10000) {
    throw new Error(`addDomainsToList: max 10,000 per request, got ${opts.domains.length}`);
  }
  const res = await request<{
    list: { id: number; name: string; author_email?: string };
    count_domains_added: number;
    unrecognized_domains?: string[];
  }>(
    "PUT",
    `/list/${encodeURIComponent(opts.listName)}/add-domains`,
    { domains: opts.domains },
    { signal: opts.signal, label: `addDomainsToList(${opts.listName})` },
  );
  return {
    list: res.list,
    countAdded: res.count_domains_added,
    unrecognized: res.unrecognized_domains ?? [],
  };
}

/**
 * Lightweight connection probe used by the integrations settings page's
 * "Test connection" button. Returns true on a successful 2xx from a small
 * GET against the API.
 */
export async function testConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Looking up a single well-known domain is the cheapest non-empty
    // call. shopify.com is StoreLeads' own platform anchor.
    await getStoreByDomain("shopify.com");
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
