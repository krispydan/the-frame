/**
 * Set up `custom.lens_type` (single_line_text_field, 2 choices) on both
 * stores. Idempotent — safe to re-run.
 *
 * The Shopify standard `shopify.lens-polarization` is a metaobject ref
 * with display="UV400" overriding the standard "Non-polarized" handle.
 * That's fine for taxonomy but a plain text field is much easier for
 * theme code to read and filter on; the two coexist.
 *
 * Run: npx tsx scripts/setup-lens-type-metafield.ts            # dry
 *      npx tsx scripts/setup-lens-type-metafield.ts --apply
 */
import { shopifyGraphqlRequest } from "@/modules/orders/lib/shopify-api";

const CHOICES = ["Polarized", "UV400"];

const FIND_Q = `
  query {
    metafieldDefinitions(ownerType: PRODUCT, namespace: "custom", key: "lens_type", first: 1) {
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
        id: string; name: string; namespace: string; key: string;
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
    console.log(`No custom.lens_type definition — will CREATE.`);
    if (!apply) {
      console.log(`(dry; pass --apply to execute)`);
      return;
    }
    const res = await shopifyGraphqlRequest<{
      metafieldDefinitionCreate: { createdDefinition: unknown; userErrors: Array<{ field: string[]; message: string; code: string }> };
    }>(store, CREATE_M, {
      definition: {
        name: "Lens Type",
        namespace: "custom",
        key: "lens_type",
        ownerType: "PRODUCT",
        type: "single_line_text_field",
        validations,
      },
    });
    if (res.metafieldDefinitionCreate.userErrors.length > 0) {
      console.log(`  CREATE errors:`, res.metafieldDefinitionCreate.userErrors);
    } else {
      console.log(`  CREATED:`, res.metafieldDefinitionCreate.createdDefinition);
    }
    return;
  }

  const currentRaw = existing.validations.find((v) => v.name === "choices")?.value ?? "[]";
  const current: string[] = JSON.parse(currentRaw);
  const sameSet =
    current.length === CHOICES.length && CHOICES.every((c) => current.includes(c));

  if (existing.type.name !== "single_line_text_field") {
    console.log(`  EXISTS but type is ${existing.type.name} — needs manual fix.`);
    return;
  }
  if (sameSet) {
    console.log(`  Already up to date with ${current.length} choices: ${current.join(", ")}`);
    return;
  }

  console.log(`  Current choices (${current.length}): ${current.join(", ")}`);
  console.log(`  New choices    (${CHOICES.length}): ${CHOICES.join(", ")}`);
  if (!apply) {
    console.log(`  (dry; pass --apply to execute)`);
    return;
  }
  const res = await shopifyGraphqlRequest<{
    metafieldDefinitionUpdate: { updatedDefinition: unknown; userErrors: Array<{ field: string[]; message: string; code: string }> };
  }>(store, UPDATE_M, {
    definition: {
      namespace: "custom",
      key: "lens_type",
      ownerType: "PRODUCT",
      validations,
    },
  });
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
