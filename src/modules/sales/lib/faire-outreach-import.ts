/**
 * Import the Faire Market campaign's local state into the frame.
 *
 * The campaign (see the faire_dm repo) ran on a laptop with its own CSVs. Three
 * things in there are worth keeping, and are prerequisites for the sequence
 * engine (docs/outreach-sequence-engine.md, Phase 0):
 *
 *  1. retailer tokens  — r_… per contact, incl. ~1,250 NON-buyers the Faire
 *                        orders API can never tell us about. Deep-links the
 *                        Messenger thread.
 *  2. skiplist         — declines / dead tokens -> do_not_contact.
 *  3. send history     — who was messaged and when -> outreach_messages, so
 *                        cooldowns work from day one and the engine doesn't
 *                        immediately re-touch ~1,100 recently-messaged shops.
 *
 * Matching a contact to a company is deliberately conservative: exact token,
 * then exact normalized name + state, then normalized name alone when it is
 * unambiguous. Anything else is reported as unmatched rather than guessed —
 * a wrong match here would attach outreach history to the wrong shop.
 */

import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";

export interface ImportContact {
  retailer_token: string;
  retailer?: string;
  first_name?: string;
  city?: string;
  state?: string;
}
export interface ImportSkip {
  retailer_token: string;
  retailer?: string;
  state?: string;
  city?: string;
  reason?: string;
}
export interface ImportSend {
  retailer_token: string;
  retailer?: string;
  state?: string;
  city?: string;
  status: string;           // sent | left_unsent | skipped | redirected | …
  at?: string;              // ISO timestamp
  message?: string;
}

export interface ImportSummary {
  contacts: { received: number; matchedByToken: number; matchedByName: number; stamped: number; unmatched: number };
  skips: { received: number; applied: number; unmatched: number };
  sends: { received: number; inserted: number; duplicates: number; unmatchedButKept: number };
  unmatchedSamples: string[];
}

const norm = (s: string | undefined | null): string =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(llc|inc|ltd|co|corp|company|the|boutique|store|shop|llp)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * In-memory match index, built ONCE per import call.
 *
 * The naive version did a `LIKE '%name%'` lookup per contact. Against ~258k
 * companies and a few thousand contacts that's thousands of unindexable full
 * table scans in a single request — it timed the endpoint out. One pass to
 * build two maps turns each lookup into a hash hit.
 */
/**
 * State normalization. companies.state is inconsistent — ~93k rows use "CA",
 * ~136k use "California". Comparing raw strings made every tie-break fail.
 */
const STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY",
  louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
  pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  // Canada (Faire retailers include CA provinces)
  alberta: "AB", "british columbia": "BC", manitoba: "MB", "new brunswick": "NB",
  "newfoundland and labrador": "NL", "nova scotia": "NS", ontario: "ON",
  "prince edward island": "PE", quebec: "QC", saskatchewan: "SK",
};
const CA_PROVINCES = new Set(["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"]);
const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM",
  "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
  "WV", "WI", "WY", "PR", "VI", "GU",
]);

const normState = (s: string | null | undefined): string => {
  const t = (s || "").trim();
  if (!t) return "";
  if (t.length === 2) return t.toUpperCase();
  return STATE_ABBR[t.toLowerCase()] || t.toUpperCase();
};
const normCity = (s: string | null | undefined): string =>
  (s || "").toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

// Which duplicate row to prefer when the SAME shop exists more than once.
// Higher = better: a customer record beats an unqualified scrape.
const STATUS_RANK: Record<string, number> = {
  customer: 100, interested: 80, catalog_sent: 70, qualified_lead: 60, qualified: 55,
  revisit_later: 40, prospect: 30, ghosted: 10, not_interested: 5, not_qualified: 1,
};

interface IndexRow { id: string; state: string; city: string; rank: number }
interface MatchIndex {
  byToken: Map<string, string>;              // r_… -> company id
  byName: Map<string, IndexRow[]>;           // normalized name -> rows
}

function buildIndex(): MatchIndex {
  const byToken = new Map<string, string>();
  const byName = new Map<string, IndexRow[]>();
  const rows = sqlite
    .prepare("SELECT id, name, state, city, status, faire_retailer_id FROM companies")
    .all() as Array<{ id: string; name: string | null; state: string | null; city: string | null; status: string | null; faire_retailer_id: string | null }>;
  for (const r of rows) {
    if (r.faire_retailer_id) byToken.set(r.faire_retailer_id, r.id);
    const n = norm(r.name);
    if (!n || n.length < 3) continue;
    const entry: IndexRow = {
      id: r.id,
      state: normState(r.state),
      city: normCity(r.city),
      rank: STATUS_RANK[r.status || ""] ?? 20,
    };
    const list = byName.get(n);
    if (list) list.push(entry);
    else byName.set(n, [entry]);
  }
  return { byToken, byName };
}

/**
 * Resolve a campaign contact to a company id.
 *
 * Same-name rows are one of two very different things:
 *   - the SAME shop duplicated in our data (same city/state, e.g. "Terston"
 *     appears twice, both Kent CT) -> safe to pick the best row;
 *   - genuinely DIFFERENT shops sharing a name ("Bella Boutique" in Ottawa vs
 *     Keller TX) -> must refuse rather than guess.
 * Location is what separates them, so that's the rule: narrow by state, then
 * city; if what remains is all one location, take the best-status row,
 * otherwise refuse.
 */
function resolveCompany(
  idx: MatchIndex,
  c: { retailer_token?: string; retailer?: string; state?: string; city?: string },
): { id: string | null; how: "token" | "name" | null } {
  if (c.retailer_token) {
    const hit = idx.byToken.get(c.retailer_token);
    if (hit) return { id: hit, how: "token" };
  }
  const n = norm(c.retailer);
  if (!n || n.length < 3) return { id: null, how: null };

  let cands = idx.byName.get(n);
  if (!cands || !cands.length) return { id: null, how: null };
  if (cands.length === 1) return { id: cands[0].id, how: "name" };

  // Narrow by state, then city. A row that POSITIVELY matches the location
  // beats one that merely lacks contradicting data — a confirmed Oregon shop
  // is a better link than a duplicate with no address at all. Only fall back
  // to keeping blanks when nothing positively matches.
  const wantState = normState(c.state);
  if (wantState) {
    const hit = cands.filter((x) => x.state === wantState);
    cands = hit.length ? hit : cands.filter((x) => !x.state).length ? cands.filter((x) => !x.state) : cands;
  }
  const wantCity = normCity(c.city);
  if (cands.length > 1 && wantCity) {
    const hit = cands.filter((x) => x.city === wantCity);
    cands = hit.length ? hit : cands.filter((x) => !x.city).length ? cands.filter((x) => !x.city) : cands;
  }
  if (cands.length === 1) return { id: cands[0].id, how: "name" };

  // Still several. If they're all the same place, it's one shop duplicated —
  // take the richest record. If they sit in different places, refuse.
  const places = new Set(cands.filter((x) => x.state || x.city).map((x) => `${x.state}|${x.city}`));
  if (places.size <= 1) {
    const best = cands.reduce((a, b) => (b.rank > a.rank ? b : a));
    return { id: best.id, how: "name" };
  }
  return { id: null, how: null };
}

export function importFaireOutreach(payload: {
  contacts?: ImportContact[];
  skips?: ImportSkip[];
  sends?: ImportSend[];
  campaign?: string;
  /** Which of our Faire brand accounts this history belongs to. */
  brand?: string;
  dryRun?: boolean;
}): ImportSummary {
  const campaign = payload.campaign || "faire_market_2026_07";
  // The Faire Market campaign was sent from the A.J. Morgan brand portal.
  const brand = (payload.brand || "ajm").toLowerCase();
  const dry = !!payload.dryRun;
  const idx = buildIndex();
  const linkUpsert = sqlite.prepare(
    `INSERT INTO company_faire_accounts (id, company_id, brand, retailer_token, first_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(company_id, brand) DO UPDATE SET
       retailer_token = COALESCE(NULLIF(company_faire_accounts.retailer_token,''), excluded.retailer_token)`,
  );
  const unmatchedSamples: string[] = [];
  const summary: ImportSummary = {
    contacts: { received: 0, matchedByToken: 0, matchedByName: 0, stamped: 0, unmatched: 0 },
    skips: { received: 0, applied: 0, unmatched: 0 },
    sends: { received: 0, inserted: 0, duplicates: 0, unmatchedButKept: 0 },
    unmatchedSamples,
  };

  // 1. Stamp retailer tokens onto companies we can identify.
  for (const c of payload.contacts || []) {
    summary.contacts.received++;
    const r = resolveCompany(idx, c);
    if (!r.id) {
      summary.contacts.unmatched++;
      if (unmatchedSamples.length < 25) unmatchedSamples.push(`${c.retailer || "?"} (${c.state || "?"})`);
      continue;
    }
    if (r.how === "token") summary.contacts.matchedByToken++;
    else summary.contacts.matchedByName++;
    if (!dry) {
      // Authoritative per-brand link.
      try {
        linkUpsert.run(randomUUID(), r.id, brand, c.retailer_token, new Date().toISOString());
      } catch { /* token already linked to another company for this brand */ }
      // Mirror onto companies for fast lookup (primary brand only).
      const res = sqlite
        .prepare(
          `UPDATE companies SET faire_retailer_id = ?
            WHERE id = ? AND (faire_retailer_id IS NULL OR faire_retailer_id = '')`,
        )
        .run(c.retailer_token, r.id);
      if (res.changes) summary.contacts.stamped++;
    }
  }

  // 2. Skiplist -> do_not_contact.
  for (const s of payload.skips || []) {
    summary.skips.received++;
    const r = resolveCompany(idx, s);
    if (!r.id) { summary.skips.unmatched++; continue; }
    if (!dry) {
      // Per-BRAND suppression: declining A.J. Morgan does not mean declining
      // Jaxy. A global do_not_contact is reserved for "never contact us again"
      // and is set deliberately, not inferred from one brand's campaign.
      linkUpsert.run(randomUUID(), r.id, brand, s.retailer_token, new Date().toISOString());
      sqlite
        .prepare(
          `UPDATE company_faire_accounts
              SET do_not_contact = 1, do_not_contact_reason = ?
            WHERE company_id = ? AND brand = ?`,
        )
        .run(`faire campaign: ${s.reason || "skiplist"}`, r.id, brand);
    }
    summary.skips.applied++;
  }

  // 3. Send history -> outreach_messages. Kept even when we can't match a
  //    company: the retailer token alone is enough for the Faire cooldown
  //    check, which is the whole point of importing this.
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO outreach_messages
       (id, company_id, faire_retailer_id, brand, channel, direction, status, body, campaign, sent_at, source)
     VALUES (?, ?, ?, ?, 'faire', 'outbound', ?, ?, ?, ?, 'faire_dm_import')`,
  );
  for (const m of payload.sends || []) {
    summary.sends.received++;
    // left_unsent counts as sent for cooldown purposes — the send-verification
    // check produced false negatives, and a duplicate is worse than a miss.
    const status = m.status === "left_unsent" ? "sent_unverified" : m.status;
    const r = resolveCompany(idx, m);
    if (!r.id) summary.sends.unmatchedButKept++;
    if (!dry) {
      const res = insert.run(
        randomUUID(), r.id, m.retailer_token, brand, status, m.message || null, campaign, m.at || null,
      );
      if (res.changes) summary.sends.inserted++;
      else summary.sends.duplicates++;
    }
  }

  return summary;
}

/**
 * Create company records for Faire retailers we have a real relationship with
 * (they're in a brand's Faire contact list, we've messaged them) but who were
 * never in the CRM. Without a company row they can't be enrolled in a sequence,
 * so the outreach engine would be blind to them.
 *
 * Only creates when the contact does NOT resolve to an existing company — the
 * same conservative matcher decides, so this can't manufacture duplicates for
 * shops we already know. Idempotent: re-running skips anything already linked
 * by token.
 */
export function createMissingCompanies(payload: {
  contacts: ImportContact[];
  brand?: string;
  dryRun?: boolean;
}): { received: number; created: number; alreadyPresent: number; samples: string[] } {
  const brand = (payload.brand || "ajm").toLowerCase();
  const dry = !!payload.dryRun;
  const idx = buildIndex();
  const samples: string[] = [];
  let created = 0, alreadyPresent = 0;

  const insertCompany = sqlite.prepare(
    `INSERT INTO companies (id, name, city, state, country, status, source, source_type, created_at, updated_at, faire_retailer_id)
     VALUES (?, ?, ?, ?, ?, 'prospect', 'faire_outreach', 'faire', ?, ?, ?)`,
  );
  const linkUpsert = sqlite.prepare(
    `INSERT OR IGNORE INTO company_faire_accounts (id, company_id, brand, retailer_token, first_seen_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const relink = sqlite.prepare(
    `UPDATE outreach_messages SET company_id = ? WHERE faire_retailer_id = ? AND company_id IS NULL`,
  );

  for (const c of payload.contacts || []) {
    const r = resolveCompany(idx, c);
    if (r.id) { alreadyPresent++; continue; }
    if (samples.length < 20) samples.push(`${c.retailer || "?"} (${c.city || "?"}, ${c.state || "?"})`);
    if (!dry) {
      const now = new Date().toISOString();
      const id = randomUUID();
      // Don't assume US: this list includes French, UK and Luxembourg shops.
      // Infer country only from a recognized state/province, else leave null.
      const st = normState(c.state);
      const country = !st ? null : CA_PROVINCES.has(st) ? "CA" : US_STATES.has(st) ? "US" : null;
      try {
        insertCompany.run(id, c.retailer || "(unnamed Faire retailer)", c.city || null,
          c.state || null, country, now, now, c.retailer_token);
        linkUpsert.run(randomUUID(), id, brand, c.retailer_token, now);
        // Attach the outreach history we imported by token to the new company.
        relink.run(id, c.retailer_token);
      } catch { continue; }
    }
    created++;
  }
  return { received: (payload.contacts || []).length, created, alreadyPresent, samples };
}

/**
 * Repair country on the faire_outreach records. An earlier run stamped every
 * created shop 'US'; this list includes French, UK, Spanish, Luxembourg and
 * Canadian retailers. Re-derives country from the state (US state -> US,
 * CA province -> CA) and nulls it when the state gives no evidence, so an
 * unknown country reads as unknown instead of as a wrong answer.
 */
export function fixFaireOutreachCountry(dryRun = false): {
  scanned: number; toUS: number; toCA: number; toNull: number;
} {
  const rows = sqlite
    .prepare("SELECT id, state, country FROM companies WHERE source = 'faire_outreach'")
    .all() as Array<{ id: string; state: string | null; country: string | null }>;
  const upd = sqlite.prepare("UPDATE companies SET country = ? WHERE id = ?");
  let toUS = 0, toCA = 0, toNull = 0;
  for (const r of rows) {
    const st = normState(r.state);
    const want = !st ? null : CA_PROVINCES.has(st) ? "CA" : US_STATES.has(st) ? "US" : null;
    if (want === "US") toUS++; else if (want === "CA") toCA++; else toNull++;
    if (!dryRun && want !== r.country) upd.run(want, r.id);
  }
  return { scanned: rows.length, toUS, toCA, toNull };
}

/**
 * Backfill retailer tokens for companies that already have Faire orders, using
 * the tokens captured on newly-synced orders. Cheap safety net for buyers whose
 * company row predates token capture.
 */
export function backfillTokensFromOrders(): { updated: number } {
  const res = sqlite
    .prepare(
      `UPDATE companies
          SET faire_retailer_id = (
            SELECT om.faire_retailer_id FROM outreach_messages om
             WHERE om.company_id = companies.id AND om.faire_retailer_id IS NOT NULL
             LIMIT 1)
        WHERE (faire_retailer_id IS NULL OR faire_retailer_id = '')
          AND EXISTS (SELECT 1 FROM outreach_messages om2
                       WHERE om2.company_id = companies.id AND om2.faire_retailer_id IS NOT NULL)`,
    )
    .run();
  return { updated: res.changes };
}
