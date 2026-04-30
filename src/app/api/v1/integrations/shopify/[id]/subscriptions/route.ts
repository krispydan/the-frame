export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { shopifyShops } from "@/modules/integrations/schema/shopify";
import { eq } from "drizzle-orm";
import { getShopifyClient, ShopifyAuthError } from "@/modules/integrations/lib/shopify/admin-api";

/**
 * GET /api/v1/integrations/shopify/{id}/subscriptions
 *
 * Hits the live Shopify Admin GraphQL API to enumerate the webhook
 * subscriptions that actually exist on this store. Useful for confirming
 * that `shopify app deploy` pushed the toml subscriptions through.
 *
 * Subscriptions returned by Shopify include both:
 *   - App-managed subscriptions (declared in shopify.app.toml)
 *   - Per-store subscriptions created via API
 *
 * Response shape:
 *   {
 *     subscriptions: [
 *       { id, topic, callbackUrl, format, createdAt, updatedAt }, ...
 *     ]
 *   }
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [shop] = await db.select().from(shopifyShops).where(eq(shopifyShops.id, id));
  if (!shop) return NextResponse.json({ error: "Shop not found" }, { status: 404 });

  try {
    const client = await getShopifyClient(shop.shopDomain);
    type Resp = {
      webhookSubscriptions: {
        edges: Array<{
          node: {
            id: string;
            topic: string;
            createdAt: string;
            updatedAt: string;
            format: string;
            endpoint: { __typename: string; callbackUrl?: string };
          }
        }>
      }
    };
    const data = await client.graphql<Resp>(`
      query Subscriptions {
        webhookSubscriptions(first: 100) {
          edges {
            node {
              id
              topic
              createdAt
              updatedAt
              format
              endpoint {
                __typename
                ... on WebhookHttpEndpoint { callbackUrl }
              }
            }
          }
        }
      }
    `);

    const subs = (data.webhookSubscriptions?.edges || []).map((e) => ({
      id: e.node.id,
      topic: e.node.topic,
      callbackUrl: e.node.endpoint?.callbackUrl ?? null,
      format: e.node.format,
      createdAt: e.node.createdAt,
      updatedAt: e.node.updatedAt,
    }));

    return NextResponse.json({ shopDomain: shop.shopDomain, subscriptions: subs });
  } catch (err) {
    if (err instanceof ShopifyAuthError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    console.error("[shopify subscriptions] error:", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 });
  }
}
