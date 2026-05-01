/**
 * Dump metaobject entries for the taxonomy types we care about, on both stores.
 * Run with: npx tsx scripts/dump-metaobjects.ts
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const TYPES = [
  "shopify--lens-polarization",
  "shopify--target-gender",
  "shopify--eyewear-frame-design",
  "shopify--color-pattern",
] as const;

const Q = `
  query($type: String!) {
    metaobjects(type: $type, first: 100) {
      edges { node { handle displayName } }
    }
  }
`;

interface Resp {
  metaobjects: { edges: Array<{ node: { handle: string; displayName: string | null } }> };
}

async function main() {
  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n========== ${store.toUpperCase()} ==========`);
    for (const type of TYPES) {
      try {
        const res = await shopifyGraphqlRequest<Resp>(store, Q, { type });
        const handles = res.metaobjects.edges.map((e) => e.node.handle).sort();
        console.log(`\n[${type}]  (${handles.length})`);
        console.log("  " + handles.join(", "));
      } catch (e) {
        console.log(`[${type}]  ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
