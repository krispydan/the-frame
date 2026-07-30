/**
 * Publish a product video to its Shopify product page.
 *
 * Gated: only a video that has been APPROVED in the Frame can be pushed —
 * nothing reaches the storefront on a batch job's say-so.
 *
 * Shopify wants video bytes via a staged upload, not a URL we host:
 *   1. stagedUploadsCreate(resource: VIDEO)  → a signed target
 *   2. POST the file to that target (multipart, params first)
 *   3. productCreateMedia(originalSource: resourceUrl)
 * Shopify then transcodes asynchronously; the media appears on the PDP
 * once it finishes (status READY).
 *
 * There's no Shopify product id on catalog_products, so the product is
 * resolved by SKU — the key both systems already share.
 */
import { sqlite } from "@/lib/db";
import { getShopifyClientByChannel } from "@/modules/integrations/lib/shopify/admin-api";
import { materializeVideo } from "@/lib/storage/videos";
import { readFile } from "fs/promises";

export interface PublishResult {
  ok: boolean;
  productId: string;
  shopifyProductId?: string;
  mediaId?: string;
  error?: string;
}

interface Client {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/**
 * Find the Shopify product for one of our parent products by matching any
 * of its SKUs against Shopify variant SKUs.
 */
export async function resolveShopifyProductId(
  client: Client,
  productId: string,
): Promise<string | null> {
  const skus = (sqlite
    .prepare(`SELECT sku FROM catalog_skus WHERE product_id = ? AND sku IS NOT NULL AND sku != ''`)
    .all(productId) as Array<{ sku: string }>).map((r) => r.sku);
  if (skus.length === 0) return null;

  for (const sku of skus) {
    const data = await client.graphql<{
      productVariants: { edges: Array<{ node: { product: { id: string } } }> };
    }>(
      `query FindBySku($q: String!) {
         productVariants(first: 1, query: $q) { edges { node { product { id } } } }
       }`,
      { q: `sku:${JSON.stringify(sku)}` },
    );
    const id = data?.productVariants?.edges?.[0]?.node?.product?.id;
    if (id) return id;
  }
  return null;
}

/**
 * Push an approved product video to Shopify as product media.
 * Records shopify_published_at on success so the UI can show state.
 */
export async function publishProductVideo(productId: string): Promise<PublishResult> {
  const row = sqlite
    .prepare(
      `SELECT pv.file_path AS filePath, pv.status, pv.approved_at AS approvedAt, p.name AS productName
         FROM marketing_product_videos pv
         JOIN catalog_products p ON p.id = pv.product_id
        WHERE pv.product_id = ?`,
    )
    .get(productId) as
    | { filePath: string | null; status: string; approvedAt: string | null; productName: string }
    | undefined;

  if (!row) return { ok: false, productId, error: "No product video built yet" };
  if (row.status !== "ready" || !row.filePath) return { ok: false, productId, error: "Video isn't rendered" };
  // The human gate. Never publish on a batch job's authority alone.
  if (!row.approvedAt) return { ok: false, productId, error: "Not approved — approve it before publishing" };

  const client = await getShopifyClientByChannel("retail");
  const shopifyProductId = await resolveShopifyProductId(client, productId);
  if (!shopifyProductId) {
    return { ok: false, productId, error: `No Shopify product matches this product's SKUs (${row.productName})` };
  }

  const media = await materializeVideo(row.filePath);
  try {
    const bytes = await readFile(media.path);
    const filename = `${slugify(row.productName)}.mp4`;

    // 1. Ask Shopify where to put the bytes.
    const staged = await client.graphql<{
      stagedUploadsCreate: {
        stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
        userErrors: Array<{ message: string }>;
      };
    }>(
      `mutation Stage($input: [StagedUploadInput!]!) {
         stagedUploadsCreate(input: $input) {
           stagedTargets { url resourceUrl parameters { name value } }
           userErrors { message }
         }
       }`,
      {
        input: [
          {
            filename,
            mimeType: "video/mp4",
            resource: "VIDEO",
            fileSize: String(bytes.length),
            httpMethod: "POST",
          },
        ],
      },
    );
    const errs = staged.stagedUploadsCreate.userErrors;
    if (errs?.length) return { ok: false, productId, error: errs.map((e) => e.message).join("; ") };
    const target = staged.stagedUploadsCreate.stagedTargets[0];
    if (!target) return { ok: false, productId, error: "Shopify returned no upload target" };

    // 2. Upload the bytes. Parameters MUST precede the file part.
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
    const upload = await fetch(target.url, { method: "POST", body: form });
    if (!upload.ok) {
      return { ok: false, productId, error: `Upload to Shopify failed (${upload.status})` };
    }

    // 3. Attach it to the product.
    const attach = await client.graphql<{
      productCreateMedia: {
        media: Array<{ id: string; status: string }>;
        mediaUserErrors: Array<{ message: string }>;
      };
    }>(
      `mutation Attach($productId: ID!, $media: [CreateMediaInput!]!) {
         productCreateMedia(productId: $productId, media: $media) {
           media { ... on Video { id } status }
           mediaUserErrors { message }
         }
       }`,
      {
        productId: shopifyProductId,
        media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO", alt: row.productName }],
      },
    );
    const mErrs = attach.productCreateMedia.mediaUserErrors;
    if (mErrs?.length) return { ok: false, productId, error: mErrs.map((e) => e.message).join("; ") };

    sqlite
      .prepare(
        `UPDATE marketing_product_videos
            SET shopify_published_at = datetime('now'), error = NULL, updated_at = datetime('now')
          WHERE product_id = ?`,
      )
      .run(productId);

    return {
      ok: true,
      productId,
      shopifyProductId,
      mediaId: attach.productCreateMedia.media?.[0]?.id,
    };
  } finally {
    await media.cleanup();
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}
