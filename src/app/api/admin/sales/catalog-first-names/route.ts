export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { listDealMailMessages } from "@/modules/sales/lib/pipedrive-client";
import { firstNameForMerge } from "@/modules/sales/lib/faire-marketplace-parse";

/**
 * Extract first names for the catalog mail-merge from the greeting line of the
 * emails already sent in Pipedrive (e.g. "Hi Lakecia,").
 *
 *   GET                               → cohort first-name coverage audit
 *   GET  ?run=extract                 → background-run progress
 *   GET  ?debug=dealmail&dealId=ID    → raw deal mail (inspection)
 *   POST ?commit=true                 → scan each nameless lead's deal mail,
 *                                       parse the greeting, write the first name
 *                                       to the frame contact (background)
 *
 * Only OUTBOUND messages (from @getjaxy.com) are parsed — an inbound reply's
 * "Hi <rep>" addresses our team, not the lead. Auth: x-admin-key: jaxy2026.
 */

const RUN_KEY = "catalog_first_names_run";
const OUR_DOMAIN = "getjaxy.com";

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

interface Lead {
  companyId: string;
  store: string;
  dealId: number | null;
  contactId: string | null;
  firstName: string;
}

function loadNamelessLeads(): Lead[] {
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.name, d.pipedrive_deal_id AS dealId,
              (SELECT ct.id FROM contacts ct WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS contactId,
              (SELECT TRIM(COALESCE(ct.first_name,'')) FROM contacts ct WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS firstName
       FROM companies c
       JOIN pipedrive_deals d ON d.company_id = c.id AND d.pipeline = 'catalog' AND d.is_open = 1
       WHERE c.status != 'customer'
       GROUP BY c.id`,
    )
    .all() as Array<{ id: string; name: string; dealId: number | null; contactId: string | null; firstName: string | null }>;
  return rows.map((r) => ({ companyId: r.id, store: r.name, dealId: r.dealId, contactId: r.contactId, firstName: (r.firstName ?? "").trim() }));
}

// Words that show up after "Hi" but aren't a person's first name.
const NON_NAMES = new Set([
  "there", "team", "all", "everyone", "folks", "friend", "friends", "owner", "owners", "y'all", "yall", "guys",
  "boutique", "store", "shop", "hello", "hi", "hey", "sir", "madam", "maam", "ladies", "gentlemen", "customer",
  "buyer", "manager", "sales", "info", "the",
]);

/** Parse "Hi <Name>," from an outbound email snippet. Returns a clean first name
 *  or null (rejects merge-field failures, business words, the store name echo). */
function nameFromSnippet(snippet: string | undefined, store: string): string | null {
  if (!snippet) return null;
  const m = snippet.match(/^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))[\s,]+([A-Za-z][A-Za-z'’.-]{1,24})/i);
  if (!m) return null;
  const rawName = m[1].replace(/[.'’-]+$/, "").trim();
  if (!rawName || rawName.length < 2) return null;
  if (NON_NAMES.has(rawName.toLowerCase())) return null;
  // Reject if it's just an echo of a store-name word (e.g. "Hi Boutique,").
  const storeWords = new Set(store.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  if (storeWords.has(rawName.toLowerCase())) return null;
  // Final gate: firstNameForMerge blanks business/role/all-caps echoes and
  // proper-cases. Pass the store so it can reject store-name matches too.
  const clean = firstNameForMerge(rawName, store);
  return clean || null;
}

/** Our outbound senders are on the getjaxy.com domain. */
function isOutbound(msg: { from?: Array<{ email_address?: string }> }): boolean {
  const from = msg.from?.[0]?.email_address?.toLowerCase() || "";
  return from.endsWith(`@${OUR_DOMAIN}`);
}

interface DealMsg {
  from?: Array<{ email_address?: string }>;
  to?: Array<{ email_address?: string; linked_person_name?: string | null }>;
  snippet?: string;
}

/** Best first name from one OUTBOUND message: the greeting we wrote ("Hi X,"),
 *  else the recipient's Pipedrive-linked person name. Both validated. */
function nameFromMessage(m: DealMsg, store: string): string | null {
  const fromGreeting = nameFromSnippet(m.snippet, store);
  if (fromGreeting) return fromGreeting;
  // Fallback: the "to" party Pipedrive linked to a person (skip our own team).
  const recipient = (m.to || []).find((t) => !(t.email_address || "").toLowerCase().endsWith(`@${OUR_DOMAIN}`));
  const linked = (recipient?.linked_person_name || "").trim();
  if (linked) {
    const first = linked.split(/\s+/)[0];
    if (first && !NON_NAMES.has(first.toLowerCase())) {
      const clean = firstNameForMerge(first, store);
      if (clean) return clean;
    }
  }
  return null;
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug");
  if (url.searchParams.get("run") === "extract") {
    const raw = getSetting(RUN_KEY);
    return NextResponse.json(raw ? JSON.parse(raw) : { state: "idle" });
  }
  if (debug === "dealmail") {
    const dealId = Number(url.searchParams.get("dealId"));
    const msgs = await listDealMailMessages(dealId);
    const store = url.searchParams.get("store") || "";
    return NextResponse.json({ ok: true, count: msgs.length, messages: msgs.map((m) => ({ from: m.from?.[0]?.email_address, linkedTo: m.to?.map((t) => t.linked_person_name).filter(Boolean), subject: m.subject, snippet: (m.snippet || "").slice(0, 40), outbound: isOutbound(m), parsedName: nameFromMessage(m, store) })) });
  }

  const leads = loadNamelessLeads();
  const withName = leads.filter((l) => l.firstName);
  return NextResponse.json({
    ok: true,
    cohort: leads.length,
    haveFirstName: withName.length,
    missingFirstName: leads.length - withName.length,
    missingWithDeal: leads.filter((l) => !l.firstName && l.dealId).length,
  });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const commit = url.searchParams.get("commit") === "true";
  const overwrite = url.searchParams.get("overwrite") === "true";
  const leads = loadNamelessLeads().filter((l) => l.dealId && (overwrite || !l.firstName));

  if (!commit) {
    return NextResponse.json({ ok: true, commit: false, wouldScan: leads.length, note: "Re-run with commit=true to scan Pipedrive mail + write first names." });
  }

  setSetting(RUN_KEY, JSON.stringify({ state: "running", total: leads.length, done: 0, found: 0, written: 0, startedAt: new Date().toISOString() }));

  void (async () => {
    let done = 0,
      found = 0,
      written = 0,
      errors = 0;
    const samples: Array<{ store: string; name: string }> = [];
    const errSamples: string[] = [];
    for (const l of leads) {
      try {
        const msgs = await listDealMailMessages(l.dealId!);
        // Prefer names from outbound messages; tally to pick the most frequent.
        const tally = new Map<string, number>();
        for (const m of msgs) {
          if (!isOutbound(m)) continue;
          const name = nameFromMessage(m, l.store);
          if (name) tally.set(name, (tally.get(name) || 0) + 1);
        }
        const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        if (best) {
          found++;
          if (samples.length < 25) samples.push({ store: l.store, name: best });
          // Write to the primary contact (create one if missing).
          if (l.contactId) {
            sqlite.prepare("UPDATE contacts SET first_name = ?, updated_at = datetime('now') WHERE id = ?").run(best, l.contactId);
          } else {
            sqlite.prepare("INSERT INTO contacts (id, company_id, first_name, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, 1, 'pipedrive_greeting', datetime('now'), datetime('now'))").run(crypto.randomUUID(), l.companyId, best);
          }
          written++;
        }
      } catch (e) {
        errors++;
        if (errSamples.length < 10) errSamples.push(`${l.store}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
      }
      done++;
      if (done % 15 === 0) setSetting(RUN_KEY, JSON.stringify({ state: "running", total: leads.length, done, found, written, errors, samples, errSamples, updatedAt: new Date().toISOString() }));
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "done", total: leads.length, done, found, written, errors, samples, errSamples, finishedAt: new Date().toISOString() }));
  })();

  return NextResponse.json({ ok: true, started: true, scanning: leads.length, note: "Poll GET ?run=extract for progress." });
}
