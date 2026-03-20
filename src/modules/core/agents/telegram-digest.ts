/**
 * Telegram Digest Agent
 * Sends daily summary of prospect/pipeline stats to Telegram.
 * Triggered via API, MCP tool, or scheduled job.
 */
import { sqlite } from "@/lib/db";

interface DigestStats {
  totalProspects: number;
  newToday: number;
  qualifiedToday: number;
  withEmail: number;
  withPhone: number;
  icpBreakdown: Record<string, number>;
  errorsLast24h: number;
  agentRunsLast24h: number;
}

async function gatherStats(): Promise<DigestStats> {
  const db = sqlite();
  const today = new Date().toISOString().split("T")[0];

  const totalProspects = (db.prepare("SELECT COUNT(*) as c FROM companies").get() as { c: number }).c;

  const newToday = (
    db.prepare("SELECT COUNT(*) as c FROM companies WHERE DATE(created_at) = ?").get(today) as { c: number }
  ).c;

  const qualifiedToday = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM change_logs WHERE entity_type = 'company' AND field = 'status' AND new_value = 'qualified' AND DATE(created_at) = ?"
      )
      .get(today) as { c: number }
  ).c;

  const withEmail = (
    db
      .prepare("SELECT COUNT(DISTINCT company_id) as c FROM contacts WHERE email IS NOT NULL AND email != ''")
      .get() as { c: number }
  ).c;

  const withPhone = (
    db
      .prepare("SELECT COUNT(DISTINCT company_id) as c FROM contacts WHERE phone IS NOT NULL AND phone != ''")
      .get() as { c: number }
  ).c;

  const icpRows = db
    .prepare(
      "SELECT icp_tier, COUNT(*) as count FROM companies WHERE icp_tier IS NOT NULL AND icp_tier != '' GROUP BY icp_tier ORDER BY icp_tier"
    )
    .all() as { icp_tier: string; count: number }[];
  const icpBreakdown: Record<string, number> = {};
  for (const row of icpRows) {
    icpBreakdown[row.icp_tier] = row.count;
  }

  const errorsLast24h = (
    db
      .prepare("SELECT COUNT(*) as c FROM error_logs WHERE created_at >= datetime('now', '-24 hours')")
      .get() as { c: number }
  ).c;

  const agentRunsLast24h = (
    db
      .prepare("SELECT COUNT(*) as c FROM reporting_logs WHERE event_type = 'agent_run' AND created_at >= datetime('now', '-24 hours')")
      .get() as { c: number }
  ).c;

  return {
    totalProspects,
    newToday,
    qualifiedToday,
    withEmail,
    withPhone,
    icpBreakdown,
    errorsLast24h,
    agentRunsLast24h,
  };
}

function formatDigest(stats: DigestStats): string {
  const icpLines = Object.entries(stats.icpBreakdown)
    .map(([tier, count]) => `  ${tier}: ${count.toLocaleString()}`)
    .join("\n");

  return `📊 *The Frame — Daily Digest*

*Prospects*
  Total: ${stats.totalProspects.toLocaleString()}
  New today: ${stats.newToday.toLocaleString()}
  Qualified today: ${stats.qualifiedToday.toLocaleString()}
  With email: ${stats.withEmail.toLocaleString()}
  With phone: ${stats.withPhone.toLocaleString()}

*ICP Breakdown*
${icpLines || "  Not classified yet"}

*System*
  Errors (24h): ${stats.errorsLast24h}
  Agent runs (24h): ${stats.agentRunsLast24h}`;
}

async function sendToTelegram(message: string): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.warn("[Telegram Digest] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set, skipping");
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      console.error(`[Telegram Digest] Failed: ${response.status} ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[Telegram Digest] Error:", error);
    return false;
  }
}

/**
 * Run the daily digest — gather stats and send to Telegram.
 */
export async function runTelegramDigest(): Promise<{ stats: DigestStats; sent: boolean; message: string }> {
  const stats = await gatherStats();
  const message = formatDigest(stats);
  const sent = await sendToTelegram(message);

  return { stats, sent, message };
}
