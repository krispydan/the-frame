/**
 * Shopify webhook subscription management.
 *
 * Uses the Admin GraphQL API to register/inspect HTTP webhook subscriptions
 * on any connected store. Both retail (dtc) and wholesale use the same
 * endpoint and HMAC secret (shared Shopify app), so the same list of
 * topics is registered on both.
 *
 * Registration is idempotent — existing subscriptions pointing at the
 * correct URL are skipped, ones pointing elsewhere (stale domains) are
 * replaced.
 */

import { getShopifyClientByChannel } from "./admin-api";

// ── Desired topics ────────────────────────────────────────────────────────────
// GraphQL enum values used for registration; Shopify sends them as lowercase
// "orders/create" style in the X-Shopify-Topic header.
export const DESIRED_TOPICS = [
  // Orders
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
  // Fulfillments
  "FULFILLMENTS_CREATE",
  "FULFILLMENTS_UPDATE",
  // Refunds
  "REFUNDS_CREATE",
  // Inventory
  "INVENTORY_LEVELS_UPDATE",
  // Customers
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  // Products
  "PRODUCTS_UPDATE",
] as const;

export type WebhookTopic = (typeof DESIRED_TOPICS)[number];

export interface ExistingSubscription {
  id: string;
  topic: string;
  callbackUrl: string | null;
}

export interface TopicResult {
  topic: WebhookTopic;
  status: "created" | "already_registered" | "replaced" | "failed";
  message?: string;
  subscriptionId?: string;
}

export interface StoreRegistrationResult {
  store: string;   // channel: "retail" | "wholesale"
  shopDomain: string;
  webhookUrl: string;
  topics: TopicResult[];
  error?: string;
}

// ── GraphQL fragments ─────────────────────────────────────────────────────────

const LIST_Q = `
  query ListWebhooks {
    webhookSubscriptions(first: 100) {
      edges {
        node {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
    }
  }
`;

const CREATE_M = `
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $url, format: JSON }
    ) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }
`;

const DELETE_M = `
  mutation DeleteWebhook($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

// ── Core registration ─────────────────────────────────────────────────────────

/**
 * Ensure all DESIRED_TOPICS are registered on the given channel's store.
 * Idempotent — skips topics already pointing at the correct URL.
 */
export async function registerWebhooksForChannel(
  channel: "retail" | "wholesale",
  webhookUrl: string,
): Promise<StoreRegistrationResult> {
  const client = await getShopifyClientByChannel(channel);

  // Fetch existing subscriptions
  type ListResp = {
    webhookSubscriptions: {
      edges: Array<{
        node: {
          id: string;
          topic: string;
          endpoint: { __typename: string; callbackUrl?: string };
        };
      }>;
    };
  };
  const listData = await client.graphql<ListResp>(LIST_Q);
  const existing: ExistingSubscription[] = (listData.webhookSubscriptions?.edges ?? []).map(
    (e) => ({
      id: e.node.id,
      topic: e.node.topic,
      callbackUrl: e.node.endpoint?.callbackUrl ?? null,
    }),
  );

  const byTopic = new Map(existing.map((s) => [s.topic, s]));
  const results: TopicResult[] = [];

  for (const topic of DESIRED_TOPICS) {
    const current = byTopic.get(topic);

    if (current?.callbackUrl === webhookUrl) {
      // Already correct — nothing to do
      results.push({ topic, status: "already_registered", subscriptionId: current.id });
      continue;
    }

    // Delete stale subscription if it exists at wrong URL
    if (current) {
      try {
        type DelResp = {
          webhookSubscriptionDelete: {
            deletedWebhookSubscriptionId: string | null;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };
        await client.graphql<DelResp>(DELETE_M, { id: current.id });
      } catch {
        // Non-fatal — try to create anyway
      }
    }

    // Create
    try {
      type CreateResp = {
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string; topic: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };
      const res = await client.graphql<CreateResp>(CREATE_M, { topic, url: webhookUrl });
      const errs = res.webhookSubscriptionCreate?.userErrors ?? [];
      if (errs.length > 0) {
        results.push({
          topic,
          status: "failed",
          message: errs.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`).join("; "),
        });
      } else {
        const sub = res.webhookSubscriptionCreate?.webhookSubscription;
        results.push({
          topic,
          status: current ? "replaced" : "created",
          subscriptionId: sub?.id,
        });
      }
    } catch (e) {
      results.push({
        topic,
        status: "failed",
        message: e instanceof Error ? e.message : "unknown error",
      });
    }
  }

  return {
    store: channel,
    shopDomain: client.shopDomain,
    webhookUrl,
    topics: results,
  };
}

/**
 * Register webhooks on both retail and wholesale stores.
 */
export async function registerWebhooksOnAllStores(
  webhookUrl: string,
): Promise<StoreRegistrationResult[]> {
  const results: StoreRegistrationResult[] = [];
  for (const channel of ["retail", "wholesale"] as const) {
    try {
      const r = await registerWebhooksForChannel(channel, webhookUrl);
      results.push(r);
    } catch (e) {
      results.push({
        store: channel,
        shopDomain: "",
        webhookUrl,
        topics: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return results;
}

/**
 * List current webhook subscriptions on both stores without modifying anything.
 */
export async function listWebhooksOnAllStores(): Promise<
  Array<{ store: string; shopDomain: string; subscriptions: ExistingSubscription[]; error?: string }>
> {
  type ListResp = {
    webhookSubscriptions: {
      edges: Array<{
        node: {
          id: string;
          topic: string;
          endpoint: { __typename: string; callbackUrl?: string };
        };
      }>;
    };
  };

  const out = [];
  for (const channel of ["retail", "wholesale"] as const) {
    try {
      const client = await getShopifyClientByChannel(channel);
      const data = await client.graphql<ListResp>(LIST_Q);
      out.push({
        store: channel,
        shopDomain: client.shopDomain,
        subscriptions: (data.webhookSubscriptions?.edges ?? []).map((e) => ({
          id: e.node.id,
          topic: e.node.topic,
          callbackUrl: e.node.endpoint?.callbackUrl ?? null,
        })),
      });
    } catch (e) {
      out.push({
        store: channel,
        shopDomain: "",
        subscriptions: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

/** Compute the webhook callback URL from env. */
export function getWebhookUrl(): string {
  const base = (process.env.SHOPIFY_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000")
    .replace(/\/$/, "");
  return `${base}/api/v1/webhooks/shopify`;
}
