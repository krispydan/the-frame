/**
 * Set up `custom.frame_shape` (list.single_line_text_field, 10 choices) on
 * both stores. On retail it updates the existing 6-choice definition; on
 * wholesale it creates a new one. Idempotent — safe to re-run.
 *
 * Run: npx tsx scripts/setup-frame-shape-metafield.ts
 *      npx tsx scripts/setup-frame-shape-metafield.ts --apply   # actually apply
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const CHOICES = [
  "Aviator",
  "Cat Eye",
  "Rectangle",
  "Round",
  "Square",
  "Oval",
  "Oversized",
  "Geometric",
  "Butterfly",
  "Wayfarer",
];

const FIND_Q = `
  query {
    metafieldDefinitions(ownerType: PRODUCT, namespace: "custom", key: "frame_shape", first: 1) {
      edges {
        node {
          id name namespace key
          type { name }
          validations { name value }
        }
      }
    }
  }
`;

const CREATE_M = `
  mutation Create($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id namespace key }
      userErrors { field message code }
    }
  }
`;

const UPDATE_M = `
  mutation Update($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id namespace key validations { name value } }
      userErrors { field message code }
    }
  }
`;

interface FindResp {
  metafieldDefinitions: {
    edges: Array<{
      node: {
        id: string;
        name: string;
        namespace: string;
        key: string;
        type: { name: string };
        validations: Array<{ name: string; value: string }>;
      };
    }>;
  };
}

const apply = process.argv.includes("--apply");

async function ensureOnStore(store: "dtc" | "wholesale") {
  console.log(`\n── ${store.toUpperCase()} ──`);
  const found = await shopifyGraphqlRequest<FindResp>(store, FIND_Q);
  const existing = found.metafieldDefinitions.edges[0]?.node;

  const validations = [{ name: "choices", value: JSON.stringify(CHOICES) }];

  if (!existing) {
    console.log(`No custom.frame_shape definition found — will CREATE.`);
    if (!apply) {
      console.log(`(dry run; pass --apply to execute)`);
      return;
    }
    const res = await shopifyGraphqlRequest<{ metafieldDefinitionCreate: { createdDefinition: unknown; userErrors: Array<{ field: string[]; message: string; code: string }> } }>(
      store,
      CREATE_M,
      {
        definition: {
          name: "Frame Shape",
          namespace: "custom",
          key: "frame_shape",
          ownerType: "PRODUCT",
          type: "list.single_line_text_field",
          validations,
        },
      },
    );
    if (res.metafieldDefinitionCreate.userErrors.length > 0) {
      console.log(`  CREATE errors:`, res.metafieldDefinitionCreate.userErrors);
    } else {
      console.log(`  CREATED:`, res.metafieldDefinitionCreate.createdDefinition);
    }
    return;
  }

  // Existing: compare choices
  const currentChoicesRaw = existing.validations.find((v) => v.name === "choices")?.value ?? "[]";
  const current: string[] = JSON.parse(currentChoicesRaw);
  const want = CHOICES;
  const sameSet = current.length === want.length && want.every((c) => current.includes(c));

  if (existing.type.name !== "list.single_line_text_field") {
    console.log(`  EXISTS but type is ${existing.type.name} — needs manual fix (Shopify won't change type via API).`);
    return;
  }

  if (sameSet) {
    console.log(`  Already up to date with ${current.length} choices: ${current.join(", ")}`);
    return;
  }

  console.log(`  Current choices (${current.length}): ${current.join(", ")}`);
  console.log(`  New choices    (${want.length}): ${want.join(", ")}`);
  if (!apply) {
    console.log(`  (dry run; pass --apply to execute)`);
    return;
  }
  const res = await shopifyGraphqlRequest<{ metafieldDefinitionUpdate: { updatedDefinition: unknown; userErrors: Array<{ field: string[]; message: string; code: string }> } }>(
    store,
    UPDATE_M,
    {
      definition: {
        namespace: "custom",
        key: "frame_shape",
        ownerType: "PRODUCT",
        validations,
      },
    },
  );
  if (res.metafieldDefinitionUpdate.userErrors.length > 0) {
    console.log(`  UPDATE errors:`, res.metafieldDefinitionUpdate.userErrors);
  } else {
    console.log(`  UPDATED:`, res.metafieldDefinitionUpdate.updatedDefinition);
  }
}

async function main() {
  for (const s of ["dtc", "wholesale"] as const) {
    await ensureOnStore(s);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
