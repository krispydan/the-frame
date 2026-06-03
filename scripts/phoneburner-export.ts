/**
 * Build a PhoneBurner-ready CSV: 100 vintage + 100 boutique stores
 * with phone numbers, from our StoreLeads-source prospects.
 *
 * Capped at 200 rows total to fit the PhoneBurner free-trial limit.
 * Each bucket is sorted by ICP score (highest first), so the test
 * dials hit our best-fit leads first.
 *
 * Output columns match PhoneBurner's pb-import-template + a small
 * set of custom fields Daniel asked for (Company ID, Store Name,
 * Type, Domain, ICP Tier, Industry):
 *
 *   First Name, Last Name, Phone, Email,
 *   Address Line 1, Address Line 2, City, State, Zip,
 *   Team, Color,
 *   Company ID, Store Name, Type, Domain, ICP Tier, Industry
 *
 * Usage:
 *   SESSION_TOKEN='<paste session-token cookie>' \
 *   npx tsx scripts/phoneburner-export.ts [output.csv]
 *
 * Default output: ./phoneburner-import-YYYY-MM-DD.csv
 */

import * as fs from "fs";
import * as Papa from "papaparse";

const PROSPECTS_URL = "https://theframe.getjaxy.com/api/v1/sales/prospects";
const PER_BUCKET = 100;
const TRIAL_CAP = 200;

interface Prospect {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  phone: string | null;
  email: string | null;
  icp_score: number | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  category: string | null;
  source_query: string | null;
  status: string | null;
}

async function fetchBucket(token: string, search: string): Promise<Prospect[]> {
  // /prospects caps limit at 100 — perfect for 100-per-bucket. Sort
  // by icp_score DESC so the trial dials our best-fit leads first.
  // has_phone=true skips rows that would land in PhoneBurner with a
  // blank Phone column (useless for dialing).
  const url = `${PROSPECTS_URL}` +
    `?source_type=storeleads` +
    `&has_phone=true` +
    `&search=${encodeURIComponent(search)}` +
    `&limit=100&sort=icp_score&order=desc`;

  const res = await fetch(url, {
    headers: {
      cookie: `session-token=${token}`,
      accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Prospects ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const json = (await res.json()) as { data: Prospect[]; total: number };
  console.log(`  "${search}": ${json.data.length} pulled (of ${json.total} matching)`);
  return json.data;
}

/** Take the first word/segment of the store name as a fallback
 *  First Name — PhoneBurner's UI shows this front-and-center on
 *  every dial. A blank field reads worse than the store name. */
function storeNameForFirstName(name: string): string {
  // "Sally's Boutique" → "Sally's Boutique" (full name reads more
  // naturally than a single-word truncation when there's no real
  // contact name).
  return name.trim();
}

async function main() {
  const outputPath = process.argv[2]
    ?? `./phoneburner-import-${new Date().toISOString().slice(0, 10)}.csv`;

  const token = process.env.SESSION_TOKEN;
  if (!token) {
    console.error("SESSION_TOKEN env var required");
    console.error("(paste your session-token cookie value from theframe.getjaxy.com)");
    process.exit(1);
  }

  console.log("Pulling top 100 vintage + 100 boutique from /prospects...");
  const [vintage, boutiqueRaw] = await Promise.all([
    fetchBucket(token, "vintage"),
    fetchBucket(token, "boutique"),
  ]);

  // FTS searches "vintage" and "boutique" both match against
  // name + website + tags, so a store like "The Vintage Boutique"
  // legitimately lands in both buckets. Prefer vintage in that case
  // (more specific signal) and dedupe out of the boutique side so
  // we don't burn two trial slots on one store.
  const vintageIds = new Set(vintage.map((p) => p.id));
  const boutique = boutiqueRaw.filter((p) => !vintageIds.has(p.id));
  console.log(
    `  dedupe: ${boutiqueRaw.length - boutique.length} stores were in both buckets, ` +
    `kept under 'vintage'`,
  );

  const all = [
    ...vintage.slice(0, PER_BUCKET).map((p) => ({ p, type: "vintage" as const })),
    ...boutique.slice(0, PER_BUCKET).map((p) => ({ p, type: "boutique" as const })),
  ].slice(0, TRIAL_CAP);

  console.log(`\nFinal list: ${all.length} (vintage: ${all.filter((r) => r.type === "vintage").length}, boutique: ${all.filter((r) => r.type === "boutique").length})`);

  // Header rows match PhoneBurner's template column order exactly,
  // including the trailing spaces on "City " / "State " in the
  // shipped template (PhoneBurner's import is space-sensitive on
  // some columns — easier to mirror than fight).
  const rows = all.map(({ p, type }) => ({
    "First Name": storeNameForFirstName(p.name),
    "Last Name": "",
    "Phone": p.phone ?? "",
    "Email": p.email ?? "",
    "Address Line 1": "",
    "Address Line 2": "",
    "City ": p.city ?? "",
    "State ": p.state ?? "",
    "Zip": "",
    "Team": "",
    "Color": "",
    // Custom columns Daniel asked for. PhoneBurner accepts arbitrary
    // extra columns on import — they show up as custom fields on
    // each contact. Easier than trying to cram everything into
    // First/Last Name.
    "Company ID": p.id,
    "Store Name": p.name,
    "Type": type,
    "Domain": p.domain ?? "",
    "Website": p.website ?? "",
    "ICP Score": p.icp_score ?? "",
    "Industry": p.industry ?? "",
    "Category": p.category ?? "",
  }));

  const csv = Papa.unparse(rows);
  fs.writeFileSync(outputPath, csv);

  // Print a quick eyeball preview so Daniel can sanity-check before
  // uploading.
  console.log(`\nWrote ${rows.length} rows → ${outputPath}\n`);
  console.log("First 3 rows:");
  for (const r of rows.slice(0, 3)) {
    console.log(`  [${r.Type}]  ${r["Store Name"]}  ${r.Phone}  (${r["City "]}, ${r["State "]})`);
  }
  console.log("\nUpload that CSV to PhoneBurner. The Type column lets you sort/filter");
  console.log("vintage vs boutique in their UI so the A/B test of which converts");
  console.log("better is one click in PhoneBurner's contact list.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
