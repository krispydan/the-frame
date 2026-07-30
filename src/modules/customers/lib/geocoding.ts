/**
 * Address geocoding for the customer map.
 *
 * Uses OpenStreetMap's Nominatim (free, no API key). Nominatim's usage
 * policy requires:
 *   - a descriptive User-Agent
 *   - max 1 request/second
 * so we geocode in a rate-limited batch, cache the result on the company
 * (latitude/longitude/geocoded_at), and never re-geocode a company we've
 * already attempted (geocoded_at set) unless forced.
 *
 * Handles both US and international (Faire) addresses.
 */
import { sqlite } from "@/lib/db";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "TheFrame/1.0 (Jaxy Eyewear wholesale ops; wholesale@getjaxy.com)";
const RATE_LIMIT_MS = 1100; // just over 1/sec to respect Nominatim policy

interface CompanyRow {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

export interface GeocodeResult {
  processed: number;
  geocoded: number;
  failed: number;
  skipped: number;
}

function buildQuery(c: CompanyRow): string | null {
  // Prefer a full street address; fall back to city/state/country. If we have
  // nothing but a name, skip (name-only geocoding is unreliable).
  const parts = [c.address, c.city, c.state, c.zip, c.country].map((p) => p?.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // Require at least city+state (or a street address) to avoid garbage hits
  if (!c.address && !(c.city && c.state)) return null;
  return parts.join(", ");
}

async function geocodeOne(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=1`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string }>;
    if (!data.length) return null;
    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Geocode companies that are customers and don't yet have coordinates.
 * @param opts.limit  max companies to process this run (default 200)
 * @param opts.force  re-geocode even companies already attempted
 * @param opts.customersOnly  only geocode companies with a customer_accounts row (default true)
 */
export async function geocodeCompanies(opts?: {
  limit?: number;
  force?: boolean;
  customersOnly?: boolean;
}): Promise<GeocodeResult> {
  const limit = opts?.limit ?? 200;
  const customersOnly = opts?.customersOnly ?? true;
  const result: GeocodeResult = { processed: 0, geocoded: 0, failed: 0, skipped: 0 };

  const whereGeocoded = opts?.force ? "" : "AND c.geocoded_at IS NULL";
  const joinCustomers = customersOnly
    ? "JOIN customer_accounts ca ON ca.company_id = c.id"
    : "";

  const rows = sqlite.prepare(`
    SELECT c.id, c.name, c.address, c.city, c.state, c.zip, c.country
    FROM companies c
    ${joinCustomers}
    WHERE (c.latitude IS NULL OR c.longitude IS NULL ${opts?.force ? "OR 1=1" : ""})
    ${whereGeocoded}
    LIMIT ?
  `).all(limit) as CompanyRow[];

  const markAttempted = sqlite.prepare(
    "UPDATE companies SET latitude = ?, longitude = ?, geocoded_at = ? WHERE id = ?",
  );

  for (const c of rows) {
    result.processed++;
    const query = buildQuery(c);
    if (!query) {
      // Not enough address data — mark attempted so we don't retry endlessly.
      markAttempted.run(null, null, new Date().toISOString(), c.id);
      result.skipped++;
      continue;
    }

    const geo = await geocodeOne(query);
    if (geo) {
      markAttempted.run(geo.lat, geo.lng, new Date().toISOString(), c.id);
      result.geocoded++;
    } else {
      markAttempted.run(null, null, new Date().toISOString(), c.id);
      result.failed++;
    }

    // Respect Nominatim's rate limit
    await sleep(RATE_LIMIT_MS);
  }

  return result;
}

/**
 * Geocode a single company by id (fire-and-forget friendly). Skips if the
 * company already has coordinates unless `force`. No rate-limit sleep — this
 * is a single lookup triggered by an order, not a batch. Best-effort: returns
 * false on any failure and never throws.
 */
export async function geocodeCompanyById(companyId: string, opts?: { force?: boolean }): Promise<boolean> {
  try {
    const c = sqlite.prepare(
      "SELECT id, name, address, city, state, zip, country, latitude, geocoded_at FROM companies WHERE id = ?",
    ).get(companyId) as (CompanyRow & { latitude: number | null; geocoded_at: string | null }) | undefined;
    if (!c) return false;
    if (!opts?.force && c.latitude != null) return true; // already mapped

    const query = buildQuery(c);
    const mark = sqlite.prepare(
      "UPDATE companies SET latitude = ?, longitude = ?, geocoded_at = ? WHERE id = ?",
    );
    if (!query) {
      mark.run(null, null, new Date().toISOString(), c.id);
      return false;
    }
    const geo = await geocodeOne(query);
    mark.run(geo?.lat ?? null, geo?.lng ?? null, new Date().toISOString(), c.id);
    return !!geo;
  } catch {
    return false;
  }
}

/** Count of customer companies still needing geocoding (for progress UI). */
export function countUngeocodedCustomers(): number {
  return (sqlite.prepare(`
    SELECT COUNT(*) AS c
    FROM companies co
    JOIN customer_accounts ca ON ca.company_id = co.id
    WHERE co.geocoded_at IS NULL
  `).get() as { c: number }).c;
}
