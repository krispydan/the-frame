export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { postPhoneBurnerCallDigest } from "@/modules/integrations/lib/slack/phoneburner-digest";

/**
 * GET  /api/admin/phoneburner/digest-diag  → diagnostics only
 * POST /api/admin/phoneburner/digest-diag  → diagnostics + fire the digest now
 *
 * Curl-able replacement for SSH debugging (Railway SSH requires an
 * ed25519 key we don't have locally). Shows:
 *   - digest.phoneburner routing row
 *   - recent slack_message_log attempts for the topic
 *   - phoneburner-digest-daily cron state + recent runs
 *   - call_log timestamp format breakdown (naive vs ISO)
 *
 * POST additionally invokes postPhoneBurnerCallDigest() and returns
 * its result so we see the real success/skip/error inline.
 *
 * Auth: x-admin-key: jaxy2026
 */
function diag() {
  const routing = sqlite
    .prepare(
      "SELECT topic, channel_id, channel_name, enabled FROM slack_channel_routing WHERE topic='digest.phoneburner'",
    )
    .get() ?? null;

  const slackLog = sqlite
    .prepare(
      `SELECT channel_name, ok, error, text_preview, sent_at
         FROM slack_message_log
        WHERE topic='digest.phoneburner'
          AND sent_at >= datetime('now','-30 hours')
        ORDER BY sent_at DESC LIMIT 5`,
    )
    .all();

  let cronState: unknown = null;
  try {
    cronState = sqlite
      .prepare(
        "SELECT id, last_run_at, last_status, enabled FROM cron_job_state WHERE id='phoneburner-digest-daily'",
      )
      .get() ?? null;
  } catch {
    cronState = "(cron_job_state shape differs)";
  }

  const tsFormat = sqlite
    .prepare(
      `SELECT SUM(CASE WHEN called_at LIKE '%Z' THEN 1 ELSE 0 END) AS iso,
              SUM(CASE WHEN called_at NOT LIKE '%Z' THEN 1 ELSE 0 END) AS naive
         FROM phoneburner_call_log`,
    )
    .get();

  // Yesterday PT window count (mirror the digest's own logic loosely)
  const ydayCount = sqlite
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN lower(disposition_label) LIKE 'set appointment%' THEN 1 ELSE 0 END) AS interested
         FROM phoneburner_call_log
        WHERE datetime(called_at) >= datetime('now','-1 day','start of day')
          AND datetime(called_at) <  datetime('now','start of day')`,
    )
    .get();

  return { routing, slackLog, cronState, tsFormat, ydayCount };
}

export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...diag() });
}

export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const before = diag();
  let fireResult: unknown;
  try {
    fireResult = await postPhoneBurnerCallDigest();
  } catch (e) {
    fireResult = { threw: e instanceof Error ? e.message : String(e) };
  }
  return NextResponse.json({ ok: true, diagnostics: before, fire_result: fireResult });
}
