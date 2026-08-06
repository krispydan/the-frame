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
  reason?: string;
}
export interface ImportSend {
  retailer_token: string;
  retailer?: string;
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
interface MatchIndex {
  byToken: Map<string, string>;                                   // r_… -> company id
  byName: Map<string, Array<{ id: string; state: string }>>;      // normalized name -> rows
}

function buildIndex(): MatchIndex {
  const byToken = new Map<string, string>();
  const byName = new Map<string, Array<{ id: string; state: string }>>();
  const rows = sqlite
    .prepare("SELECT id, name, state, faire_retailer_id FROM companies")
    .all() as Array<{ id: string; name: string | null; state: string | null; faire_retailer_id: string | null }>;
  for (const r of rows) {
    if (r.faire_retailer_id) byToken.set(r.faire_retailer_id, r.id);
    const n = norm(r.name);
    if (!n || n.length < 3) continue;
    const list = byName.get(n);
    const entry = { id: r.id, state: (r.state || "").toUpperCase() };
    if (list) list.push(entry);
    else byName.set(n, [entry]);
  }
  return { byToken, byName };
}

/** Resolve a campaign contact to a company id, conservatively. */
function resolveCompany(
  idx: MatchIndex,
  c: { retailer_token?: string; retailer?: string; state?: string },
): { id: string | null; how: "token" | "name" | null } {
  if (c.retailer_token) {
    const hit = idx.byToken.get(c.retailer_token);
    if (hit) return { id: hit, how: "token" };
  }
  const n = norm(c.retailer);
  if (!n || n.length < 3) return { id: null, how: null };

  const exact = idx.byName.get(n);
  if (!exact || !exact.length) return { id: null, how: null };
  if (exact.length === 1) return { id: exact[0].id, how: "name" };
  // Ambiguous on name alone — only state can break the tie, else refuse.
  const wantState = c.state?.toUpperCase();
  if (wantState) {
    const byState = exact.filter((x) => x.state === wantState);
    if (byState.length === 1) return { id: byState[0].id, how: "name" };
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
