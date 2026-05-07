/**
 * Register Shopify webhook subscriptions on both retail (dtc) and wholesale
 * stores. Idempotent — skips topics already registered at the correct URL,
 * replaces ones pointing at a stale domain.
 *
 * Usage:
 *   npx tsx scripts/setup-shopify-webhooks.ts           # dry run (check only)
 *   npx tsx scripts/setup-shopify-webhooks.ts --apply   # actually register
 *   npx tsx scripts/setup-shopify-webhooks.ts --store retail   # one store only
 *   npx tsx scripts/setup-shopify-webhooks.ts --store wholesale
 */
import {
  listWebhooksOnAllStores,
  registerWebhooksOnAllStores,
  registerWebhooksForChannel,
  getWebhookUrl,
  DESIRED_TOPICS,
} from "@/modules/integrations/lib/shopify/webhook-registration";
import { sqlite } from "@/lib/db";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const storeIdx = args.indexOf("--store");
  const storeFilter = storeIdx !== -1 ? args[storeIdx + 1] : null;

  const webhookUrl = getWebhookUrl();
  console.log(`Webhook URL: ${webhookUrl}`);
  console.log(`Mode:        ${apply ? "LIVE (register subscriptions)" : "DRY RUN (check only)"}`);
  if (storeFilter) console.log(`Store:       ${storeFilter}`);
  console.log();

  if (!apply) {
    // Dry run — just show current state
    const stores = await listWebhooksOnAllStores();
    for (const s of stores) {
      if (storeFilter && s.store !== storeFilter) continue;
      console.log(`── ${s.store} (${s.shopDomain || "not connected"}) ──`);
      if (s.error) {
        console.log(`   ✗ Error: ${s.error}`);
        continue;
      }
      const existingTopics = new Set(
        s.subscriptions
          .filter((sub) => sub.callbackUrl === webhookUrl)
          .map((sub) => sub.topic),
      );
      for (const topic of DESIRED_TOPICS) {
        const registered = existingTopics.has(topic);
        const stale = !registered && s.subscriptions.some((sub) => sub.topic === topic);
        const status = registered ? "✓ registered" : stale ? "⚠ stale URL" : "✗ missing";
        console.log(`   ${status.padEnd(16)} ${topic}`);
      }
      console.log();
    }
    console.log("Run with --apply to register missing subscriptions.");
  } else {
    // Live — register
    const channels = storeFilter
      ? [storeFilter as "retail" | "wholesale"]
      : (["retail", "wholesale"] as const);

    let totalCreated = 0, totalReplaced = 0, totalFailed = 0;

    for (const channel of channels) {
      console.log(`── Registering on ${channel} ──`);
      try {
        const r = storeFilter
          ? await registerWebhooksForChannel(channel, webhookUrl)
          : (await registerWebhooksOnAllStores(webhookUrl)).find((x) => x.store === channel)!;

        if (r.error) {
          console.log(`   ✗ Store error: ${r.error}`);
          continue;
        }
        console.log(`   Shop: ${r.shopDomain}`);
        for (const t of r.topics) {
          const icon = t.status === "created" ? "✓ created"
            : t.status === "replaced" ? "↺ replaced"
            : t.status === "already_registered" ? "· ok"
            : `✗ FAILED: ${t.message}`;
          console.log(`   ${icon.padEnd(24)} ${t.topic}`);
          if (t.status === "created") totalCreated++;
          if (t.status === "replaced") totalReplaced++;
          if (t.status === "failed") totalFailed++;
        }
      } catch (e) {
        console.log(`   ✗ ${e instanceof Error ? e.message : e}`);
      }
      console.log();
    }

    console.log(`Created: ${totalCreated}  Replaced: ${totalReplaced}  Failed: ${totalFailed}`);
  }

  sqlite.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
