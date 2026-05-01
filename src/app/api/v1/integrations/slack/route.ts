export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { slackChannelRouting, SLACK_TOPICS, slackMessageLog } from "@/modules/integrations/schema/slack";
import { eq, desc } from "drizzle-orm";
import { findChannelIdByName, postSlack, testSlackToken } from "@/modules/integrations/lib/slack/client";

/**
 * GET /api/v1/integrations/slack
 * Returns:
 *   { configured, auth: { ok, team, user, error }, routing: [...], recentMessages: [...] }
 *
 * routing[] always includes every SLACK_TOPICS entry — empty channel fields
 * for topics the user hasn't configured yet, so the UI can render the full
 * grid without per-row null checks.
 */
export async function GET() {
  const configured = !!process.env.SLACK_BOT_TOKEN;
  const auth = configured ? await testSlackToken() : { ok: false, error: "SLACK_BOT_TOKEN not set" };

  const saved = await db.select().from(slackChannelRouting);
  const byTopic = new Map(saved.map((r) => [r.topic, r]));

  const routing = SLACK_TOPICS.map((t) => {
    const r = byTopic.get(t.topic);
    return {
      topic: t.topic,
      label: t.label,
      group: t.group,
      description: t.description,
      defaultChannel: t.defaultChannel,
      channelId: r?.channelId ?? null,
      channelName: r?.channelName ?? null,
      enabled: r?.enabled ?? true,
      updatedAt: r?.updatedAt ?? null,
    };
  });

  const recentMessages = await db
    .select()
    .from(slackMessageLog)
    .orderBy(desc(slackMessageLog.sentAt))
    .limit(15);

  return NextResponse.json({
    configured,
    auth,
    routing,
    recentMessages,
  });
}

/**
 * PUT /api/v1/integrations/slack
 *
 * Body:
 *   { mappings: [
 *       { topic: "orders.wholesale", channelName: "#jaxy-orders-live", enabled: true },
 *       ...
 *     ]
 *   }
 *
 * For each mapping, resolves channelName -> channelId via Slack API and
 * upserts the row. Empty channelName clears the row.
 */
export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mappings: Array<{
    topic: string;
    channelName?: string | null;
    enabled?: boolean;
  }> | undefined = body.mappings;

  if (!Array.isArray(mappings)) {
    return NextResponse.json({ error: "mappings array required" }, { status: 400 });
  }

  const results: Array<{ topic: string; ok: boolean; error?: string; channelId?: string | null }> = [];

  for (const m of mappings) {
    const topic = m.topic;
    const enabled = m.enabled !== false;
    const channelInput = (m.channelName ?? "").trim();

    if (!channelInput) {
      // Clear mapping
      await db.delete(slackChannelRouting).where(eq(slackChannelRouting.topic, topic));
      results.push({ topic, ok: true, channelId: null });
      continue;
    }

    const channelId = await findChannelIdByName(channelInput);
    if (!channelId) {
      results.push({
        topic,
        ok: false,
        error: `Channel ${channelInput} not found. Make sure the bot is invited to the channel (or use chat:write.public scope).`,
      });
      continue;
    }

    const channelName = channelInput.startsWith("#") ? channelInput : `#${channelInput}`;
    const existing = await db.select().from(slackChannelRouting).where(eq(slackChannelRouting.topic, topic));

    if (existing.length > 0) {
      await db.update(slackChannelRouting).set({
        channelId,
        channelName,
        enabled,
        updatedAt: new Date().toISOString(),
      }).where(eq(slackChannelRouting.topic, topic));
    } else {
      await db.insert(slackChannelRouting).values({
        topic,
        channelId,
        channelName,
        enabled,
      });
    }
    results.push({ topic, ok: true, channelId });
  }

  return NextResponse.json({ ok: true, results });
}

/**
 * POST /api/v1/integrations/slack
 *
 * Actions:
 *   { action: "test", topic, channelName? }
 *     Posts a friendly test message to the topic's channel (or override).
 *
 *   { action: "applyDefaults" }
 *     Sets every topic to its defaultChannel from SLACK_TOPICS in one shot.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = body.action;

  if (action === "test") {
    const topic = body.topic;
    if (!topic) return NextResponse.json({ error: "topic required" }, { status: 400 });
    const t = SLACK_TOPICS.find((x) => x.topic === topic);
    if (!t) return NextResponse.json({ error: `Unknown topic ${topic}` }, { status: 400 });

    const result = await postSlack({
      topic,
      text: `👋 Test message from the-frame — wiring up "${t.label}" notifications. If you can read this, routing works!`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `👋 *Test message from the-frame*\nWiring up *${t.label}* notifications. If you can read this, routing works.` } },
        { type: "context", elements: [{ type: "mrkdwn", text: `Topic: \`${t.topic}\` · ${new Date().toLocaleString()}` }] },
      ],
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 400 });
  }

  if (action === "applyDefaults") {
    const results: Array<{ topic: string; ok: boolean; channelId?: string | null; error?: string }> = [];
    for (const t of SLACK_TOPICS) {
      const channelId = await findChannelIdByName(t.defaultChannel);
      if (!channelId) {
        results.push({ topic: t.topic, ok: false, error: `Channel #${t.defaultChannel} not found` });
        continue;
      }
      const channelName = `#${t.defaultChannel}`;
      const existing = await db.select().from(slackChannelRouting).where(eq(slackChannelRouting.topic, t.topic));
      if (existing.length > 0) {
        await db.update(slackChannelRouting).set({
          channelId,
          channelName,
          enabled: true,
          updatedAt: new Date().toISOString(),
        }).where(eq(slackChannelRouting.topic, t.topic));
      } else {
        await db.insert(slackChannelRouting).values({
          topic: t.topic,
          channelId,
          channelName,
          enabled: true,
        });
      }
      results.push({ topic: t.topic, ok: true, channelId });
    }
    return NextResponse.json({ ok: true, results });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
