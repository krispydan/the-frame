export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { apifyClient } from "@/modules/sales/lib/apify-client";
import { updateOrganization, createActivity, pdRequest } from "@/modules/sales/lib/pipedrive-client";
import { getPipelineOwner } from "@/modules/sales/lib/pipedrive-setup";
import { dedupeTagsArray } from "@/modules/sales/lib/dedupe-tags";

/**
 * Catalog direct-mail campaign — leads in the Pipedrive "Catalog Interested"
 * pipeline who have NEVER purchased, mailed a physical catalog.
 *
 *   GET                                  → cohort + address audit (JSON)
 *   GET  ?format=csv                     → mailing spreadsheet (CSV download)
 *   POST ?action=enrich&commit=true      → Apify Google Maps address fill for
 *                                          missing addresses (background; poll GET ?run=enrich)
 *   POST ?action=sync-pipedrive&commit=true → write full mailing address to each
 *                                          lead's Pipedrive organization
 *   POST ?action=log-mail&commit=true    → log a done "Direct Mail" activity on
 *                                          each lead's deal in Pipedrive
 *                                          (idempotent via catalog_mailed_2026 tag)
 *
 * Cohort = companies with an OPEN deal in pipedrive_deals.pipeline='catalog'
 * (the "Catalog Interested" pipeline), excluding anyone with an order in the
 * frame or status='customer'. Auth: x-admin-key: jaxy2026.
 */

const MAILED_TAG = "catalog_mailed_2026";
const ENRICH_RUN_KEY = "catalog_mail_enrich_run";
const LOG_RUN_KEY = "catalog_mail_log_run";

function getSetting(key: string): string | null {
  return (sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value?.trim() || null;
}
function setSetting(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'sales', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(key, value);
}

interface CohortRow {
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
  website: string | null;
}

/** Full mailing address = street with a number + city + state + zip. */
function isComplete(r: { address: string; city: string; state: string; zip: string }): boolean {
  return !!(r.address.trim() && /\d/.test(r.address) && r.city.trim() && r.state.trim() && r.zip.trim());
}

function loadCohort(): CohortRow[] {
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, c.address, c.city, c.state, c.zip, c.tags, c.website,
              c.pipedrive_org_id AS orgId, c.pipedrive_person_id AS personId,
              d.pipedrive_deal_id AS dealId, d.stage AS stage,
              (SELECT ct.first_name || ' ' || COALESCE(ct.last_name,'') FROM contacts ct
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
    return {
      companyId: r.id,
      store: r.name,
      contactName: (r.contactName ?? "").trim(),
      email: r.email ?? "",
      phone: r.phone ?? "",
      ...base,
      addressComplete: isComplete(base),
      pipedriveDealId: r.dealId,
      pipedriveOrgId: r.orgId,
      pipedrivePersonId: r.personId,
      dealStage: r.stage,
      alreadyMailed: (r.tags || "").includes(MAILED_TAG),
      website: r.website,
    };
  });
}

function tagCompany(companyId: string, tag: string): void {
  const row = sqlite.prepare("SELECT tags FROM companies WHERE id = ?").get(companyId) as { tags: string | null } | undefined;
  let existing: string[] = [];
  try {
    existing = row?.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    existing = row?.tags ? row.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
  }
  sqlite.prepare("UPDATE companies SET tags = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(dedupeTagsArray([...existing, tag])), companyId);
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function buildCsv(rows: CohortRow[]): string {
  const base = getSetting("pipedrive_api_domain")?.replace(/\/$/, "") ?? "";
  const header = [
    "store", "contact_name", "address", "city", "state", "zip",
    "email", "phone", "address_complete", "deal_stage", "already_mailed", "pipedrive_deal_url",
  ];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.store, r.contactName, r.address, r.city, r.state, r.zip,
        r.email, r.phone, r.addressComplete ? "yes" : "NO — needs address",
        r.dealStage ?? "", r.alreadyMailed ? "yes" : "",
        base && r.pipedriveDealId ? `${base}/deal/${r.pipedriveDealId}` : "",
      ]
        .map((v) => csvEscape(String(v ?? "")))
        .join(","),
    );
  }
  return lines.join("\n");
}

/** Resolve the "Direct Mail" activity type key_string from Pipedrive (cached). */
async function directMailTypeKey(): Promise<string> {
  const cached = getSetting("pipedrive_direct_mail_type_key");
  if (cached) return cached;
  const types = (await pdRequest<Array<{ key_string: string; name: string; active_flag?: boolean }>>("GET", "/activityTypes")) || [];
  const match = types.find((t) => t.name.trim().toLowerCase() === "direct mail");
  if (!match) {
    throw new Error(`Pipedrive has no "Direct Mail" activity type. Found: ${types.map((t) => t.name).join(", ")}`);
  }
  setSetting("pipedrive_direct_mail_type_key", match.key_string);
  return match.key_string;
}

// ── Apify address enrichment ────────────────────────────────────────────────

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

async function enrichAddresses(targets: CohortRow[]): Promise<void> {
  // Apify's run-sync endpoint hard-caps at ~300s, so keep batches small; on a
  // batch failure (usually a timeout) retry each query alone — single-place
  // runs finish fast and rarely time out.
  const BATCH = 3;
  let done = 0,
    filled = 0,
    noMatch = 0,
    errors = 0;
  const errSamples: string[] = [];
  const write = (state: string) =>
    setSetting(ENRICH_RUN_KEY, JSON.stringify({ state, total: targets.length, done, filled, noMatch, errors, errSamples, updatedAt: new Date().toISOString() }));
  write("running");

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const queries = batch.map(queryFor);
    let places: Awaited<ReturnType<typeof apifyClient.runGoogleMapsScraper>> = [];
    try {
      places = await apifyClient.runGoogleMapsScraper(queries, { maxPerSearch: 1, timeoutSecs: 290 });
    } catch {
      // Batch failed — retry each query individually before giving up.
      for (const q of queries) {
        try {
          const one = await apifyClient.runGoogleMapsScraper([q], { maxPerSearch: 1, timeoutSecs: 290 });
          places.push(...one);
        } catch (e2) {
          if (errSamples.length < 10) errSamples.push(`${q}: ${e2 instanceof Error ? e2.message.slice(0, 120) : String(e2)}`);
        }
      }
    }

    for (let j = 0; j < batch.length; j++) {
      const t = batch[j];
      done++;
      // Match the place back to its query (Apify echoes searchString), falling
      // back to positional order.
      const q = queries[j];
      const place = places.find((p) => (p.searchString || "") === q) ?? places[j];
      if (!place) {
        noMatch++;
        continue;
      }
      // Accept only when the place plausibly IS this store: compressed-name
      // containment either way, or same website domain. Wrong matches mean
      // mailing a catalog to the wrong business.
      const a = compress(String(place.title || ""));
      const b = compress(t.store);
      const sameName = !!a && !!b && (a.includes(b) || b.includes(a));
      const sameDomain = !!domainOf(place.website) && domainOf(place.website) === domainOf(t.website);
      const street = String(place.street || "").trim() || String(place.address || "").split(",")[0]?.trim() || "";
      const hasStreet = /\d/.test(street);
      if ((!sameName && !sameDomain) || !hasStreet) {
        noMatch++;
        continue;
      }
      try {
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
        filled++;
      } catch (e) {
        errors++;
        if (errSamples.length < 10) errSamples.push(`${t.store}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
    write("running");
  }
  write("done");
}

// ── Route handlers ──────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const run = url.searchParams.get("run");
  if (run === "enrich" || run === "log") {
    const raw = getSetting(run === "enrich" ? ENRICH_RUN_KEY : LOG_RUN_KEY);
    return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
  }

  const cohort = loadCohort();
  if (url.searchParams.get("format") === "csv") {
    return new NextResponse(buildCsv(cohort), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="catalog-mail-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }
  const missing = cohort.filter((r) => !r.addressComplete);
  return NextResponse.json({
    ok: true,
    cohort: cohort.length,
    addressComplete: cohort.length - missing.length,
    addressMissing: missing.length,
    alreadyMailed: cohort.filter((r) => r.alreadyMailed).length,
    missingSample: missing.slice(0, 10).map((r) => ({ store: r.store, address: r.address, city: r.city, state: r.state, zip: r.zip })),
    rows: cohort,
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "";
  const commit = url.searchParams.get("commit") === "true";
  const cohort = loadCohort();

  if (action === "enrich") {
    const targets = cohort.filter((r) => !r.addressComplete);
    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, wouldEnrich: targets.length, sample: targets.slice(0, 10).map((t) => t.store) });
    }
    if (!targets.length) return NextResponse.json({ ok: true, note: "nothing to enrich — all addresses complete" });
    setSetting(ENRICH_RUN_KEY, JSON.stringify({ state: "running", total: targets.length, done: 0, startedAt: new Date().toISOString() }));
    void enrichAddresses(targets).catch((e) => {
      setSetting(ENRICH_RUN_KEY, JSON.stringify({ state: "error", error: e instanceof Error ? e.message : String(e) }));
    });
    return NextResponse.json({ ok: true, started: true, enriching: targets.length, note: "Poll GET ?run=enrich for progress." });
  }

  if (action === "sync-pipedrive") {
    const targets = cohort.filter((r) => r.pipedriveOrgId && r.addressComplete);
    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, wouldSync: targets.length, skippedNoOrg: cohort.filter((r) => !r.pipedriveOrgId).length, skippedIncomplete: cohort.filter((r) => !r.addressComplete).length });
    }
    let synced = 0,
      errors = 0;
    const errSamples: string[] = [];
    for (const t of targets) {
      const full = `${t.address}, ${t.city}, ${t.state} ${t.zip}`;
      try {
        await updateOrganization(t.pipedriveOrgId!, { address: full });
        synced++;
      } catch (e) {
        errors++;
        if (errSamples.length < 10) errSamples.push(`${t.store}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      }
    }
    return NextResponse.json({ ok: true, synced, errors, errSamples });
  }

  if (action === "log-mail") {
    const targets = cohort.filter((r) => !r.alreadyMailed && r.addressComplete);
    if (!commit) {
      return NextResponse.json({
        ok: true,
        commit: false,
        wouldLog: targets.length,
        skippedAlreadyMailed: cohort.filter((r) => r.alreadyMailed).length,
        skippedNoAddress: cohort.filter((r) => !r.addressComplete && !r.alreadyMailed).length,
      });
    }
    let typeKey: string;
    try {
      typeKey = await directMailTypeKey();
    } catch (e) {
      return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    }
    const owner = getPipelineOwner("catalog")?.id;
    const today = new Date().toISOString().slice(0, 10);
    setSetting(LOG_RUN_KEY, JSON.stringify({ state: "running", total: targets.length, done: 0, startedAt: new Date().toISOString() }));

    void (async () => {
      let done = 0,
        logged = 0,
        errors = 0;
      const errSamples: string[] = [];
      for (const t of targets) {
        try {
          await createActivity({
            subject: `Catalog mailed — ${t.store}`,
            type: typeKey,
            deal_id: t.pipedriveDealId ?? undefined,
            org_id: t.pipedriveOrgId ?? undefined,
            person_id: t.pipedrivePersonId ?? undefined,
            user_id: owner,
            due_date: today,
            done: 1,
            note: `Physical catalog sent via direct mail to: ${t.address}, ${t.city}, ${t.state} ${t.zip}`,
          });
          tagCompany(t.companyId, MAILED_TAG);
          logged++;
        } catch (e) {
          errors++;
          if (errSamples.length < 10) errSamples.push(`${t.store}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
        }
        done++;
        if (done % 10 === 0) setSetting(LOG_RUN_KEY, JSON.stringify({ state: "running", total: targets.length, done, logged, errors, errSamples, updatedAt: new Date().toISOString() }));
      }
      setSetting(LOG_RUN_KEY, JSON.stringify({ state: "done", total: targets.length, done, logged, errors, errSamples, finishedAt: new Date().toISOString() }));
    })();

    return NextResponse.json({ ok: true, started: true, logging: targets.length, note: "Poll GET ?run=log for progress." });
  }

  return NextResponse.json({ error: `unknown action "${action}" — use enrich | sync-pipedrive | log-mail` }, { status: 400 });
}
