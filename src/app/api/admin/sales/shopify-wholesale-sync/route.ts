export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getShopifyClientByChannel, listAllShops } from "@/modules/integrations/lib/shopify/admin-api";
import {
  syncInterestedLeadToShopify,
  suppressBuyersFromMail,
  buildTags,
  buildAddress,
  isAddressComplete,
  sourceTagFor,
  buildNote,
  COMPANY_SELECT,
  type CompanyRow,
} from "@/modules/sales/lib/shopify-wholesale-customer";

/**
 * Admin control for the interested-lead → Shopify wholesale push.
 *
 * GET  ?preview=1[&limit=20] → what WOULD be pushed for the current
 *      interested cohort: tags, address completeness, who'd trigger a Slack
 *      ask, plus a breakdown by source tag. Writes nothing — this is how you
 *      sanity-check the tagging scheme before any customer exists in the store.
 * GET  ?format=csv → the same thing as a reviewable file, one row per customer
 *      exactly as it would be created. Every lead, not a sample.
 *
 * POST { companyId }              → sync one lead (the test path)
 * POST { backfill: true, limit }  → sync the existing interested backlog.
 *      Skips anything already stamped, so repeated calls walk the queue down.
 *      Returns only problem rows plus a `remaining` count.
 * POST { suppressBuyers: true }   → run the stop-mailing sweep now
 *
 * Auth: x-admin-key: jaxy2026.
 */


const COHORT_SQL = `${COMPANY_SELECT}
   WHERE c.status IN ('interested','catalog_sent')
   ORDER BY c.updated_at DESC`;

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") || "20", 10)));

  // Which store the "wholesale" channel actually resolves to, proven by a live
  // API call rather than by what a config row claims. Writing hundreds of
  // customers into the DTC store by mistake is expensive to unpick, so this
  // check exists to be run before any bulk write.
  if (params.get("checkStore") === "1") {
    const shops = (await listAllShops()).map((s2) => ({
      domain: s2.shopDomain, channel: s2.channel, active: s2.isActive,
    }));
    try {
      const client = await getShopifyClientByChannel("wholesale");
      const probe = await client.graphql<{ shop: { name: string; myshopifyDomain: string; email: string | null } }>(
        `query { shop { name myshopifyDomain email } }`,
      );
      const existing = await client.graphql<{ customersCount: { count: number } }>(
        `query { customersCount { count } }`,
      ).catch(() => null);
      return NextResponse.json({
        ok: true,
        resolvesTo: client.shopDomain,
        liveShop: probe.shop,
        matches: probe.shop.myshopifyDomain === client.shopDomain,
        existingCustomers: existing?.customersCount?.count ?? null,
        allShops: shops,
      });
    } catch (e) {
      return NextResponse.json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        allShops: shops,
      }, { status: 500 });
    }
  }

  // ?diagnose=<email|companyId> — trace one lead end to end: did it reach
  // interested, was the job enqueued, did it run, what did it return.
  const diag = (params.get("diagnose") || "").trim();
  if (diag) {
    const company = sqlite.prepare(
      `${COMPANY_SELECT} WHERE c.id = ? OR EXISTS (
          SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND LOWER(ct.email) = LOWER(?))
        LIMIT 1`,
    ).get(diag, diag) as CompanyRow | undefined;
    if (!company) return NextResponse.json({ ok: false, error: `No company for "${diag}"` }, { status: 404 });

    const jobRows = sqlite.prepare(
      `SELECT id, type, status, attempts, error, scheduled_for, created_at, started_at, completed_at, output
         FROM jobs
        WHERE type = 'sales.sync_lead_to_shopify_wholesale'
          AND input LIKE ?
        ORDER BY created_at DESC LIMIT 5`,
    ).all(`%${company.id}%`);

    const recentJobs = sqlite.prepare(
      `SELECT status, COUNT(*) n FROM jobs
        WHERE type = 'sales.sync_lead_to_shopify_wholesale'
          AND created_at >= datetime('now','-3 days')
        GROUP BY status`,
    ).all();

    return NextResponse.json({
      ok: true,
      company: {
        id: company.id, name: company.name, status: company.status,
        email: company.email, phone: company.phone,
        shopifyCustomerId: company.shopify_customer_id,
        hadAppointment: company.had_appointment > 0,
        updatedAt: company.updated_at,
      },
      jobsForThisLead: jobRows,
      allSyncJobsLast3Days: recentJobs,
      wouldTags: buildTags(company),
      addressComplete: isAddressComplete(buildAddress(company)),
    });
  }

  const rows = sqlite.prepare(`${COHORT_SQL} LIMIT ?`).all(limit) as CompanyRow[];
  const all = sqlite.prepare(COHORT_SQL).all() as CompanyRow[];

  const withEmail = all.filter((r) => r.email);
  const mailable = withEmail.filter((r) => isAddressComplete(buildAddress(r)));

  // The exact upload set, as a file, so it can be read before anything is
  // written to a live store.
  if (params.get("format") === "csv") {
    const esc = (v: unknown) => {
      const t = v == null ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const header = [
      "company", "first_name", "last_name", "email", "phone",
      "address1", "city", "state", "zip", "country",
      "address_complete", "would_slack_for_address", "tags",
      "status", "raw_source", "had_phoneburner_appointment", "already_in_shopify",
      "marketing_consent", "note",
    ].join(",");
    const body = withEmail.map((r) => {
      const a = buildAddress(r);
      const complete = isAddressComplete(a);
      return [
        r.name, r.first_name, r.last_name, r.email, r.phone,
        complete ? a.address1 : "", complete ? a.city : "", complete ? a.province : "",
        complete ? a.zip : "", complete ? a.country : "",
        complete ? "yes" : "NO", complete ? "" : "yes",
        buildTags(r).join(" | "),
        r.status, r.source, r.had_appointment > 0 ? "yes" : "no",
        r.shopify_customer_id ? "yes" : "no",
        "SUBSCRIBED (single opt-in)",
        buildNote(r),
      ].map(esc).join(",");
    });
    return new NextResponse([header, ...body].join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="shopify-wholesale-upload-preview-${new Date().toISOString().split("T")[0]}.csv"`,
      },
    });
  }

  // How the closed source vocabulary lands across the real cohort — the check
  // that no lead is falling into "other" in bulk.
  const bySource: Record<string, number> = {};
  for (const r of all) {
    const t = sourceTagFor(r);
    bySource[t] = (bySource[t] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    cohort: {
      total: all.length,
      withEmail: withEmail.length,
      withoutEmail: all.length - withEmail.length,
      mailable: mailable.length,
      wouldSlackForAddress: withEmail.length - mailable.length,
      alreadyInShopify: all.filter((r) => r.shopify_customer_id).length,
      withPhoneBurnerAppointment: all.filter((r) => r.had_appointment > 0).length,
    },
    bySource,
    preview: rows.map((r) => {
      const addr = buildAddress(r);
      return {
        company: r.name,
        email: r.email,
        hasEmail: !!r.email,
        tags: buildTags(r),
        rawSource: r.source,
        hadPhoneBurnerAppointment: r.had_appointment > 0,
        marketingConsent: "SUBSCRIBED (single opt-in)",
        note: buildNote(r),
        address: addr,
        addressComplete: isAddressComplete(addr),
        alreadySynced: !!r.shopify_customer_id,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));

  if (body.suppressBuyers === true) {
    return NextResponse.json({ ok: true, result: await suppressBuyersFromMail(body.limit ?? 200) });
  }

  if (body.backfill === true) {
    const limit = Math.min(500, Math.max(1, Number(body.limit) || 25));
    // Skip anything already stamped. Syncing sets companies.updated_at, and the
    // cohort is ordered by it DESC — so without this filter each batch pulls
    // back the rows the previous batch just finished and the backfill spins
    // forever on the same 50 leads.
    const sql = body.includeSynced === true
      ? `${COHORT_SQL} LIMIT ?`
      : `${COMPANY_SELECT}
           WHERE c.status IN ('interested','catalog_sent')
             AND c.shopify_customer_id IS NULL
             AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id
                           AND TRIM(COALESCE(ct.email,'')) <> ''
                           AND LOWER(ct.email) NOT LIKE '%@relay.faire.com%')
           ORDER BY c.updated_at DESC
           LIMIT ?`;
    const rows = sqlite.prepare(sql).all(limit) as CompanyRow[];
    const results: Awaited<ReturnType<typeof syncInterestedLeadToShopify>>[] = [];
    for (const r of rows) {
      results.push(await syncInterestedLeadToShopify(r.id, { force: body.force === true }));
    }
    const by = (s: string) => results.filter((x) => x.status === s).length;
    return NextResponse.json({
      ok: true,
      counts: {
        attempted: rows.length,
        created: by("created"), updated: by("updated"),
        skipped: by("skipped"), errors: by("error"),
        remaining: (sqlite.prepare(
          `SELECT COUNT(*) n FROM companies c
            WHERE c.status IN ('interested','catalog_sent')
              AND c.shopify_customer_id IS NULL
              AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id
                            AND TRIM(COALESCE(ct.email,'')) <> ''
                            AND LOWER(ct.email) NOT LIKE '%@relay.faire.com%')`,
        ).get() as { n: number }).n,
      },
      results: results.filter((r) => r.status === "error" || r.status === "skipped"),
    });
  }

  const companyId = String(body.companyId || "");
  if (!companyId) return NextResponse.json({ error: "companyId, backfill or suppressBuyers required" }, { status: 400 });
  return NextResponse.json({ ok: true, result: await syncInterestedLeadToShopify(companyId, { force: body.force === true }) });
}
