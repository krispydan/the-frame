/**
 * Pull every phone number StoreLeads has on every StoreLeads-sourced
 * lead in The Frame, output a dialer-ready CSV.
 *
 * Why this exists: when we imported StoreLeads rows, our schema
 * stored a single `phone` column populated from the FIRST phone in
 * StoreLeads' contact_info array. But StoreLeads often has multiple
 * phones per store (storefront + mobile + customer service). This
 * script re-queries the API for every storeleads-source company and
 * pulls ALL of them so a cold-call list isn't artificially capped
 * to one number per merchant.
 *
 * Reads source data from the prod API (paginated) so we get the
 * actual production company list — no need to sync a local DB.
 *
 * Usage:
 *   SESSION_TOKEN='eyJhbGciOiJIUzI1NiJ9...' \
 *   STORELEADS_API_KEY='ea036c31-...' \
 *   npx tsx scripts/storeleads-phones.ts [output.csv]
 *
 * Output defaults to ./storeleads-phones-YYYY-MM-DD.csv if not
 * passed. Columns:
 *   our_company_id, store_name, domain, city, state, country,
 *   icp_tier, has_email_already, primary_phone, additional_phones,
 *   num_phones, sl_location, sl_merchant_name
 */

import * as fs from "fs";
import * as Papa from "papaparse";
import {
  bulkGetStoresByDomain,
  isConfigured as storeleadsConfigured,
  type StoreLeadsDomain,
} from "../src/modules/sales/lib/storeleads/client";

const PROSPECTS_URL = "https://theframe.getjaxy.com/api/v1/sales/prospects";
const UPSERT_URL = "https://theframe.getjaxy.com/api/v1/integrations/storeleads/upsert-phones";
const PAGE_SIZE = 100;
const SL_BATCH = 100;
// Upsert in chunks of 1000 items so a single POST doesn't time out on
// the edge. ~10K per chunk × 5 chunks fits comfortably under the
// route's MAX_ITEMS = 10000 cap with margin.
const UPSERT_CHUNK = 1000;

interface ProspectRow {
  id: string;
  name: string;
  domain: string | null;
  city: string | null;
  state: string | null;
  email: string | null;
  phone: string | null;
  icp_tier: string | null;
}

async function fetchAllStoreLeadsProspects(token: string): Promise<ProspectRow[]> {
  const out: ProspectRow[] = [];
  let page = 1;
  while (true) {
    const url = `${PROSPECTS_URL}?source_type=storeleads&limit=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        cookie: `session-token=${token}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`Prospects API ${res.status}: ${await res.text().then((t) => t.slice(0, 300))}`);
    }
    const json = await res.json() as {
      data: ProspectRow[]; total: number; page: number; totalPages: number;
    };
    out.push(...json.data);
    process.stdout.write(`\r  Fetched ${out.length}/${json.total} prospects...`);
    if (page >= json.totalPages || json.data.length === 0) break;
    page++;
  }
  process.stdout.write("\n");
  return out;
}

/** Extract every phone number from a StoreLeads domain object. */
function extractPhones(sl: StoreLeadsDomain | null): string[] {
  if (!sl) return [];
  const ci = (sl as Record<string, unknown>).contact_info as
    | Array<{ type?: string; value?: string }>
    | undefined;
  if (!Array.isArray(ci)) return [];
  const phones: string[] = [];
  for (const e of ci) {
    if (e.type?.toLowerCase() === "phone" && e.value) {
      const p = String(e.value).trim();
      if (p && !phones.includes(p)) phones.push(p);
    }
  }
  return phones;
}

async function main() {
  const outputPath = process.argv[2]
    ?? `./storeleads-phones-${new Date().toISOString().slice(0, 10)}.csv`;

  const token = process.env.SESSION_TOKEN;
  if (!token) {
    console.error("SESSION_TOKEN env var required (your theframe.getjaxy.com session-token cookie)");
    process.exit(1);
  }
  if (!storeleadsConfigured()) {
    console.error("STORELEADS_API_KEY env var required");
    process.exit(1);
  }

  console.log("Fetching all StoreLeads-source prospects from prod...");
  const prospects = await fetchAllStoreLeadsProspects(token);
  console.log(`Got ${prospects.length} StoreLeads prospects.`);

  // Need a domain to ask StoreLeads about. Skip the rare row without
  // one (shouldn't happen on storeleads-source, but be defensive).
  const withDomain = prospects.filter((p) => p.domain && p.domain.trim());
  const skippedNoDomain = prospects.length - withDomain.length;
  console.log(`  with domain:        ${withDomain.length}`);
  console.log(`  skipped (no domain): ${skippedNoDomain}`);

  // Dedup by lowercased domain — multiple rows per domain would just
  // burn API credits on duplicate calls. Track the original prospects
  // per domain so we can fan results back out.
  const byDomain = new Map<string, ProspectRow[]>();
  for (const p of withDomain) {
    const d = p.domain!.toLowerCase().trim();
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(p);
  }
  const uniqueDomains = Array.from(byDomain.keys());
  console.log(`  unique domains:     ${uniqueDomains.length}`);

  // Bulk-lookup in 100-domain batches.
  const enrichments = new Map<string, StoreLeadsDomain | null>();
  for (let i = 0; i < uniqueDomains.length; i += SL_BATCH) {
    const chunk = uniqueDomains.slice(i, i + SL_BATCH);
    const t0 = Date.now();
    try {
      const map = await bulkGetStoresByDomain(chunk, { followRedirects: true });
      for (const d of chunk) enrichments.set(d, map[d] ?? null);
      const hits = chunk.filter((d) => map[d]).length;
      console.log(
        `  [${Math.min(i + SL_BATCH, uniqueDomains.length)}/${uniqueDomains.length}] ` +
        `batch hit ${hits}/${chunk.length} in ${Date.now() - t0}ms`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`  batch error: ${msg}`);
      for (const d of chunk) enrichments.set(d, null);
    }
  }

  // Build one output row per ORIGINAL prospect (not per domain) so
  // the dialer-import CSV's row count matches what Daniel sees in
  // /prospects. Multiple prospects on the same domain get the same
  // phone list — dedup at dialer-import time if needed.
  const rowsOut: Array<Record<string, unknown>> = [];
  let withAnyPhone = 0;
  let withMultiPhone = 0;
  let totalPhonesFound = 0;
  const phoneCountDist: Record<number, number> = {};

  for (const [domain, prospectsForDomain] of Array.from(byDomain.entries())) {
    const sl = enrichments.get(domain) ?? null;
    const phones = extractPhones(sl);
    const r = (sl as Record<string, unknown>) ?? {};
    phoneCountDist[phones.length] = (phoneCountDist[phones.length] ?? 0) + 1;

    for (const p of prospectsForDomain) {
      const all = phones.length ? phones : (p.phone ? [p.phone] : []);
      if (all.length > 0) withAnyPhone++;
      if (all.length > 1) withMultiPhone++;
      totalPhonesFound += all.length;
      rowsOut.push({
        our_company_id: p.id,
        store_name: p.name,
        sl_merchant_name: r.merchant_name ?? null,
        domain,
        city: p.city ?? r.city ?? null,
        state: p.state ?? r.administrative_area_level_1 ?? null,
        sl_country: r.country_code ?? null,
        sl_location: r.location ?? null,
        icp_tier: p.icp_tier ?? null,
        has_email_already: p.email && p.email.trim() ? "yes" : "no",
        num_phones: all.length,
        primary_phone: all[0] ?? "",
        additional_phones: all.slice(1).join(" | "),
      });
    }
  }

  const csv = Papa.unparse(rowsOut);
  fs.writeFileSync(outputPath, csv);

  console.log(`\nWrote ${rowsOut.length} rows → ${outputPath}`);
  console.log(`\nSummary:`);
  console.log(`  Rows with ANY phone:          ${withAnyPhone}`);
  console.log(`  Rows with >1 phone:           ${withMultiPhone}`);
  console.log(`  Total phone numbers in CSV:   ${totalPhonesFound}`);
  console.log(`\nPhone-count distribution (per unique domain):`);
  for (const k of Object.keys(phoneCountDist).map(Number).sort((a, b) => a - b)) {
    console.log(`  ${k} phones: ${phoneCountDist[k]} domains`);
  }

  // Push every (company_id, phones[]) tuple back to The Frame so the
  // numbers live in our DB long-term and a future re-run is a no-op.
  // The endpoint dedupes via INSERT OR IGNORE on (company_id, phone)
  // so re-running this script is safe.
  console.log(`\nPushing phones to The Frame...`);
  const items: Array<{ company_id: string; phones: string[]; source: string }> = [];
  for (const [domain, prospectsForDomain] of Array.from(byDomain.entries())) {
    const sl = enrichments.get(domain) ?? null;
    const phones = extractPhones(sl);
    if (phones.length === 0) continue;
    for (const p of prospectsForDomain) {
      items.push({ company_id: p.id, phones, source: "storeleads" });
    }
  }

  let totals = {
    itemsProcessed: 0,
    phoneRowsInserted: 0,
    duplicatesSkipped: 0,
    primariesAssigned: 0,
    companiesPhoneFilled: 0,
  };

  for (let i = 0; i < items.length; i += UPSERT_CHUNK) {
    const chunk = items.slice(i, i + UPSERT_CHUNK);
    const res = await fetch(UPSERT_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `session-token=${token}`,
      },
      body: JSON.stringify({ items: chunk }),
    });
    if (!res.ok) {
      console.warn(`  chunk ${i + 1}-${i + chunk.length}: HTTP ${res.status} — ${await res.text().then((t) => t.slice(0, 200))}`);
      continue;
    }
    const json = await res.json() as typeof totals & { ok: boolean };
    if (!json.ok) {
      console.warn(`  chunk ${i + 1}-${i + chunk.length}: server error`);
      continue;
    }
    totals.itemsProcessed += json.itemsProcessed;
    totals.phoneRowsInserted += json.phoneRowsInserted;
    totals.duplicatesSkipped += json.duplicatesSkipped;
    totals.primariesAssigned += json.primariesAssigned;
    totals.companiesPhoneFilled += json.companiesPhoneFilled;
    console.log(
      `  chunk ${i + 1}-${i + chunk.length}: ` +
      `+${json.phoneRowsInserted} phones inserted, ` +
      `${json.duplicatesSkipped} duplicates skipped`,
    );
  }

  console.log(`\nFrame upsert totals:`);
  console.log(`  Items processed:              ${totals.itemsProcessed}`);
  console.log(`  New phone rows inserted:      ${totals.phoneRowsInserted}`);
  console.log(`  Duplicates skipped (re-run):  ${totals.duplicatesSkipped}`);
  console.log(`  Companies given a primary:    ${totals.primariesAssigned}`);
  console.log(`  companies.phone fills:        ${totals.companiesPhoneFilled}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
