export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { getSessionUser } from "@/lib/get-session";

/**
 * GET /api/v1/marketing/outreach?days=30
 *
 * Cross-channel outreach analytics: cold calls (PhoneBurner), cold email
 * (Instantly), paid social leads (Meta), and the direct-mail catalog cohort —
 * plus the funnel from touch → interested → first order.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const days = Math.min(365, Math.max(7, parseInt(req.nextUrl.searchParams.get("days") || "30", 10)));
  const start = new Date(Date.now() - days * 86400000).toISOString();
  const priorStart = new Date(Date.now() - 2 * days * 86400000).toISOString();

  const one = <T,>(sql: string, ...args: unknown[]): T | undefined =>
    sqlite.prepare(sql).get(...args) as T | undefined;
  const many = <T,>(sql: string, ...args: unknown[]): T[] => sqlite.prepare(sql).all(...args) as T[];
  const safe = <T,>(fn: () => T, fallback: T): T => {
    try { return fn(); } catch { return fallback; }
  };

  // ── Calls ──
  const calls = safe(() => one<{ total: number; connected: number }>(
    `SELECT COUNT(*) total, SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) connected
       FROM phoneburner_call_log WHERE called_at >= ?`, start) ?? { total: 0, connected: 0 },
    { total: 0, connected: 0 });
  const callsPrior = safe(() => one<{ total: number; connected: number }>(
    `SELECT COUNT(*) total, SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) connected
       FROM phoneburner_call_log WHERE called_at >= ? AND called_at < ?`, priorStart, start) ?? { total: 0, connected: 0 },
    { total: 0, connected: 0 });
  const callsByDay = safe(() => many<{ d: string; dials: number; connects: number }>(
    `SELECT substr(called_at,1,10) d, COUNT(*) dials, SUM(CASE WHEN connected=1 THEN 1 ELSE 0 END) connects
       FROM phoneburner_call_log WHERE called_at >= ? GROUP BY d ORDER BY d`, start), []);
  const dispositions = safe(() => many<{ label: string; n: number }>(
    `SELECT COALESCE(disposition_label,'(none)') label, COUNT(*) n
       FROM phoneburner_call_log WHERE called_at >= ? GROUP BY label ORDER BY n DESC LIMIT 10`, start), []);
  const agents = safe(() => many<{ agent: string; dials: number; connects: number }>(
    `SELECT COALESCE(agent_email,'(unknown)') agent, COUNT(*) dials,
            SUM(CASE WHEN connected=1 THEN 1 ELSE 0 END) connects
       FROM phoneburner_call_log WHERE called_at >= ? GROUP BY agent ORDER BY dials DESC LIMIT 8`, start), []);

  // ── Email ──
  const email = safe(() => one<{ sent: number; replies: number; interested: number; bounced: number }>(
    `SELECT
       SUM(CASE WHEN event_type='email_sent' THEN 1 ELSE 0 END) sent,
       SUM(CASE WHEN event_type IN ('reply_received','auto_reply_received') THEN 1 ELSE 0 END) replies,
       SUM(CASE WHEN event_type='lead_interested' THEN 1 ELSE 0 END) interested,
       SUM(CASE WHEN event_type='email_bounced' THEN 1 ELSE 0 END) bounced
     FROM instantly_webhook_events WHERE received_at >= ?`, start)
    ?? { sent: 0, replies: 0, interested: 0, bounced: 0 },
    { sent: 0, replies: 0, interested: 0, bounced: 0 });
  const emailByCampaign = safe(() => many<{ campaign: string; sent: number; replies: number; interested: number }>(
    `SELECT COALESCE(campaign_name,'(unnamed)') campaign,
            SUM(CASE WHEN event_type='email_sent' THEN 1 ELSE 0 END) sent,
            SUM(CASE WHEN event_type IN ('reply_received','auto_reply_received') THEN 1 ELSE 0 END) replies,
            SUM(CASE WHEN event_type='lead_interested' THEN 1 ELSE 0 END) interested
       FROM instantly_webhook_events WHERE received_at >= ?
      GROUP BY campaign HAVING sent > 0 ORDER BY sent DESC LIMIT 8`, start), []);

  // ── Paid social (Meta lead ads) ──
  const metaLeads = safe(() => one<{ total: number; processed: number }>(
    `SELECT COUNT(*) total, SUM(CASE WHEN status='processed' THEN 1 ELSE 0 END) processed
       FROM meta_leads WHERE created_at >= ?`, start) ?? { total: 0, processed: 0 },
    { total: 0, processed: 0 });

  // ── Direct mail ──
  const directMail = safe(() => one<{ n: number }>(
    `SELECT COUNT(*) n FROM companies WHERE tags LIKE '%catalog_mailed_2026%'`)?.n ?? 0, 0);

  // ── Funnel: worked companies → interested → ordered ──
  const funnel = safe(() => {
    const touched = one<{ n: number }>(
      `SELECT COUNT(DISTINCT company_id) n FROM (
         SELECT company_id FROM phoneburner_call_log WHERE called_at >= ? AND company_id IS NOT NULL
         UNION SELECT company_id FROM meta_leads WHERE created_at >= ? AND company_id IS NOT NULL
       )`, start, start)?.n ?? 0;
    const interested = one<{ n: number }>(
      `SELECT COUNT(*) n FROM companies WHERE status IN ('interested','catalog_sent')`)?.n ?? 0;
    const customers = one<{ n: number }>(
      `SELECT COUNT(*) n FROM companies WHERE status = 'customer'`)?.n ?? 0;
    return { touched, interested, customers };
  }, { touched: 0, interested: 0, customers: 0 });

  return NextResponse.json({
    ok: true,
    days,
    calls: {
      ...calls,
      connectRate: calls.total ? (calls.connected / calls.total) * 100 : 0,
      priorConnectRate: callsPrior.total ? (callsPrior.connected / callsPrior.total) * 100 : 0,
      priorTotal: callsPrior.total,
      byDay: callsByDay,
      dispositions,
      agents,
    },
    email: { ...email, replyRate: email.sent ? (email.replies / email.sent) * 100 : 0, byCampaign: emailByCampaign },
    metaLeads,
    directMail,
    funnel,
  });
}
