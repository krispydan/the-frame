import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const Q = `
  query {
    metaobjects(type: "shopify--lens-polarization", first: 50) {
      edges { node {
        id handle displayName
        fields { key value }
      } }
    }
  }
`;

interface Resp { metaobjects: { edges: Array<{ node: { id: string; handle: string; displayName: string | null; fields: Array<{ key: string; value: string | null }> } }> } }

async function main() {
  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n── ${store} ──`);
    const r = await shopifyGraphqlRequest<Resp>(store, Q);
    for (const e of r.metaobjects.edges) {
      const numericId = e.node.id.replace("gid://shopify/Metaobject/", "");
      console.log(`  handle=${e.node.handle}  display="${e.node.displayName}"`);
      console.log(`    GID:  ${e.node.id}`);
      console.log(`    URL:  https://admin.shopify.com/store/${store === "dtc" ? "getjaxy" : "jaxy-wholesale"}/content/metaobjects/entries/shopify--lens-polarization/${numericId}`);
      for (const f of e.node.fields) console.log(`    field ${f.key} = ${f.value}`);
    }
  }
  process.exit(0);
}
main().catch(console.error);
