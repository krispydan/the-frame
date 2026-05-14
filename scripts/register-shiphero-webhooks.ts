/**
 * Idempotently register the ShipHero webhook subscriptions we want
 * (Order Allocated, Shipment Update) against the running deploy.
 *
 * Usage:
 *   # Production
 *   SHOPIFY_APP_URL=https://theframe.getjaxy.com \
 *   SHIPHERO_ACCESS_TOKEN=... \
 *     npx tsx scripts/register-shiphero-webhooks.ts
 *
 *   # Local (point ShipHero at a tunnel or staging URL — they need
 *   # to be able to POST to it)
 *   SHOPIFY_APP_URL=https://your-tunnel.ngrok.app \
 *   SHIPHERO_ACCESS_TOKEN=... \
 *     npx tsx scripts/register-shiphero-webhooks.ts
 *
 * Safe to re-run: existing subscriptions with the correct URL are left
 * untouched (shared_secret preserved); URL drift is fixed in place;
 * missing topics are created and their secrets persisted to
 * shiphero_webhook_subscriptions.
 */
import { registerShipHeroWebhooks } from "@/modules/operations/lib/shiphero/register-webhooks";

async function main() {
  const baseUrl =
    process.env.SHOPIFY_APP_URL ||
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl) {
    console.error(
      "Set SHOPIFY_APP_URL (or APP_BASE_URL) to the public base URL of the-frame deploy.",
    );
    process.exit(1);
  }
  if (!process.env.SHIPHERO_ACCESS_TOKEN) {
    console.error("SHIPHERO_ACCESS_TOKEN env var is required.");
    process.exit(1);
  }

  console.log(`Reconciling ShipHero webhooks against ${baseUrl} ...`);
  const results = await registerShipHeroWebhooks({ baseUrl });

  let hasError = false;
  for (const r of results) {
    if (r.action === "error") {
      hasError = true;
      console.error(`  ✗ ${r.topic}: ${r.error}`);
    } else {
      console.log(`  ✓ ${r.topic}: ${r.action} → ${r.url}`);
    }
  }
  process.exit(hasError ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
