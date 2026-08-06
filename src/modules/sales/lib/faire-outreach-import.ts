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

/** Resolve a campaign contact to a company id, conservatively. */
function resolveCompany(c: { retailer_token?: string; retailer?: string; state?: string }): { id: string | null; how: "token" | "name" | null } {
  if (c.retailer_token) {
    const byToken = sqlite
      .prepare("SELECT id FROM companies WHERE faire_retailer_id = ? LIMIT 1")
      .get(c.retailer_token) as { id: string } | undefined;
    if (byToken) return { id: byToken.id, how: "token" };
  }
  const n = norm(c.retailer);
  if (!n || n.length < 3) return { id: null, how: null };

  // Candidates by loose name match, then filter on normalized equality.
  const token = n.split(" ")[0];
  const cands = sqlite
    .prepare("SELECT id, name, state FROM companies WHERE LOWER(COALESCE(name,'')) LIKE ? LIMIT 40")
    .all(`%${token}%`) as Array<{ id: string; name: string | null; state: string | null }>;
  const exact = cands.filter((x) => norm(x.name) === n);
  if (exact.length === 1) return { id: exact[0].id, how: "name" };
  const wantState = c.state?.toUpperCase();
  if (exact.length > 1 && wantState) {
    const byState = exact.filter((x) => (x.state || "").toUpperCase() === wantState);
    if (byState.length === 1) return { id: byState[0].id, how: "name" };
  }
  return { id: null, how: null };
}

export function importFaireOutreach(payload: {
  contacts?: ImportContact[];
  skips?: ImportSkip[];
  sends?: ImportSend[];
  campaign?: string;
  dryRun?: boolean;
}): ImportSummary {
  const campaign = payload.campaign || "faire_market_2026_07";
  const dry = !!payload.dryRun;
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
    const r = resolveCompany(c);
    if (!r.id) {
      summary.contacts.unmatched++;
      if (unmatchedSamples.length < 25) unmatchedSamples.push(`${c.retailer || "?"} (${c.state || "?"})`);
      continue;
    }
    if (r.how === "token") summary.contacts.matchedByToken++;
    else summary.contacts.matchedByName++;
    if (!dry && r.how === "name") {
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
    const r = resolveCompany(s);
    if (!r.id) { summary.skips.unmatched++; continue; }
    if (!dry) {
      sqlite
        .prepare(
          `UPDATE companies
              SET do_not_contact = 1,
                  do_not_contact_reason = ?,
                  do_not_contact_at = COALESCE(do_not_contact_at, ?)
            WHERE id = ?`,
        )
        .run(`faire campaign: ${s.reason || "skiplist"}`, new Date().toISOString(), r.id);
    }
    summary.skips.applied++;
  }

  // 3. Send history -> outreach_messages. Kept even when we can't match a
  //    company: the retailer token alone is enough for the Faire cooldown
  //    check, which is the whole point of importing this.
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO outreach_messages
       (id, company_id, faire_retailer_id, channel, direction, status, body, campaign, sent_at, source)
     VALUES (?, ?, ?, 'faire', 'outbound', ?, ?, ?, ?, 'faire_dm_import')`,
  );
  for (const m of payload.sends || []) {
    summary.sends.received++;
    // left_unsent counts as sent for cooldown purposes — the send-verification
    // check produced false negatives, and a duplicate is worse than a miss.
    const status = m.status === "left_unsent" ? "sent_unverified" : m.status;
    const r = resolveCompany(m);
    if (!r.id) summary.sends.unmatchedButKept++;
    if (!dry) {
      const res = insert.run(
        randomUUID(), r.id, m.retailer_token, status, m.message || null, campaign, m.at || null,
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
