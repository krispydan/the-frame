/**
 * Inspect the custom frame_shape metaobject definition + entries on each store.
 * Run: npx tsx scripts/dump-frame-shape-metaobject.ts
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const DEFS_Q = `
  query {
    metaobjectDefinitions(first: 50) {
      edges { node { id type name displayNameKey } }
    }
  }
`;

const ENTRIES_Q = `
  query($type: String!) {
    metaobjects(type: $type, first: 100) {
      edges { node { id handle displayName } }
    }
  }
`;

// Also pull the product-level metafield definitions in `custom` namespace
// so we can see how the frame_shape metafield is wired (text vs reference).
const MF_DEFS_Q = `
  query {
    metafieldDefinitions(ownerType: PRODUCT, first: 100, namespace: "custom") {
      edges {
        node {
          id name namespace key
          type { name category }
          validations { name value }
        }
      }
    }
  }
`;

interface DefsResp { metaobjectDefinitions: { edges: Array<{ node: { id: string; type: string; name: string; displayNameKey: string | null } }> } }
interface EntriesResp { metaobjects: { edges: Array<{ node: { id: string; handle: string; displayName: string | null } }> } }
interface MfDefsResp { metafieldDefinitions: { edges: Array<{ node: { id: string; name: string; namespace: string; key: string; type: { name: string }; validations: Array<{ name: string; value: string }> } }> } }

async function main() {
  for (const store of ["dtc", "wholesale"] as const) {
    console.log(`\n========== ${store.toUpperCase()} ==========`);

    // Find any frame_shape-ish metaobject definitions
    const defs = await shopifyGraphqlRequest<DefsResp>(store, DEFS_Q);
    const candidates = defs.metaobjectDefinitions.edges
      .map((e) => e.node)
      .filter((n) => /frame.?shape|shape/i.test(n.type) || /frame.?shape|shape/i.test(n.name));
    console.log(`\nMetaobject definitions matching "frame_shape" / "shape":`);
    for (const c of candidates) {
      console.log(`  type="${c.type}"  name="${c.name}"  id=${c.id}`);
    }

    for (const c of candidates) {
      try {
        const entries = await shopifyGraphqlRequest<EntriesResp>(store, ENTRIES_Q, { type: c.type });
        console.log(`\n  Entries for type="${c.type}" (${entries.metaobjects.edges.length}):`);
        for (const e of entries.metaobjects.edges) {
          console.log(`    handle="${e.node.handle}"  display="${e.node.displayName}"  gid=${e.node.id}`);
        }
      } catch (e) {
        console.log(`    ERROR: ${e instanceof Error ? e.message : e}`);
      }
    }

    // custom.* metafield definitions on PRODUCT
    const mfd = await shopifyGraphqlRequest<MfDefsResp>(store, MF_DEFS_Q);
    console.log(`\n  Product metafield definitions in 'custom' namespace:`);
    for (const e of mfd.metafieldDefinitions.edges) {
      const n = e.node;
      const validations = n.validations.map((v) => `${v.name}=${v.value}`).join(" | ");
      console.log(`    ${n.namespace}.${n.key}  [${n.type.name}]  ${n.name}${validations ? "  -- " + validations : ""}`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
