import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const Q = `
  query($id: ID!) {
    metaobject(id: $id) {
      id type handle displayName
      fields { key value }
    }
  }
`;

interface Resp { metaobject: { id: string; type: string; handle: string; displayName: string | null; fields: Array<{ key: string; value: string | null }> } | null }

async function main() {
  const gid = "gid://shopify/Metaobject/217897205909";
  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n── ${store} ──`);
    try {
      const r = await shopifyGraphqlRequest<Resp>(store, Q, { id: gid });
      console.log(JSON.stringify(r.metaobject, null, 2));
    } catch (e) {
      console.log("ERROR:", e instanceof Error ? e.message : e);
    }
  }
  process.exit(0);
}
main().catch(console.error);
