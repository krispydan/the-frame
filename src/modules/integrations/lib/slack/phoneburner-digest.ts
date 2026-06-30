/**
 * Daily PhoneBurner call activity digest.
 *
 * Queries phoneburner_call_log for yesterday's calls (PT) and posts a
 * Slack summary via the `digest.phoneburner` topic. Skips the post on
 * zero-call days so weekends + slow days don't generate noise.
 *
 * Called by the `phoneburner-digest-daily` cron job at 15:00 UTC
 * (~8am PT, alongside the other morning digests).
 */
import { sqlite } from "@/lib/db";
import { postSlack, type SlackBlock } from "./client";

/** PT calendar-day bounds for "yesterday", DST-safe. Cribbed from digests.ts. */
function ptYesterdayBounds(): { startIso: string; endIso: string; ptDate: string } {
  const ptDateOf = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);

  const yesterdayPt = ptDateOf(new Date(Date.now() - 24 * 3600_000));
  const [yy, mm, dd] = yesterdayPt.split("-").map(Number);
  const noonUtcYesterday = new Date(Date.UTC(yy, mm - 1, dd, 12));
  const ptHourAtNoonUtc = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", hourCycle: "h23", hour: "2-digit",
    }).format(noonUtcYesterday),
    10,
  );
  const offsetHours = ptHourAtNoonUtc - 12;
  const startUtc = new Date(Date.UTC(yy, mm - 1, dd, -offsetHours));
  const endUtc = new Date(startUtc.getTime() + 24 * 3600_000);
  return {
    startIso: startUtc.toISOString(),
    endIso: endUtc.toISOString(),
    ptDate: yesterdayPt,
  };
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

function formatDurationSec(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m${sec.toString().padStart(2, "0")}s`;
}

export async function postPhoneBurnerCallDigest(): Promise<{
  ok: boolean;
  skipped?: string;
  posted?: { messageTs: string | null; channel: string | null; calls: number };
  error?: string;
}> {
  const { startIso, endIso, ptDate } = ptYesterdayBounds();

  // Total + connect-rate stats
  const totals = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) AS connected,
              AVG(CASE WHEN connected = 1 AND duration_seconds IS NOT NULL THEN duration_seconds END) AS avg_dur_connected,
              COUNT(DISTINCT agent_email) AS distinct_agents
         FROM phoneburner_call_log
        WHERE datetime(called_at) >= datetime(?) AND datetime(called_at) < datetime(?)`,
    )
    .get(startIso, endIso) as {
      total: number;
      connected: number;
      avg_dur_connected: number | null;
      distinct_agents: number;
    };

  if (!totals.total) {
    return { ok: true, skipped: `no calls in PT day ${ptDate}` };
  }

  // Top 5 dispositions
  const topDispositions = sqlite
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(disposition_label), ''), '(no disposition)') AS label,
              COUNT(*) AS n
         FROM phoneburner_call_log
        WHERE datetime(called_at) >= datetime(?) AND datetime(called_at) < datetime(?)
        GROUP BY label
        ORDER BY n DESC, label ASC
        LIMIT 5`,
    )
    .all(startIso, endIso) as { label: string; n: number }[];

  // Agent breakdown
  const agentRows = sqlite
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(agent_email), ''), agent_id, '(unknown agent)') AS agent,
              COUNT(*) AS n,
              SUM(CASE WHEN connected = 1 THEN 1 ELSE 0 END) AS connected
         FROM phoneburner_call_log
        WHERE datetime(called_at) >= datetime(?) AND datetime(called_at) < datetime(?)
        GROUP BY agent
        ORDER BY n DESC
        LIMIT 6`,
    )
    .all(startIso, endIso) as { agent: string; n: number; connected: number }[];

  // Interested leads — every call in the window whose disposition is a
  // "Set Appointment" (they requested the catalog). These are the wins
  // the team cares about; replaces the old "most recent calls" list.
  const interestedLeads = sqlite
    .prepare(
      `SELECT COALESCE(co.name, l.phoneburner_contact_id, l.id) AS who,
              co.id    AS company_id,
              co.phone AS phone,
              co.website AS website,
              l.disposition_label AS disposition
         FROM phoneburner_call_log l
         LEFT JOIN companies co ON co.id = l.company_id
        WHERE datetime(l.called_at) >= datetime(?) AND datetime(l.called_at) < datetime(?)
          AND lower(l.disposition_label) LIKE 'set appointment%'
        ORDER BY l.called_at DESC`,
    )
    .all(startIso, endIso) as Array<{
      who: string;
      company_id: string | null;
      phone: string | null;
      website: string | null;
      disposition: string | null;
    }>;

  // Build Slack blocks
  const headerText = `📞 PhoneBurner — ${ptDate}`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Total calls*\n${totals.total}` },
        {
          type: "mrkdwn",
          text: `*Connect rate*\n${totals.connected}/${totals.total} (${pct(totals.connected, totals.total)})`,
        },
        {
          type: "mrkdwn",
          text: `*Avg duration (connected)*\n${formatDurationSec(totals.avg_dur_connected)}`,
        },
        { type: "mrkdwn", text: `*Active agents*\n${totals.distinct_agents}` },
      ],
    },
  ];

  if (topDispositions.length) {
    const dispLines = topDispositions
      .map((d) => `• *${d.label}* — ${d.n} (${pct(d.n, totals.total)})`)
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Top dispositions*\n${dispLines}` },
    });
  }

  if (agentRows.length) {
    const agentLines = agentRows
      .map((a) => `• ${a.agent} — ${a.n} (${a.connected} connected, ${pct(a.connected, a.n)})`)
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Calls by agent*\n${agentLines}` },
    });
  }

  // Interested leads — the headline of the cold-calling digest.
  const appBase = (
    process.env.SHOPIFY_APP_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "https://theframe.getjaxy.com"
  ).replace(/\/$/, "");

  if (interestedLeads.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*🎯 Interested leads*\n_None today — keep dialing._` },
    });
  } else {
    const lines = interestedLeads.map((c) => {
      const name = c.company_id
        ? `<${appBase}/prospects/${c.company_id}|${c.who}>`
        : c.who;
      const extras: string[] = [];
      if (c.phone) extras.push(c.phone);
      if (c.website) extras.push(`<${c.website}|site>`);
      return `• *${name}*${extras.length ? ` — ${extras.join(" · ")}` : ""}`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*🎯 Interested leads (${interestedLeads.length})*\n${lines.join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Window: ${startIso} → ${endIso} · ${interestedLeads.length} appointment${interestedLeads.length === 1 ? "" : "s"} set`,
      },
    ],
  });

  const text = `📞 PhoneBurner ${ptDate}: ${totals.total} calls, ${pct(totals.connected, totals.total)} connect rate`;

  const result = await postSlack({
    topic: "digest.phoneburner",
    text,
    blocks,
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? "Slack post failed" };
  }
  return {
    ok: true,
    posted: {
      messageTs: result.ts ?? null,
      channel: result.channel ?? null,
      calls: totals.total,
    },
  };
}
