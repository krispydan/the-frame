import { sqlite } from "@/lib/db";
import { apifyClient } from "./apify-client";
import { dedupeTagsArray } from "./dedupe-tags";

/**
 * Catalog direct-mail campaign — shared cohort + address-enrichment logic used
 * by both the admin route and the drain cron.
 *
 * Cohort = companies with an OPEN deal in the Pipedrive "Catalog Interested"
 * pipeline (pipedrive_deals.pipeline='catalog'), excluding anyone with an order
 * or customer status. We mail them a physical catalog, so we need a full street
 * address; missing ones are filled from Apify Google Maps.
 */

export const MAILED_TAG = "catalog_mailed_2026";
/** Tag on companies we tried to enrich but Google Maps couldn't confirm — keeps
 *  the drain cron from retrying unmatchable stores forever. */
export const NO_ADDRESS_TAG = "catalog_addr_no_result";

export interface CohortRow {
  companyId: string;
  store: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  addressComplete: boolean;
  pipedriveDealId: number | null;
  pipedriveOrgId: number | null;
  pipedrivePersonId: number | null;
  dealStage: string | null;
  alreadyMailed: boolean;
  noAddressResult: boolean;
  website: string | null;
}

/** Full mailing address = street with a number + city + state + zip. */
export function isComplete(r: { address: string; city: string; state: string; zip: string }): boolean {
  return !!(r.address.trim() && /\d/.test(r.address) && r.city.trim() && r.state.trim() && r.zip.trim());
}

export function loadCatalogCohort(): CohortRow[] {
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.address, c.city, c.state, c.zip, c.tags, c.website,
              c.pipedrive_org_id AS orgId, c.pipedrive_person_id AS personId,
              d.pipedrive_deal_id AS dealId, d.stage AS stage,
              (SELECT TRIM(ct.first_name || ' ' || COALESCE(ct.last_name,'')) FROM contacts ct
                WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS contactName,
              (SELECT ct.email FROM contacts ct
                WHERE ct.company_id = c.id AND TRIM(COALESCE(ct.email,'')) <> ''
                ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
              (SELECT cp.phone FROM company_phones cp
                WHERE cp.company_id = c.id ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS phone
       FROM companies c
       JOIN pipedrive_deals d ON d.company_id = c.id AND d.pipeline = 'catalog' AND d.is_open = 1
       WHERE c.status != 'customer'
         AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.company_id = c.id)
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as Array<{
    id: string; name: string; address: string | null; city: string | null; state: string | null; zip: string | null;
    tags: string | null; website: string | null; orgId: number | null; personId: number | null; dealId: number | null;
    stage: string | null; contactName: string | null; email: string | null; phone: string | null;
  }>;

  return rows.map((r) => {
    const base = { address: r.address ?? "", city: r.city ?? "", state: r.state ?? "", zip: r.zip ?? "" };
    const tags = (r.tags || "").toLowerCase();
    return {
      companyId: r.id,
      store: r.name,
      contactName: r.contactName ?? "",
      email: r.email ?? "",
      phone: r.phone ?? "",
      ...base,
      addressComplete: isComplete(base),
      pipedriveDealId: r.dealId,
      pipedriveOrgId: r.orgId,
      pipedrivePersonId: r.personId,
      dealStage: r.stage,
      alreadyMailed: tags.includes(MAILED_TAG),
      noAddressResult: tags.includes(NO_ADDRESS_TAG),
      website: r.website,
    };
  });
}

export function tagCompany(companyId: string, tag: string): void {
  const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
  let existing: string[] = [];
  try {
    existing = row?.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    existing = row?.tags ? row.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  sqlite.prepare("UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(dedupeTagsArray([...existing, tag])), companyId);
}

/** Clear the no-result tag from cohort companies so they're retried (used after
 *  a logic fix that may have wrongly tagged transient Apify failures). */
export function resetNoResultTags(): number {
  const strip = new Set([NO_ADDRESS_TAG, "catalog_addr_try1"]);
  const rows = sqlite
    .prepare(`SELECT id, tags FROM companies WHERE tags LIKE ? OR tags LIKE ?`)
    .all(`%${NO_ADDRESS_TAG}%`, `%catalog_addr_try1%`) as Array<{ id: string; tags: string | null }>;
  let cleared = 0;
  for (const r of rows) {
    let tags: string[] = [];
    try {
      tags = r.tags ? (JSON.parse(r.tags) as string[]) : [];
    } catch {
      tags = r.tags ? r.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
    }
    const next = tags.filter((t) => !strip.has(t));
    if (next.length !== tags.length) {
      sqlite.prepare("UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(next), r.id);
      cleared++;
    }
  }
  return cleared;
}

const compressName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Diagnostic: run Apify for a few missing-address targets and report what came
 *  back + the match decision, WITHOUT writing or tagging. */
export async function debugCatalogEnrich(limit = 3): Promise<unknown[]> {
  const targets = loadCatalogCohort().filter((r) => !r.addressComplete && !r.noAddressResult).slice(0, limit);
  const queries = targets.map(queryFor);
  // Per-target single fast lookups (mirrors enrichOne) so one slow store doesn't
  // hide the others.
  const perTarget = await Promise.all(
    queries.map(async (q) => {
      try {
        const r = await apifyClient.runGoogleMapsScraper([q], { maxPerSearch: 1, timeoutSecs: 90, fast: true });
        return { place: r[0] ?? null, apifyError: null as string | null };
      } catch (e) {
        return { place: null, apifyError: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      }
    }),
  );
  return targets.map((t, j) => {
    const place = perTarget[j].place;
    const apifyError = perTarget[j].apifyError;
    const street = place ? String(place.street || "").trim() || String(place.address || "").split(",")[0]?.trim() || "" : "";
    const sameName = !!compressName(String(place?.title || "")) && (compressName(String(place?.title || "")).includes(compressName(t.store)) || compressName(t.store).includes(compressName(String(place?.title || ""))));
    const sameDomain = !!domainOf(place?.website) && domainOf(place?.website) === domainOf(t.website);
    return {
      store: t.store,
      query: queries[j],
      apifyError,
      returned: !!place,
      apifyTitle: place?.title ?? null,
      apifyStreet: place?.street ?? null,
      apifyAddress: place?.address ?? null,
      apifyPostal: place?.postalCode ?? null,
      apifyWebsite: place?.website ?? null,
      extractedStreet: street,
      hasStreetNumber: /\d/.test(street),
      sameName,
      sameDomain,
      wouldFill: !!place && /\d/.test(street) && (sameName || sameDomain),
    };
  });
}

const compress = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}
function queryFor(t: CohortRow): string {
  const geo = [t.city, t.state].filter(Boolean).join(", ");
  return geo ? `${t.store}, ${geo}` : `${t.store} store USA`;
}

/**
 * Enrich a bounded chunk of the cohort's missing addresses via Apify Google
 * Maps. Fill-only (never overwrites a good address); match-gated by name/domain
 * so we don't mail the wrong business; failures get NO_ADDRESS_TAG so the drain
 * cron converges. Small batches + short Apify timeout so a single invocation
 * stays bounded. Returns per-run counts + how many still need an address.
 */
const TRY_TAG = "catalog_addr_try1";

/** Enrich one catalog target: single fast Apify lookup, match-gated write.
 *  Returns "filled" | "nomatch" (Apify returned but no usable/ matching address)
 *  | "timeout" (Apify failed — transient). */
async function enrichOne(t: CohortRow): Promise<"filled" | "nomatch" | "timeout"> {
  const q = queryFor(t);
  let places: Awaited<ReturnType<typeof apifyClient.runGoogleMapsScraper>>;
  try {
    places = await apifyClient.runGoogleMapsScraper([q], { maxPerSearch: 1, timeoutSecs: 90, fast: true });
  } catch {
    return "timeout";
  }
  const place = places[0];
  const street = place ? String(place.street || "").trim() || String(place.address || "").split(",")[0]?.trim() || "" : "";
  const a = compress(String(place?.title || ""));
  const b = compress(t.store);
  const sameName = !!a && !!b && (a.includes(b) || b.includes(a));
  const sameDomain = !!domainOf(place?.website) && domainOf(place?.website) === domainOf(t.website);
  if (!place || !/\d/.test(street) || !(sameName || sameDomain)) return "nomatch";
  sqlite
    .prepare(
      `UPDATE companies SET
         address = CASE WHEN COALESCE(TRIM(address),'') = '' OR address NOT GLOB '*[0-9]*' THEN ? ELSE address END,
         city    = COALESCE(NULLIF(city, ''), ?),
         state   = COALESCE(NULLIF(state, ''), ?),
         zip     = COALESCE(NULLIF(zip, ''), ?),
         google_place_id = COALESCE(google_place_id, ?),
         updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(street, place.city || null, place.state || null, place.postalCode || null, place.placeId || null, t.companyId);
  return "filled";
}

/**
 * Enrich a bounded chunk of missing addresses. Each target is looked up with
 * its OWN fast Apify run (concurrency-limited) so a slow online-only store times
 * out alone instead of poisoning a batch. Genuine no-matches are tagged
 * no-result immediately; a transient timeout tags TRY_TAG on the first miss and
 * no-result on the second, so the drain converges even for stores Apify can't
 * resolve.
 */
export async function enrichCatalogChunk(limit = 12): Promise<{ processed: number; filled: number; noResult: number; deferred: number; remaining: number }> {
  const cohort = loadCatalogCohort();
  const targets = cohort.filter((r) => !r.addressComplete && !r.noAddressResult).slice(0, limit);
  let processed = 0,
    filled = 0,
    noResult = 0,
    deferred = 0;

  const CONCURRENCY = 6;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const wave = targets.slice(i, i + CONCURRENCY);
    const outcomes = await Promise.all(wave.map((t) => enrichOne(t).catch(() => "timeout" as const)));
    for (let k = 0; k < wave.length; k++) {
      const t = wave[k];
      const outcome = outcomes[k];
      processed++;
      if (outcome === "filled") {
        filled++;
      } else if (outcome === "nomatch") {
        tagCompany(t.companyId, NO_ADDRESS_TAG);
        noResult++;
      } else {
        // timeout — give it one retry across runs, then give up.
        const tried = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(t.companyId) as { tags: string | null } | undefined;
        if ((tried?.tags || "").includes(TRY_TAG)) {
          tagCompany(t.companyId, NO_ADDRESS_TAG);
          noResult++;
        } else {
          tagCompany(t.companyId, TRY_TAG);
          deferred++;
        }
      }
    }
  }

  const remaining = loadCatalogCohort().filter((r) => !r.addressComplete && !r.noAddressResult).length;
  return { processed, filled, noResult, deferred, remaining };
}
