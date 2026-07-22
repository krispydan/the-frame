export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { listDealMailMessages, getPerson, updatePerson } from "@/modules/sales/lib/pipedrive-client";
import { firstNameForMerge } from "@/modules/sales/lib/faire-marketplace-parse";
import { extractCatalogRecipientName } from "@/modules/sales/lib/ai/catalog-recipient-name";

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
const VERSION = "v5-call-names"; // bump on logic change to confirm live build

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
  // sentence-starters that can follow "Hi," when there's no name
  "thanks", "thank", "since", "just", "hoping", "wanted", "following", "welcome", "happy", "again", "so", "quick",
  "hope", "good", "great", "sorry", "checking", "reaching", "we", "i",
]);

/** A name that's just an echo of a word in the store name (e.g. "Little" for
 *  "Little Green Dress", "Eeluxury" for "eeluxury"). */
function isStoreEcho(name: string, store: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(name);
  if (!n) return true;
  const tokens = store.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(norm);
  return tokens.includes(n) || norm(store) === n;
}

function isBadName(name: string | null | undefined, store: string): boolean {
  const s = (name || "").trim();
  return !s || NON_NAMES.has(s.toLowerCase()) || isStoreEcho(s, store);
}

/** Parse "Hi <Name>," from an outbound email snippet. Returns a clean first name
 *  or null (rejects merge-field failures, business words, the store name echo). */
function nameFromSnippet(snippet: string | undefined, store: string): string | null {
  if (!snippet) return null;
  // Require WHITESPACE between the greeting and the name (not a comma) — "Hi
  // Anna," is an address; "Hi, Thanks for..." is not.
  const m = snippet.match(/^\s*(?:hi|hello|hey|dear|good\s+(?:morning|afternoon|evening))\s+([A-Za-z][A-Za-z'’.-]{1,24})/i);
  if (!m) return null;
  const rawName = m[1].replace(/[.'’-]+$/, "").trim();
  if (!rawName || rawName.length < 2) return null;
  if (NON_NAMES.has(rawName.toLowerCase())) return null;
  if (isStoreEcho(rawName, store)) return null;
  const clean = firstNameForMerge(rawName, store);
  return clean && !isStoreEcho(clean, store) ? clean : null;
}

/** Our outbound senders are on the getjaxy.com domain. */
function isOutbound(msg: { from?: Array<{ email_address?: string }> }): boolean {
  const from = msg.from?.[0]?.email_address?.toLowerCase() || "";
  return from.endsWith(`@${OUR_DOMAIN}`);
}

interface DealMsg {
  from?: Array<{ email_address?: string }>;
  snippet?: string;
}

/** Best first name from one OUTBOUND message: the greeting we actually wrote
 *  ("Hi <Name>,"). The Pipedrive linked_person_name was tried as a fallback but
 *  frequently returns the store name (Pipedrive links the "person" as the
 *  store/email), so it's intentionally NOT used. */
function nameFromMessage(m: DealMsg, store: string): string | null {
  return nameFromSnippet(m.snippet, store);
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
    version: VERSION,
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

  // ── action=call-names: for leads still missing a name, read their PhoneBurner
  //    call notes/transcripts and AI-extract the owner/decision-maker to address
  //    the catalog to (e.g. "owner Jeannie DeMarco"). Writes to the frame
  //    contact; run action=update-names afterward to push to Pipedrive.
  if (url.searchParams.get("action") === "call-names") {
    const limit = url.searchParams.get("limit") ? Math.max(1, parseInt(url.searchParams.get("limit")!, 10)) : null;
    const callText = (companyId: string) => {
      const rows = sqlite
        .prepare("SELECT notes, transcript FROM phoneburner_call_log WHERE company_id = ? ORDER BY called_at DESC")
        .all(companyId) as Array<{ notes: string | null; transcript: string | null }>;
      const notes = rows.map((r) => (r.notes || "").trim()).filter(Boolean).join("\n---\n");
      const transcript = rows.map((r) => (r.transcript || "").trim()).filter(Boolean).join("\n---\n");
      return { notes, transcript, has: !!(notes || transcript) };
    };
    let items = loadNamelessLeads()
      .filter((l) => isBadName(l.firstName, l.store))
      .map((l) => ({ lead: l, call: callText(l.companyId) }))
      .filter((x) => x.call.has);
    if (limit) items = items.slice(0, limit);

    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, withCallLogs: items.length, note: "commit=true to AI-extract owner names from call notes/transcripts." });
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "running", mode: "call-names", total: items.length, done: 0, found: 0, written: 0, startedAt: new Date().toISOString() }));
    void (async () => {
      let done = 0,
        found = 0,
        written = 0,
        errors = 0;
      const samples: Array<{ store: string; name: string; role: string | null }> = [];
      const errSamples: string[] = [];
      for (const { lead: l, call: ct } of items) {
        try {
          const r = await extractCatalogRecipientName({ store: l.store, notes: ct.notes, transcript: ct.transcript });
          const first = r?.firstName ? firstNameForMerge(r.firstName, l.store) : null;
          if (first && !isBadName(first, l.store)) {
            found++;
            const last = r?.lastName && !isStoreEcho(r.lastName, l.store) ? r.lastName : "";
            if (l.contactId) {
              sqlite.prepare("UPDATE contacts SET first_name = ?, last_name = COALESCE(NULLIF(?, ''), last_name), updated_at = datetime('now') WHERE id = ?").run(first, last, l.contactId);
            } else {
              sqlite.prepare("INSERT INTO contacts (id, company_id, first_name, last_name, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 'call_transcript', datetime('now'), datetime('now'))").run(crypto.randomUUID(), l.companyId, first, last);
            }
            written++;
            if (samples.length < 25) samples.push({ store: l.store, name: `${first}${last ? " " + last : ""}`, role: r?.role ?? null });
          }
        } catch (e) {
          errors++;
          if (errSamples.length < 10) errSamples.push(`${l.store}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
        }
        done++;
        if (done % 5 === 0) setSetting(RUN_KEY, JSON.stringify({ state: "running", mode: "call-names", total: items.length, done, found, written, errors, samples, errSamples, updatedAt: new Date().toISOString() }));
      }
      setSetting(RUN_KEY, JSON.stringify({ state: "done", mode: "call-names", total: items.length, done, found, written, errors, samples, errSamples, finishedAt: new Date().toISOString() }));
    })();
    return NextResponse.json({ ok: true, started: true, withCallLogs: items.length, note: "Poll GET ?run=extract for progress." });
  }

  // ── action=update-names: push frame first names to Pipedrive person records
  //    that don't already have a real personal name (store-echo / email / blank).
  if (url.searchParams.get("action") === "update-names") {
    const rows = sqlite
      .prepare(
        `SELECT c.id, c.name AS store, c.pipedrive_person_id AS personId,
                (SELECT TRIM(COALESCE(ct.first_name,'')) FROM contacts ct WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS firstName,
                (SELECT TRIM(COALESCE(ct.last_name,'')) FROM contacts ct WHERE ct.company_id = c.id ORDER BY ct.is_primary DESC, ct.created_at ASC LIMIT 1) AS lastName
         FROM companies c
         JOIN pipedrive_deals d ON d.company_id = c.id AND d.pipeline = 'catalog' AND d.is_open = 1
         WHERE c.status != 'customer' AND c.pipedrive_person_id IS NOT NULL
         GROUP BY c.id`,
      )
      .all() as Array<{ id: string; store: string; personId: number; firstName: string | null; lastName: string | null }>;
    const targets = rows.filter((r) => (r.firstName || "").trim() && !isBadName(r.firstName, r.store));

    if (!commit) {
      return NextResponse.json({ ok: true, commit: false, candidates: targets.length, note: "commit=true to fetch each person and update those without a real name." });
    }
    setSetting(RUN_KEY, JSON.stringify({ state: "running", mode: "update-names", total: targets.length, done: 0, updated: 0, alreadyNamed: 0, errors: 0, startedAt: new Date().toISOString() }));
    void (async () => {
      let done = 0,
        updated = 0,
        alreadyNamed = 0,
        errors = 0;
      const samples: Array<{ store: string; from: string; to: string }> = [];
      const errSamples: string[] = [];
      for (const r of targets) {
        try {
          const person = await getPerson(r.personId);
          const current = (person?.name || "").trim();
          // "Already has a real name" = non-blank, not an email, not a store echo.
          const hasRealName = !!current && !current.includes("@") && !isStoreEcho(current.split(/\s+/)[0], r.store) && !isBadName(current.split(/\s+/)[0], r.store);
          if (hasRealName) {
            alreadyNamed++;
          } else {
            const last = (r.lastName || "").trim();
            const newName = last && !isStoreEcho(last, r.store) ? `${r.firstName} ${last}` : `${r.firstName}`;
            await updatePerson(r.personId, { name: newName });
            updated++;
            if (samples.length < 25) samples.push({ store: r.store, from: current || "(blank)", to: newName });
          }
        } catch (e) {
          errors++;
          if (errSamples.length < 10) errSamples.push(`${r.store}: ${e instanceof Error ? e.message.slice(0, 100) : String(e)}`);
        }
        done++;
        if (done % 15 === 0) setSetting(RUN_KEY, JSON.stringify({ state: "running", mode: "update-names", total: targets.length, done, updated, alreadyNamed, errors, samples, errSamples, updatedAt: new Date().toISOString() }));
      }
      setSetting(RUN_KEY, JSON.stringify({ state: "done", mode: "update-names", total: targets.length, done, updated, alreadyNamed, errors, samples, errSamples, finishedAt: new Date().toISOString() }));
    })();
    return NextResponse.json({ ok: true, started: true, candidates: targets.length, note: "Poll GET ?run=extract for progress." });
  }

  // Process leads that are missing a name, or have a bad name (blocklist word or
  // store-name echo — prior false positives to fix), or all when overwrite=true.
  const leads = loadNamelessLeads().filter((l) => l.dealId && (overwrite || isBadName(l.firstName, l.store)));

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
          if (l.contactId) {
            sqlite.prepare("UPDATE contacts SET first_name = ?, updated_at = datetime('now') WHERE id = ?").run(best, l.contactId);
          } else {
            sqlite.prepare("INSERT INTO contacts (id, company_id, first_name, is_primary, source, created_at, updated_at) VALUES (?, ?, ?, 1, 'pipedrive_greeting', datetime('now'), datetime('now'))").run(crypto.randomUUID(), l.companyId, best);
          }
          written++;
        } else if (l.contactId && l.firstName && isBadName(l.firstName, l.store)) {
          // No valid name and the current one is a false positive (bad word or
          // store-name echo) → clear it.
          sqlite.prepare("UPDATE contacts SET first_name = '', updated_at = datetime('now') WHERE id = ?").run(l.contactId);
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
