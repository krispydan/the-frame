export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import {
  registerWebhooks,
  listWebhooks,
  hasShopifyCredentials,
  type ShopifyStore,
} from "@/modules/orders/lib/shopify-api";

// GET /api/v1/orders/shopify-webhooks — list registered webhooks
export async function GET(req: NextRequest) {
  const store = (req.nextUrl.searchParams.get("store") || "dtc") as ShopifyStore;

  if (!(await hasShopifyCredentials(store))) {
    return NextResponse.json(
      { error: `Shopify ${store} credentials not configured` },
      { status: 400 },
    );
  }

  try {
    const webhooks = await listWebhooks(store);
    return NextResponse.json({ store, webhooks });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// POST /api/v1/orders/shopify-webhooks — register webhooks with Shopify
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const store = (body.store || "dtc") as ShopifyStore;
  const callbackUrl =
    body.callbackUrl ||
    `${req.nextUrl.origin}/api/v1/webhooks/shopify`;

  if (!(await hasShopifyCredentials(store))) {
    return NextResponse.json(
      { error: `Shopify ${store} credentials not configured` },
      { status: 400 },
    );
  }

  try {
    const results = await registerWebhooks(store, callbackUrl);
    const allOk = results.every((r) => r.ok);
    return NextResponse.json({
      ok: allOk,
      store,
      callbackUrl,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
