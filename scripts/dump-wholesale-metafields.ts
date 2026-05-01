/**
 * One-shot: dump product metafield definitions for the wholesale Shopify store.
 * Run with: bun scripts/dump-wholesale-metafields.ts
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const QUERY = `
  query GetProductMetafieldDefinitions {
    metafieldDefinitions(ownerType: PRODUCT, first: 50) {
      edges {
        node {
          id
          name
          namespace
          key
          description
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
        id: string;
        name: string;
        namespace: string;
        key: string;
        description: string | null;
        type: { name: string; category: string };
        validations: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

async function main() {
  const res = await shopifyGraphqlRequest<Resp>("wholesale", QUERY);
  const rows = res.metafieldDefinitions.edges.map((e) => e.node);
  console.log(`Found ${rows.length} product metafield definitions on wholesale store:\n`);
  for (const r of rows) {
    console.log(`• ${r.namespace}.${r.key}  [${r.type.name}]  ${r.name}`);
    if (r.description) console.log(`    ${r.description}`);
    for (const v of r.validations) {
      console.log(`    validation ${v.name}: ${v.value}`);
    }
  }
  console.log("\nRaw JSON:\n" + JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
