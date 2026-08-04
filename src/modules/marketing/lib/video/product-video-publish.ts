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
import { externalSkuCandidates } from "@/modules/catalog/lib/sku-resolve";

/** Jaxy runs two Shopify stores — the video belongs on both. */
export type ShopifyChannel = "retail" | "wholesale";
export const SHOPIFY_CHANNELS: ShopifyChannel[] = ["retail", "wholesale"];

export interface ChannelResult {
  channel: ShopifyChannel;
  ok: boolean;
  shopifyProductId?: string;
  mediaId?: string;
  error?: string;
}

export interface PublishResult {
  ok: boolean;
  productId: string;
  /** One entry per store attempted. */
  channels: ChannelResult[];
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
): Promise<{ id: string | null; tried: string[] }> {
  const rows = sqlite
    .prepare(`SELECT id, sku FROM catalog_skus WHERE product_id = ? AND sku IS NOT NULL AND sku != ''`)
    .all(productId) as Array<{ id: string; sku: string }>;
  if (rows.length === 0) return { id: null, tried: [] };

  // The catalog and the storefront don't always spell a SKU the same way
  // — JX4011-S-BLK here is often JX4011-BLK on Shopify — so try every
  // known spelling (legacy form, power-stripped, explicit aliases) rather
  // than only the catalog's.
  const tried: string[] = [];
  for (const row of rows) {
    for (const candidate of externalSkuCandidates(row.sku, row.id)) {
      if (tried.some((t) => t.toUpperCase() === candidate.toUpperCase())) continue;
      tried.push(candidate);

      const data = await client.graphql<{
        productVariants: { edges: Array<{ node: { product: { id: string } } }> };
      }>(
        `query FindBySku($q: String!) {
           productVariants(first: 1, query: $q) { edges { node { product { id } } } }
         }`,
        { q: `sku:${JSON.stringify(candidate)}` },
      );
      const id = data?.productVariants?.edges?.[0]?.node?.product?.id;
      if (id) return { id, tried };
    }
  }
  return { id: null, tried };
}

/**
 * Push an approved product video to Shopify — to EVERY store by default
 * (retail and wholesale), since the same frame is sold on both. Each
 * store is independent: one failing (or not stocking that SKU) never
 * blocks the other, and each records its own timestamp.
 */
export async function publishProductVideo(
  productId: string,
  channels: ShopifyChannel[] = SHOPIFY_CHANNELS,
): Promise<PublishResult> {
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

  if (!row) return { ok: false, productId, channels: [], error: "No product video built yet" };
  if (row.status !== "ready" || !row.filePath) {
    return { ok: false, productId, channels: [], error: "Video isn't rendered" };
  }
  // The human gate. Never publish on a batch job's authority alone.
  if (!row.approvedAt) {
    return { ok: false, productId, channels: [], error: "Not approved — approve it before publishing" };
  }

  // Materialize once; the same bytes go to every store. A missing master
  // is a clean error, not an unhandled throw.
  let media: { path: string; cleanup: () => Promise<void> };
  try {
    media = await materializeVideo(row.filePath);
  } catch (e) {
    return {
      ok: false,
      productId,
      channels: [],
      error: `Can't read the rendered video (${e instanceof Error ? e.message : e}) — rebuild it first`,
    };
  }

  const results: ChannelResult[] = [];
  try {
    const bytes = await readFile(media.path);
    const filename = `${slugify(row.productName)}.mp4`;

    for (const channel of channels) {
      try {
        const r = await publishToChannel(channel, productId, row.productName, bytes, filename);
        results.push(r);
        if (r.ok) {
          const col = channel === "retail" ? "shopify_retail_at" : "shopify_wholesale_at";
          sqlite
            .prepare(
              `UPDATE marketing_product_videos
                  SET ${col} = datetime('now'), shopify_published_at = datetime('now'),
                      error = NULL, updated_at = datetime('now')
                WHERE product_id = ?`,
            )
            .run(productId);
        }
      } catch (e) {
        // A store that isn't connected shouldn't sink the other one.
        results.push({ channel, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await media.cleanup();
  }

  const anyOk = results.some((r) => r.ok);
  return {
    ok: anyOk,
    productId,
    channels: results,
    error: anyOk ? undefined : results.map((r) => `${r.channel}: ${r.error}`).join(" · "),
  };
}

/** Upload + attach the video on ONE store. */
async function publishToChannel(
  channel: ShopifyChannel,
  productId: string,
  productName: string,
  bytes: Buffer,
  filename: string,
): Promise<ChannelResult> {
  const client = await getShopifyClientByChannel(channel);
  const { id: shopifyProductId, tried } = await resolveShopifyProductId(client, productId);
  if (!shopifyProductId) {
    // Name what was searched — otherwise the only way to work out why a
    // publish failed is to guess at the storefront's SKU spelling.
    return {
      channel,
      ok: false,
      error:
        tried.length === 0
          ? `This product has no SKUs in the catalog, so there's nothing to match on the ${channel} store`
          : `No product on the ${channel} store has any of these SKUs: ${tried.join(", ")}. ` +
            `Add the storefront's spelling as a SKU alias if it differs.`,
    };
  }

  {

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
    if (errs?.length) return { channel, ok: false, error: errs.map((e) => e.message).join("; ") };
    const target = staged.stagedUploadsCreate.stagedTargets[0];
    if (!target) return { channel, ok: false, error: "Shopify returned no upload target" };

    // 2. Upload the bytes. Parameters MUST precede the file part.
    const form = new FormData();
    for (const p of target.parameters) form.append(p.name, p.value);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), filename);
    const upload = await fetch(target.url, { method: "POST", body: form });
    if (!upload.ok) {
      return { channel, ok: false, error: `Upload to Shopify failed (${upload.status})` };
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
        media: [{ originalSource: target.resourceUrl, mediaContentType: "VIDEO", alt: productName }],
      },
    );
    const mErrs = attach.productCreateMedia.mediaUserErrors;
    if (mErrs?.length) return { channel, ok: false, error: mErrs.map((e) => e.message).join("; ") };

    return {
      channel,
      ok: true,
      shopifyProductId,
      mediaId: attach.productCreateMedia.media?.[0]?.id,
    };
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
}
