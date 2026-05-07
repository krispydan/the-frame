export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import {
  registerWebhooksOnAllStores,
  listWebhooksOnAllStores,
  getWebhookUrl,
  DESIRED_TOPICS,
} from "@/modules/integrations/lib/shopify/webhook-registration";

/**
 * GET /api/v1/integrations/shopify/setup-webhooks
 *
 * Returns the current webhook subscriptions on both stores and highlights
 * which DESIRED_TOPICS are missing or pointing at the wrong URL.
 */
export async function GET(_req: NextRequest) {
  try {
    const webhookUrl = getWebhookUrl();
    const stores = await listWebhooksOnAllStores();

    const report = stores.map((s) => {
      const existing = new Map(s.subscriptions.map((sub) => [sub.topic, sub]));
      const topics = DESIRED_TOPICS.map((topic) => {
        const sub = existing.get(topic);
        const registered = !!sub && sub.callbackUrl === webhookUrl;
        return {
          topic,
          registered,
          stale: !!sub && sub.callbackUrl !== webhookUrl,
          callbackUrl: sub?.callbackUrl ?? null,
        };
      });
      return {
        store: s.store,
        shopDomain: s.shopDomain,
        webhookUrl,
        error: s.error,
        summary: {
          registered: topics.filter((t) => t.registered).length,
          missing: topics.filter((t) => !t.registered && !t.stale).length,
          stale: topics.filter((t) => t.stale).length,
          total: DESIRED_TOPICS.length,
        },
        topics,
      };
    });

    return NextResponse.json({ webhookUrl, stores: report });
  } catch (err) {
    console.error("[setup-webhooks GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/integrations/shopify/setup-webhooks
 *
 * Registers all DESIRED_TOPICS on both retail and wholesale Shopify stores.
 * Idempotent — topics already registered at the correct URL are skipped.
 * Stale subscriptions (wrong URL) are deleted and re-created.
 *
 * Body (optional): { store: "retail" | "wholesale" }  — limit to one store
 */
export async function POST(_req: NextRequest) {
  try {
    const webhookUrl = getWebhookUrl();
    const results = await registerWebhooksOnAllStores(webhookUrl);

    const summary = results.map((r) => ({
      store: r.store,
      shopDomain: r.shopDomain,
      webhookUrl: r.webhookUrl,
      error: r.error ?? null,
      created: r.topics.filter((t) => t.status === "created").length,
      replaced: r.topics.filter((t) => t.status === "replaced").length,
      alreadyRegistered: r.topics.filter((t) => t.status === "already_registered").length,
      failed: r.topics.filter((t) => t.status === "failed").length,
      topics: r.topics,
    }));

    const anyFailed = results.some(
      (r) => r.error || r.topics.some((t) => t.status === "failed"),
    );

    return NextResponse.json({ ok: !anyFailed, webhookUrl, stores: summary }, {
      status: anyFailed ? 207 : 200,
    });
  } catch (err) {
    console.error("[setup-webhooks POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
