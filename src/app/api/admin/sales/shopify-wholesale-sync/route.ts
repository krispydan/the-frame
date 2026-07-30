export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import {
  syncInterestedLeadToShopify,
  suppressBuyersFromMail,
  buildTags,
  buildAddress,
  isAddressComplete,
  sourceTagFor,
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
 * POST { backfill: true, limit }  → sync the existing interested backlog
 * POST { suppressBuyers: true }   → run the stop-mailing sweep now
 *
 * Auth: x-admin-key: jaxy2026.
 */

interface Row {
  id: string; name: string | null; status: string; source: string | null; tags: string | null;
  address: string | null; city: string | null; state: string | null; zip: string | null;
  country: string | null; website: string | null; icp_tier: string | null;
  shopify_customer_id: string | null; first_name: string | null; last_name: string | null;
  email: string | null; phone: string | null; owner_name: string | null;
  had_appointment: number;
}

const COHORT_SQL = `
  SELECT c.id, c.name, c.status, c.source, c.tags, c.address, c.city, c.state, c.zip,
         c.country, c.website, c.icp_tier, c.shopify_customer_id,
         (SELECT ct.first_name FROM contacts ct WHERE ct.company_id = c.id
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS first_name,
         (SELECT ct.last_name FROM contacts ct WHERE ct.company_id = c.id
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS last_name,
         (SELECT ct.email FROM contacts ct WHERE ct.company_id = c.id
           AND TRIM(COALESCE(ct.email,'')) <> ''
           AND LOWER(ct.email) NOT LIKE '%@relay.faire.com%'
           ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS email,
         (SELECT cp.phone FROM company_phones cp WHERE cp.company_id = c.id
           ORDER BY cp.is_primary DESC, cp.created_at ASC LIMIT 1) AS phone,
         (SELECT u.name FROM users u WHERE u.id = c.owner_id) AS owner_name,
         (SELECT COUNT(*) FROM phoneburner_call_log pb
           WHERE pb.company_id = c.id
             AND REPLACE(LOWER(COALESCE(pb.disposition_label,'')), '.', '') LIKE 'set app%') AS had_appointment
    FROM companies c
   WHERE c.status IN ('interested','catalog_sent')
   ORDER BY c.updated_at DESC`;

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") || "20", 10)));

  const rows = sqlite.prepare(`${COHORT_SQL} LIMIT ?`).all(limit) as Row[];
  const all = sqlite.prepare(COHORT_SQL).all() as Row[];

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
    const rows = sqlite.prepare(`${COHORT_SQL} LIMIT ?`).all(limit) as Row[];
    const results: Awaited<ReturnType<typeof syncInterestedLeadToShopify>>[] = [];
    for (const r of rows) {
      results.push(await syncInterestedLeadToShopify(r.id, { force: body.force === true }));
    }
    const by = (s: string) => results.filter((x) => x.status === s).length;
    return NextResponse.json({
      ok: true,
      counts: { created: by("created"), updated: by("updated"), skipped: by("skipped"), errors: by("error") },
      results,
    });
  }

  const companyId = String(body.companyId || "");
  if (!companyId) return NextResponse.json({ error: "companyId, backfill or suppressBuyers required" }, { status: 400 });
  return NextResponse.json({ ok: true, result: await syncInterestedLeadToShopify(companyId, { force: body.force === true }) });
}
