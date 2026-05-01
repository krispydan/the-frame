/**
 * Look for Simprosys / Google Shopping metafield definitions on retail.
 * Run: npx tsx scripts/inspect-simprosys.ts
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const Q = `
  query {
    metafieldDefinitions(ownerType: PRODUCT, first: 200) {
      edges {
        node {
          id name namespace key description
          type { name category }
          validations { name value }
        }
      }
    }
  }
`;

interface Resp {
  metafieldDefinitions: {
    edges: Array<{
      node: {
        id: string; name: string; namespace: string; key: string;
        description: string | null;
        type: { name: string; category: string };
        validations: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

async function main() {
  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`  ${store.toUpperCase()}`);
    console.log(`══════════════════════════════════════════════`);
    const res = await shopifyGraphqlRequest<Resp>(store, Q);
    const all = res.metafieldDefinitions.edges.map((e) => e.node);

    // Group by namespace
    const byNs = new Map<string, typeof all>();
    for (const d of all) {
      if (!byNs.has(d.namespace)) byNs.set(d.namespace, []);
      byNs.get(d.namespace)!.push(d);
    }

    // Highlight likely Simprosys / Google namespaces first
    const interesting = ["mm-google-shopping", "simprosys", "google", "google_shopping"];
    for (const ns of [...byNs.keys()].sort((a, b) => {
      const aIdx = interesting.findIndex((p) => a.toLowerCase().includes(p));
      const bIdx = interesting.findIndex((p) => b.toLowerCase().includes(p));
      if (aIdx !== -1 && bIdx === -1) return -1;
      if (bIdx !== -1 && aIdx === -1) return 1;
      return a.localeCompare(b);
    })) {
      const defs = byNs.get(ns)!;
      const flag = interesting.some((p) => ns.toLowerCase().includes(p)) ? " ★" : "";
      console.log(`\n  ${ns}${flag}  (${defs.length})`);
      for (const d of defs) {
        console.log(`    ${d.namespace}.${d.key}  [${d.type.name}]  ${d.name}`);
        if (d.description) console.log(`      ${d.description}`);
      }
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
