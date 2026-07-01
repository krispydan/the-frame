export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { randomUUID } from "crypto";

/**
 * POST /api/admin/slack/route-topic
 *
 * One-shot: point a SlackTopic at a channel by NAME. Finds the
 * channel id via Slack's API, joins the bot to it (best-effort), and
 * upserts the slack_channel_routing row. Curl-able replacement for the
 * /settings/slack UI (SSH is down).
 *
 * Body: { topic: string, channelName: string }   // channelName sans '#'
 * Auth: x-admin-key: jaxy2026
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not set" }, { status: 500 });
  }

  let body: { topic?: string; channelName?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON body required" }, { status: 400 }); }
  const topic = body.topic?.trim();
  const wantName = body.channelName?.replace(/^#/, "").trim();
  if (!topic || !wantName) {
    return NextResponse.json({ error: "topic + channelName required" }, { status: 400 });
  }

  // 1. Find the channel id by name.
  let channelId: string | null = null;
  let cursor: string | undefined;
  for (let p = 0; p < 20; p++) {
    const url = `https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!j.ok) return NextResponse.json({ error: `Slack conversations.list: ${j.error}` }, { status: 502 });
    for (const c of j.channels ?? []) if (c.name === wantName) channelId = c.id;
    cursor = j.response_metadata?.next_cursor;
    if (!cursor || channelId) break;
  }
  if (!channelId) {
    return NextResponse.json({ error: `Channel #${wantName} not found (is it private + bot not invited?)` }, { status: 404 });
  }

  // 2. Best-effort join (public channels only; private need a manual invite).
  let joined: string | boolean = false;
  try {
    const jr = await fetch("https://slack.com/api/conversations.join", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: channelId }),
    });
    const jj = (await jr.json()) as { ok: boolean; error?: string };
    joined = jj.ok ? true : jj.error ?? false;
  } catch (e) {
    joined = e instanceof Error ? e.message : String(e);
  }

  // 3. Upsert routing.
  sqlite
    .prepare(
      `INSERT INTO slack_channel_routing (id, topic, channel_id, channel_name, enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(topic) DO UPDATE
         SET channel_id = excluded.channel_id,
             channel_name = excluded.channel_name,
             enabled = 1,
             updated_at = datetime('now')`,
    )
    .run(randomUUID(), topic, channelId, `#${wantName}`);

  return NextResponse.json({
    ok: true,
    topic,
    channel_id: channelId,
    channel_name: `#${wantName}`,
    bot_join_result: joined,
  });
}
