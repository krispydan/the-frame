/**
 * Who should go into Instantly next.
 *
 * Picks from leads ALREADY in the frame — companies with an email address that
 * have never been pushed to a campaign. This is a different pool from the
 * Apify bench: those are freshly scraped places with no email at all.
 *
 * Ranking uses the same buyer profile the qualifier bench validated, applied to
 * whatever evidence each company already has:
 *
 *   Google Maps shape   category and review-band match against real buyers,
 *                       from gmaps_listings where we captured one
 *   AJM trade history   they bought from AJM. The single strongest signal we
 *                       hold: a shop that has ordered this category before is
 *                       not a cold guess about fit.
 *   ICP tier            an existing human/LLM judgement, when present
 *   Contactability      a verified-deliverable address beats an unverified one
 *
 * Two rules the ranking must not break:
 *
 *  1. SUPPRESSION IS NOT A RANKING INPUT, IT IS A GATE. checkSuppression() is
 *     the only authority on whether we may message someone, and it fails
 *     closed. A suppressed company never appears here at any score.
 *  2. INVALID EMAILS ARE EXCLUDED, NOT DEPRIORITISED. Sending to a known-bad
 *     address damages the sending domain for every other lead in the campaign,
 *     so a bad address is disqualifying rather than a low score.
 */

import { sqlite } from "@/lib/db";
import { CHAIN_REVIEW_CEILING, MIN_RATING, buyerProfile } from "./qualifier-test";
import { checkSuppression } from "./suppression";

export interface CohortRow {
  companyId: string;
  name: string;
  email: string;
  contactId: string | null;
  city: string | null;
  state: string | null;
  status: string | null;
  icpTier: string | null;
  verification: string | null;
  gmapsCategory: string | null;
  reviewCount: number | null;
  rating: number | null;
  ajmOrders: number;
  ajmRevenue: number;
  score: number;
  reasons: string[];
}

/**
 * Candidate pool: one row per company that has an email and has never been
 * pushed to Instantly.
 *
 * "Never pushed" means NO campaign_leads row at all — not "no row carrying an
 * instantly_lead_id", which is what this used to test and which was wrong.
 * importLeadsFromInstantly() only pulls campaigns already registered here with
 * an instantly_campaign_id, so campaigns run directly in Instantly leave no
 * lead id behind. Keying on that id made 385 already-contacted shops look
 * fresh. A campaign_leads row of any kind means they are spoken for; a lead id
 * only means we happen to know Instantly's identifier for them.
 */
const CANDIDATE_SQL = `
  SELECT
    c.id                         AS companyId,
    c.name                       AS name,
    c.city, c.state, c.status,
    c.icp_tier                   AS icpTier,
    c.email_verification_status  AS verification,
    ct.id                        AS contactId,
    LOWER(TRIM(ct.email))        AS email,
    g.category_name              AS gmapsCategory,
    g.sub_types                  AS gmapsSubTypes,
    COALESCE(g.review_count, c.google_review_count) AS reviewCount,
    COALESCE(g.rating, c.google_rating)             AS rating,
    COALESCE(g.permanently_closed, 0)               AS closed,
    (SELECT COUNT(*)          FROM ajm_orders a WHERE a.company_id = c.id) AS ajmOrders,
    (SELECT COALESCE(SUM(a.total),0) FROM ajm_orders a WHERE a.company_id = c.id) AS ajmRevenue
  FROM companies c
  JOIN contacts ct
    ON ct.company_id = c.id
   AND ct.email IS NOT NULL AND TRIM(ct.email) <> ''
  LEFT JOIN gmaps_listings g ON g.company_id = c.id
  WHERE COALESCE(c.do_not_contact, 0) = 0
    -- Never pushed: no campaign_leads row of any kind for this company...
    AND NOT EXISTS (
      SELECT 1 FROM campaign_leads cl WHERE cl.company_id = c.id
    )
    -- ...and this address has not gone out under some OTHER company row.
    -- Duplicate company records for one shop are common after imports, and a
    -- mailbox does not care which row we mailed it from.
    AND NOT EXISTS (
      SELECT 1 FROM campaign_leads cl2
       WHERE LOWER(TRIM(cl2.email)) = LOWER(TRIM(ct.email))
    )
    -- Existing customers are not cold-outreach targets.
    AND NOT EXISTS (
      SELECT 1 FROM orders o
       WHERE o.company_id = c.id AND o.status NOT IN ('cancelled','returned')
    )
    AND c.status NOT IN ('customer','not_interested','ghosted','disqualified')
  GROUP BY c.id
  ORDER BY ct.is_primary DESC, ct.created_at ASC
`;

interface RawRow {
  companyId: string; name: string; city: string | null; state: string | null;
  status: string | null; icpTier: string | null; verification: string | null;
  contactId: string | null; email: string;
  gmapsCategory: string | null; gmapsSubTypes: string | null;
  reviewCount: number | null; rating: number | null; closed: number;
  ajmOrders: number; ajmRevenue: number;
}

/** Free-mail hosts are fine for a boutique owner — this is not a penalty. */
const ROLE_PREFIXES = /^(info|hello|contact|sales|shop|store|orders|support|admin|team|mail)@/i;

function scoreRow(r: RawRow, prof: ReturnType<typeof buyerProfile>): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // AJM trade history — the strongest evidence we hold. A shop that bought this
  // category before is not a cold guess about fit, so it outweighs every
  // inferred signal below.
  if (r.ajmOrders > 0) {
    const pts = r.ajmRevenue >= 5000 ? 40 : r.ajmRevenue >= 1000 ? 32 : 25;
    score += pts;
    reasons.push(`AJM buyer: ${r.ajmOrders} orders, $${Math.round(r.ajmRevenue).toLocaleString()}`);
  }

  // Google Maps shape, scored exactly as the qualifier bench scores a scrape.
  let subs: string[] = [];
  try { subs = r.gmapsSubTypes ? (JSON.parse(r.gmapsSubTypes) as string[]) : []; } catch { /* keep [] */ }
  if (r.gmapsCategory && (prof.categories.has(r.gmapsCategory) || prof.subTypes.has(r.gmapsCategory))) {
    score += 25;
    reasons.push(`category match: ${r.gmapsCategory}`);
  } else if (subs.some((s) => prof.subTypes.has(s))) {
    score += 12;
    reasons.push("sub-type match");
  }

  const rc = Number(r.reviewCount ?? 0);
  if (rc > 0 && rc >= prof.p25 && rc <= prof.p75) {
    score += 20;
    reasons.push(`review band (${rc})`);
  }

  // An existing tier judgement, where a human or the LLM already formed one.
  if (r.icpTier === "A") { score += 15; reasons.push("ICP tier A"); }
  else if (r.icpTier === "B") { score += 8; reasons.push("ICP tier B"); }
  else if (r.icpTier === "D") { score -= 15; reasons.push("ICP tier D"); }

  // Deliverability. Verified-good is a real advantage; unverified is neutral,
  // not a penalty, because verification is the next step for this whole cohort.
  if (r.verification === "valid") { score += 10; reasons.push("email verified valid"); }
  else if (r.verification === "catchall") { score += 4; reasons.push("catchall domain"); }

  // A named mailbox reaches a person; a role mailbox reaches a queue.
  if (!ROLE_PREFIXES.test(r.email)) { score += 5; reasons.push("named mailbox"); }

  return { score: Math.max(0, score), reasons };
}

export interface CohortResult {
  funnel: Record<string, number>;
  buyerProfileBasis: { customerListings: number; controlListings: number; reviewBand: [number, number] };
  selected: CohortRow[];
  breakdown: {
    byState: Array<{ state: string; n: number }>;
    byVerification: Array<{ status: string; n: number }>;
    byEvidence: Array<{ evidence: string; n: number }>;
    scoreBands: Array<{ band: string; n: number }>;
  };
  excluded: { suppressed: number; invalidEmail: number; chainByReviews: number; closed: number; lowRated: number };
}

export function buildCohort(limit = 1000, minScore = 0): CohortResult {
  const prof = buyerProfile();
  const raw = sqlite.prepare(CANDIDATE_SQL).all() as RawRow[];

  const excluded = { suppressed: 0, invalidEmail: 0, chainByReviews: 0, closed: 0, lowRated: 0 };
  const seenEmail = new Set<string>();
  const scored: CohortRow[] = [];

  for (const r of raw) {
    if (!r.email || !r.email.includes("@")) continue;
    // The same address can sit on several companies (shared owner, bad import).
    // Sending twice to one mailbox is what makes a campaign look like spam.
    if (seenEmail.has(r.email)) continue;

    // Suppression goes through the shared module rather than being
    // reimplemented in SQL — one authority on "may we message this company".
    if (checkSuppression(r.companyId).suppressed) { excluded.suppressed++; continue; }

    // Hard disqualifiers, mirroring the qualifier bench so both pipelines mean
    // the same thing by "not a prospect".
    if (["invalid", "disposable"].includes(String(r.verification))) { excluded.invalidEmail++; continue; }
    if (r.closed) { excluded.closed++; continue; }
    if (Number(r.reviewCount ?? 0) > CHAIN_REVIEW_CEILING) { excluded.chainByReviews++; continue; }
    if (Number(r.rating ?? 0) > 0 && Number(r.rating) < MIN_RATING) { excluded.lowRated++; continue; }

    seenEmail.add(r.email);
    const { score, reasons } = scoreRow(r, prof);
    scored.push({
      companyId: r.companyId, name: r.name, email: r.email, contactId: r.contactId,
      city: r.city, state: r.state, status: r.status, icpTier: r.icpTier,
      verification: r.verification, gmapsCategory: r.gmapsCategory,
      reviewCount: r.reviewCount, rating: r.rating,
      ajmOrders: r.ajmOrders, ajmRevenue: Math.round(r.ajmRevenue),
      score, reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.ajmRevenue - a.ajmRevenue);
  const selected = scored.filter((s) => s.score >= minScore).slice(0, limit);

  const tally = <T extends string>(xs: T[]) => {
    const m = new Map<T, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n);
  };

  const band = (s: number) => s >= 70 ? "70+" : s >= 50 ? "50-69" : s >= 30 ? "30-49" : s >= 15 ? "15-29" : "0-14";
  const evidenceOf = (r: CohortRow) =>
    r.ajmOrders > 0 && r.gmapsCategory ? "AJM + maps"
      : r.ajmOrders > 0 ? "AJM history only"
        : r.gmapsCategory ? "maps only"
          : "no enrichment";

  return {
    funnel: {
      candidateRows: raw.length,
      afterDedupeAndGates: scored.length,
      selected: selected.length,
      needVerification: selected.filter((s) => !s.verification || s.verification === "error").length,
      alreadyVerifiedOk: selected.filter((s) => s.verification === "valid" || s.verification === "catchall").length,
    },
    buyerProfileBasis: {
      customerListings: prof.basis.customerListings,
      controlListings: prof.basis.controlListings,
      reviewBand: [prof.p25, prof.p75],
    },
    selected,
    breakdown: {
      byState: tally(selected.map((s) => s.state || "—")).map(({ k, n }) => ({ state: k, n })).slice(0, 15),
      byVerification: tally(selected.map((s) => s.verification || "unverified")).map(({ k, n }) => ({ status: k, n })),
      byEvidence: tally(selected.map(evidenceOf)).map(({ k, n }) => ({ evidence: k, n })),
      scoreBands: tally(selected.map((s) => band(s.score))).map(({ k, n }) => ({ band: k, n })),
    },
    excluded,
  };
}
