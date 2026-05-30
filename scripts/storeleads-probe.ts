#!/usr/bin/env tsx
/**
 * StoreLeads.app API probe — smoke-test the client against the real API.
 *
 * Usage:
 *   STORELEADS_API_KEY=… npx tsx scripts/storeleads-probe.ts shopdressup.com
 *
 *   npx tsx scripts/storeleads-probe.ts shopdressup.com modcloth.com   # bulk
 *   npx tsx scripts/storeleads-probe.ts --search f:cc=US f:cat=/Apparel/
 *   npx tsx scripts/storeleads-probe.ts --test                          # ping
 *
 * Prints the full JSON of each response so we can eyeball whatever
 * StoreLeads sends (fields beyond what the typed client surfaces are
 * accepted via the [key: string]: unknown escape hatch).
 */
import {
  getStoreByDomain,
  bulkGetStoresByDomain,
  searchDomains,
  testConnection,
  isConfigured,
} from "@/modules/sales/lib/storeleads/client";

async function main() {
  if (!isConfigured()) {
    console.error("STORELEADS_API_KEY env var is required.");
    process.exit(1);
  }
  const args = process.argv.slice(2);

  if (args[0] === "--test") {
    const r = await testConnection();
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  if (args[0] === "--search") {
    const filters: Record<string, string> = {};
    for (const a of args.slice(1)) {
      const [k, ...v] = a.split("=");
      filters[k] = v.join("=");
    }
    const r = await searchDomains({ filters, pageSize: 10 });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (args.length === 0) {
    console.error("Pass one or more domains, or --search f:k=v ..., or --test.");
    process.exit(1);
  }

  if (args.length === 1) {
    const r = await getStoreByDomain(args[0], { followRedirects: true });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // Multiple → bulk
  const r = await bulkGetStoresByDomain(args, { followRedirects: true });
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
