/**
 * The lead's back-story, for the Slack alert a CEO reads.
 *
 * Distinct from lead-context.ts, which describes what the STORE is (type,
 * size, socials, ICP) and feeds the AI opener writer. This describes what has
 * HAPPENED WITH US — prior AJ Morgan trade, where the lead came from, how the
 * email sequence went, how many times we called before this one, and whether
 * they've ever ordered.
 *
 * The question it answers is "how did we get here, and have we been here
 * before" — which is the difference between a genuinely new lead and a
 * dormant customer coming back, and those deserve very different follow-ups.
 *
 * Every section is omitted when empty. A block full of "none / 0 / —" is
 * noise, and the alert is already long.
 */
import { sqlite } from "@/lib/db";

export interface LeadHistory {
  /** Prior AJ Morgan trading relationship, if any. */
  ajm: { orders: number; spend: number; lastOrder: string | null } | null;
  /** Where the lead came from, best available description. */
  source: string | null;
  /** Email sequence outcome across all campaigns. */
  email: {
    campaigns: string[];
    sent: number;
    opened: number;
    replied: number;
    bounced: number;
    lastRepliedAt: string | null;
  } | null;
  /** Calls before this one. */
  calls: { total: number; firstCalledAt: string | null; priorDispositions: string[] } | null;
  /** Orders with Jaxy. */
  orders: { count: number; total: number; firstAt: string | null; lastAt: string | null } | null;
}

function money(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

/** "2024-11-03" / ISO → "Nov 2024". Precision beyond the month is noise here. */
function monthYear(d: string | null): string | null {
  if (!d) return null;
  const t = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function yearsSince(d: string | null): number | null {
  if (!d) return null;
  const t = Date.parse(d.length <= 10 ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
}

export function loadLeadHistory(companyId: string): LeadHistory {
  const empty: LeadHistory = { ajm: null, source: null, email: null, calls: null, orders: null };

  let company: Record<string, unknown> | undefined;
  try {
    company = sqlite
      .prepare(
        `SELECT source, source_type, lead_source_detail, tags,
                ajm_total_spend, ajm_total_orders, ajm_last_order
           FROM companies WHERE id = ?`,
      )
      .get(companyId) as Record<string, unknown> | undefined;
  } catch {
    return empty;
  }
  if (!company) return empty;

  const out: LeadHistory = { ...empty };

  // ── AJM: the single most decision-changing fact in the whole alert. A store
  //    that already bought AJ Morgan is a reactivation, not a cold win.
  const ajmOrders = Number(company.ajm_total_orders ?? 0);
  const ajmSpend = Number(company.ajm_total_spend ?? 0);
  if (ajmOrders > 0 || ajmSpend > 0) {
    out.ajm = {
      orders: ajmOrders,
      spend: ajmSpend,
      lastOrder: (company.ajm_last_order as string) ?? null,
    };
  }

  // ── Source. lead_source_detail is the most specific when present; fall back
  //    to source_type/source, and mention the AJM tag only if it adds anything.
  const detail = (company.lead_source_detail as string)?.trim();
  const sourceType = (company.source_type as string)?.trim();
  const source = (company.source as string)?.trim();
  out.source = detail || sourceType || source || null;

  // ── Email sequence across every campaign the lead sits in.
  try {
    const rows = sqlite
      .prepare(
        `SELECT cl.status, cl.sent_at, cl.opened_at, cl.replied_at,
                COALESCE(c.name, '') AS campaign_name
           FROM campaign_leads cl
           LEFT JOIN campaigns c ON c.id = cl.campaign_id
          WHERE cl.company_id = ?`,
      )
      .all(companyId) as Array<{
        status: string | null;
        sent_at: string | null;
        opened_at: string | null;
        replied_at: string | null;
        campaign_name: string;
      }>;

    if (rows.length) {
      const replies = rows.map((r) => r.replied_at).filter(Boolean).sort() as string[];
      out.email = {
        campaigns: [...new Set(rows.map((r) => r.campaign_name).filter(Boolean))].slice(0, 3),
        sent: rows.filter((r) => r.sent_at).length,
        opened: rows.filter((r) => r.opened_at).length,
        replied: rows.filter((r) => r.replied_at).length,
        bounced: rows.filter((r) => r.status === "bounced").length,
        lastRepliedAt: replies.length ? replies[replies.length - 1] : null,
      };
    }
  } catch { /* table shape drift — the alert is still worth sending */ }

  // ── Call history BEFORE this one. "Fourth call" and "first call" are
  //    different stories about the same appointment.
  try {
    const calls = sqlite
      .prepare(
        `SELECT disposition_label, called_at
           FROM phoneburner_call_log
          WHERE company_id = ?
          ORDER BY called_at ASC`,
      )
      .all(companyId) as Array<{ disposition_label: string | null; called_at: string | null }>;

    if (calls.length > 1) {
      // Drop the most recent — that's the call this alert is about.
      const prior = calls.slice(0, -1);
      out.calls = {
        total: calls.length,
        firstCalledAt: prior[0]?.called_at ?? null,
        priorDispositions: [
          ...new Set(prior.map((c) => (c.disposition_label ?? "").trim()).filter(Boolean)),
        ].slice(0, 4),
      };
    }
  } catch { /* ignore */ }

  // ── Jaxy orders. Rare on an interested lead, and enormously significant
  //    when present — it means this is an existing customer, not a prospect.
  try {
    const o = sqlite
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(total), 0) total,
                MIN(placed_at) first_at, MAX(placed_at) last_at
           FROM orders
          WHERE company_id = ? AND status NOT IN ('cancelled', 'returned')`,
      )
      .get(companyId) as { n: number; total: number; first_at: string | null; last_at: string | null };
    if (o && o.n > 0) {
      out.orders = { count: o.n, total: o.total, firstAt: o.first_at, lastAt: o.last_at };
    }
  } catch { /* ignore */ }

  return out;
}

/**
 * Render the history as Slack mrkdwn lines. Returns [] when there's nothing
 * worth saying, so the caller can skip the block entirely.
 */
export function formatLeadHistory(h: LeadHistory): string[] {
  const lines: string[] = [];

  if (h.ajm) {
    const when = monthYear(h.ajm.lastOrder);
    const yrs = yearsSince(h.ajm.lastOrder);
    // Dormancy is the actionable part — "bought 4 years ago" and "bought last
    // season" call for completely different conversations.
    const dormant = yrs != null && yrs >= 1 ? ` · dormant ${Math.floor(yrs)}y` : "";
    lines.push(
      `*🏷️ AJ Morgan customer* — ${h.ajm.orders} order${h.ajm.orders === 1 ? "" : "s"}, ` +
      `${money(h.ajm.spend)}${when ? ` · last ${when}` : ""}${dormant}`,
    );
  }

  if (h.orders) {
    const last = monthYear(h.orders.lastAt);
    lines.push(
      `*💰 Jaxy orders* — ${h.orders.count} × ${money(h.orders.total)}${last ? ` · last ${last}` : ""}`,
    );
  }

  if (h.source) lines.push(`*🌱 Lead source* — ${h.source}`);

  if (h.email) {
    const e = h.email;
    const bits = [`${e.sent} sent`];
    if (e.opened) bits.push(`${e.opened} opened`);
    if (e.replied) bits.push(`${e.replied} replied`);
    if (e.bounced) bits.push(`⚠️ ${e.bounced} bounced`);
    const camps = e.campaigns.length ? ` _(${e.campaigns.join(", ")})_` : "";
    lines.push(`*📧 Email* — ${bits.join(" · ")}${camps}`);
  }

  if (h.calls) {
    const first = monthYear(h.calls.firstCalledAt);
    const disp = h.calls.priorDispositions.length
      ? ` · previously: ${h.calls.priorDispositions.join(", ")}`
      : "";
    lines.push(
      `*☎️ Call history* — call #${h.calls.total}${first ? `, first contacted ${first}` : ""}${disp}`,
    );
  }

  return lines;
}
