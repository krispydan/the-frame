/**
 * Slack Web API client — minimal wrapper around chat.postMessage.
 *
 * Resolves a topic → channel routing row → channel ID, then posts the
 * message and writes to slack_message_log so the user can see what fired.
 *
 * Bot token comes from SLACK_BOT_TOKEN env var. We don't carry per-shop
 * tokens — one workspace bot for the whole app.
 *
 * Designed to never throw: if Slack rejects, the topic isn't routed, or
 * the token is missing, we log and return — the caller (an order webhook,
 * a stock-alert generator, etc.) doesn't need to wrap in try/catch.
 */

import { db } from "@/lib/db";
import { slackChannelRouting, slackMessageLog, type SlackTopic } from "@/modules/integrations/schema/slack";
import { eq } from "drizzle-orm";

export type SlackBlock = Record<string, unknown>;

export type SlackPostOptions = {
  topic: SlackTopic;
  /** Plain text fallback — required by Slack even when blocks are provided. */
  text: string;
  /** Optional Block Kit blocks for rich formatting. */
  blocks?: SlackBlock[];
  /** Override the topic's configured channel just for this message. */
  channelOverride?: string;
};

export type SlackPostResult = {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
};

const SLACK_API = "https://slack.com/api";

function getBotToken(): string | null {
  return process.env.SLACK_BOT_TOKEN || null;
}

async function getRoutedChannel(topic: SlackTopic): Promise<{ channelId: string | null; channelName: string | null; enabled: boolean }> {
  const [row] = await db.select().from(slackChannelRouting).where(eq(slackChannelRouting.topic, topic));
  if (!row) return { channelId: null, channelName: null, enabled: false };
  return {
    channelId: row.channelId,
    channelName: row.channelName,
    enabled: row.enabled,
  };
}

async function logMessage(opts: {
  topic: SlackTopic | null;
  channelId: string | null;
  channelName: string | null;
  text: string;
  ok: boolean;
  error: string | null;
}): Promise<void> {
  try {
    await db.insert(slackMessageLog).values({
      topic: opts.topic,
      channelId: opts.channelId,
      channelName: opts.channelName,
      textPreview: opts.text.slice(0, 280),
      ok: opts.ok,
      error: opts.error,
    });
  } catch (e) {
    console.error("[slack] failed to log message:", e);
  }
}

/**
 * Post a message to the channel routed for the given topic.
 * Always returns a result — never throws.
 */
export async function postSlack(opts: SlackPostOptions): Promise<SlackPostResult> {
  const token = getBotToken();
  if (!token) {
    await logMessage({ topic: opts.topic, channelId: null, channelName: null, text: opts.text, ok: false, error: "SLACK_BOT_TOKEN not set" });
    return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  }

  const route = await getRoutedChannel(opts.topic);
  const channel = opts.channelOverride || route.channelId;
  if (!channel) {
    await logMessage({ topic: opts.topic, channelId: null, channelName: route.channelName, text: opts.text, ok: false, error: "No channel routed for topic" });
    return { ok: false, error: `No Slack channel routed for topic "${opts.topic}"` };
  }
  if (!route.enabled && !opts.channelOverride) {
    await logMessage({ topic: opts.topic, channelId: route.channelId, channelName: route.channelName, text: opts.text, ok: false, error: "Topic disabled" });
    return { ok: false, error: `Topic "${opts.topic}" is disabled` };
  }

  try {
    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        text: opts.text,
        blocks: opts.blocks,
        unfurl_links: false,
      }),
    });
    const data = (await res.json()) as { ok: boolean; channel?: string; ts?: string; error?: string };
    if (!data.ok) {
      await logMessage({
        topic: opts.topic,
        channelId: channel,
        channelName: route.channelName,
        text: opts.text,
        ok: false,
        error: data.error || `HTTP ${res.status}`,
      });
      return { ok: false, error: data.error || `HTTP ${res.status}` };
    }
    await logMessage({
      topic: opts.topic,
      channelId: data.channel || channel,
      channelName: route.channelName,
      text: opts.text,
      ok: true,
      error: null,
    });
    return { ok: true, channel: data.channel, ts: data.ts };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    await logMessage({ topic: opts.topic, channelId: channel, channelName: route.channelName, text: opts.text, ok: false, error: msg });
    return { ok: false, error: msg };
  }
}

/**
 * Resolve a Slack channel name (with or without #) into its channel ID by
 * calling conversations.list. Cached locally on the routing row so we
 * don't re-fetch every time. Returns null if not found.
 */
export async function findChannelIdByName(name: string): Promise<string | null> {
  const token = getBotToken();
  if (!token) return null;
  const cleaned = name.replace(/^#/, "").trim().toLowerCase();
  if (!cleaned) return null;

  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages++) {
    const qs = new URLSearchParams({
      limit: "200",
      types: "public_channel,private_channel",
    });
    if (cursor) qs.set("cursor", cursor);

    const res = await fetch(`${SLACK_API}/conversations.list?${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as {
      ok: boolean;
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
      error?: string;
    };
    if (!data.ok) return null;
    const match = data.channels?.find((c) => c.name === cleaned);
    if (match) return match.id;
    cursor = data.response_metadata?.next_cursor;
    if (!cursor) return null;
  }
  return null;
}

/**
 * Test that the bot token works by calling auth.test.
 * Returns the bot's user_id + team if it succeeds.
 */
export async function testSlackToken(): Promise<{ ok: boolean; team?: string; user?: string; error?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, error: "SLACK_BOT_TOKEN not set" };
  try {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; team?: string; user?: string; error?: string };
    return data;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
