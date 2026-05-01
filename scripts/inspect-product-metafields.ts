/**
 * Read every product metafield (custom.* and shopify.*) we care about back
 * from Shopify on both stores, with display values resolved from referenced
 * metaobjects so we can see what the storefront would show.
 *
 * Run: npx tsx scripts/inspect-product-metafields.ts JX1001
 */
import { findShopifyProductBySku, shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const KEYS: Array<{ namespace: string; key: string }> = [
  { namespace: "shopify", key: "lens-polarization" },
  { namespace: "shopify", key: "eyewear-frame-design" },
  { namespace: "shopify", key: "target-gender" },
  { namespace: "shopify", key: "color-pattern" },
  { namespace: "custom", key: "frame_shape" },
];

const Q = `
  query($id: ID!) {
    product(id: $id) {
      id title
      mf_lens:    metafield(namespace: "shopify", key: "lens-polarization")    { type value updatedAt references(first: 25) { edges { node { ... on Metaobject { handle displayName } } } } }
      mf_design:  metafield(namespace: "shopify", key: "eyewear-frame-design") { type value updatedAt references(first: 25) { edges { node { ... on Metaobject { handle displayName } } } } }
      mf_gender:  metafield(namespace: "shopify", key: "target-gender")        { type value updatedAt references(first: 25) { edges { node { ... on Metaobject { handle displayName } } } } }
      mf_color:   metafield(namespace: "shopify", key: "color-pattern")        { type value updatedAt references(first: 25) { edges { node { ... on Metaobject { handle displayName } } } } }
      mf_custom_shape: metafield(namespace: "custom", key: "frame_shape")  { type value updatedAt }
      mf_custom_lens:  metafield(namespace: "custom", key: "lens_type")    { type value updatedAt }
    }
  }
`;

type MfRef = { type: string; value: string; updatedAt: string; references: { edges: Array<{ node: { handle?: string; displayName?: string | null } }> } | null } | null;
type MfText = { type: string; value: string; updatedAt: string } | null;
interface Resp {
  product: {
    id: string;
    title: string;
    mf_lens: MfRef;
    mf_design: MfRef;
    mf_gender: MfRef;
    mf_color: MfRef;
    mf_custom_shape: MfText;
    mf_custom_lens: MfText;
  } | null;
}

async function inspectStore(store: "dtc" | "wholesale", skuPrefix: string) {
  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  ${store.toUpperCase()}  ${skuPrefix}`);
  console.log(`══════════════════════════════════════════════`);

  const sp = await findShopifyProductBySku(store, skuPrefix);
  if (!sp) {
    console.log(`  No Shopify product found.`);
    return;
  }
  const productGid = `gid://shopify/Product/${sp.id}`;
  console.log(`  Shopify product: ${productGid}`);

  const res = await shopifyGraphqlRequest<Resp>(store, Q, { id: productGid });
  if (!res.product) {
    console.log(`  product query returned null`);
    return;
  }
  console.log(`  Title: ${res.product.title}`);
  console.log();

  const refDisplay = (mf: MfRef) => {
    if (!mf) return "(not set)";
    if (!mf.references || mf.references.edges.length === 0) return `[empty refs]  raw=${mf.value}`;
    return mf.references.edges.map((e) => `${e.node.displayName ?? "?"} [${e.node.handle}]`).join(", ");
  };
  const textDisplay = (mf: MfText) => {
    if (!mf) return "(not set)";
    try {
      const p = JSON.parse(mf.value);
      return Array.isArray(p) ? p.join(", ") : String(p);
    } catch {
      return mf.value;
    }
  };
  const dt = (s: string | undefined) => (s ? new Date(s).toISOString().replace("T", " ").slice(0, 19) : "");

  const rows: Array<[string, string, string]> = [
    ["shopify.lens-polarization", refDisplay(res.product.mf_lens), dt(res.product.mf_lens?.updatedAt)],
    ["shopify.eyewear-frame-design", refDisplay(res.product.mf_design), dt(res.product.mf_design?.updatedAt)],
    ["shopify.target-gender", refDisplay(res.product.mf_gender), dt(res.product.mf_gender?.updatedAt)],
    ["shopify.color-pattern", refDisplay(res.product.mf_color), dt(res.product.mf_color?.updatedAt)],
    ["custom.frame_shape", textDisplay(res.product.mf_custom_shape), dt(res.product.mf_custom_shape?.updatedAt)],
    ["custom.lens_type", textDisplay(res.product.mf_custom_lens), dt(res.product.mf_custom_lens?.updatedAt)],
  ];
  for (const [k, v, u] of rows) {
    console.log(`  ${k.padEnd(32)} ${v.padEnd(50)} ${u ? `(updated ${u})` : ""}`);
  }
}

async function main() {
  const skuPrefix = process.argv[2] || "JX1001";
  for (const store of ["dtc", "wholesale"] as const) {
    await inspectStore(store, skuPrefix);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
