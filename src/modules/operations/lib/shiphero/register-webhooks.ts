/**
 * Idempotent ShipHero webhook registration.
 *
 * Reconciles the set of topics we want subscribed to with what ShipHero
 * actually has registered, then persists the shared_secret returned by
 * webhook_create into shiphero_webhook_subscriptions so the receiver can
 * HMAC-verify incoming events.
 *
 * Called by:
 *   - The /api/v1/integrations/shiphero/register-webhooks route (admin UI
 *     button on the integrations settings page).
 *   - The scripts/register-shiphero-webhooks.ts CLI for one-time / local
 *     bootstrap.
 *
 * See: docs/shiphero-webhooks-and-faire-slips.md
 */

import { sqlite } from "@/lib/db";
import { webhookCreate, webhookList, webhookUpdateUrl } from "./api-client";

/** Topics we want subscribed to in ShipHero. */
export const DESIRED_TOPICS = ["Order Allocated", "Shipment Update"] as const;
export type DesiredTopic = (typeof DESIRED_TOPICS)[number];

export interface RegisterResult {
  topic: DesiredTopic;
  action: "created" | "updated_url" | "already_correct" | "error";
  url: string;
  error?: string;
}

function getReceiverUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/api/v1/webhooks/shiphero`;
}

function upsertSubscription(opts: {
  id: string;
  topic: string;
  url: string;
  sharedSecret: string | null;
}) {
  sqlite
    .prepare(
      `INSERT INTO shiphero_webhook_subscriptions
       (id, topic, url, shared_secret, created_at, deactivated_at)
       VALUES (?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(id) DO UPDATE SET
         topic = excluded.topic,
         url = excluded.url,
         shared_secret = COALESCE(excluded.shared_secret, shiphero_webhook_subscriptions.shared_secret),
         deactivated_at = NULL`,
    )
    .run(opts.id, opts.topic, opts.url, opts.sharedSecret);
}

/**
 * Reconcile ShipHero webhook subscriptions with DESIRED_TOPICS.
 *
 * For each desired topic:
 *   - If a subscription already exists with the correct URL: no-op.
 *   - If it exists with a different URL: update URL (preserves secret).
 *   - Otherwise: create + persist the returned shared_secret.
 *
 * Returns one row per topic describing what happened. Never throws — errors
 * are captured per-topic so partial success is observable.
 */
export async function registerShipHeroWebhooks(opts: {
  baseUrl: string;
}): Promise<RegisterResult[]> {
  const targetUrl = getReceiverUrl(opts.baseUrl);
  const results: RegisterResult[] = [];

  let existing: Awaited<ReturnType<typeof webhookList>>;
  try {
    existing = await webhookList();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Fail every topic with the same root cause — saves the UI a separate
    // "list failed" branch.
    return DESIRED_TOPICS.map((topic) => ({
      topic,
      action: "error" as const,
      url: targetUrl,
      error: `webhookList failed: ${msg}`,
    }));
  }

  for (const topic of DESIRED_TOPICS) {
    const current = existing.find((w) => w.name === topic);
    try {
      if (current && current.url === targetUrl) {
        // Already correct. Persist the row in case we lost local state.
        upsertSubscription({
          id: current.id,
          topic,
          url: targetUrl,
          sharedSecret: current.shared_signature_secret ?? null,
        });
        results.push({ topic, action: "already_correct", url: targetUrl });
        continue;
      }

      if (current && current.url !== targetUrl) {
        await webhookUpdateUrl({ name: topic, url: targetUrl });
        upsertSubscription({
          id: current.id,
          topic,
          url: targetUrl,
          sharedSecret: current.shared_signature_secret ?? null,
        });
        results.push({ topic, action: "updated_url", url: targetUrl });
        continue;
      }

      const created = await webhookCreate({ name: topic, url: targetUrl });
      upsertSubscription({
        id: created.id,
        topic,
        url: targetUrl,
        sharedSecret: created.sharedSecret,
      });
      results.push({ topic, action: "created", url: targetUrl });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ topic, action: "error", url: targetUrl, error: msg });
    }
  }

  return results;
}
