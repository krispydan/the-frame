/**
 * AI SKU identification — match a media frame against the catalog.
 *
 * Flow per media item (video clip poster or catalog image):
 *   1. getReferenceSheets() — labeled catalog contact sheets (cached).
 *   2. One vision request: sheets + the frame, forced tool-use returning
 *      candidate SKU codes with 0-100 confidence (or "no product").
 *   3. mapCandidates() folds colorway-level answers into parent products
 *      (we tag products, not colors) and stores them on the match row
 *      for the review UI, where a human confirms.
 *
 * Uses the same direct-fetch + forced-tool pattern as email-ai.ts, but
 * with base64 image blocks (media bytes live server-side, not at URLs
 * the API could fetch).
 */
import sharp from "sharp";
import { db, sqlite } from "@/lib/db";
import { mediaMatches } from "@/modules/marketing/schema";
import { and, eq } from "drizzle-orm";
import { readVideo } from "@/lib/storage/videos";
import { readImage } from "@/lib/storage/local";
import { readFromR2IfPresent } from "@/lib/storage/media";
import { videoModel } from "@/modules/marketing/lib/ai-model";
import { getReferenceSheets, type ReferenceSku } from "./sku-reference";

export type MediaType = "clip" | "image";

export interface MatchCandidate {
  productId: string;
  productName: string;
  /** Best-matching colorway code, e.g. JX1005-OLV (evidence, not the tag). */
  sku: string;
  skuId: string;
  colorName: string | null;
  /** 0-100. */
  confidence: number;
}

// ── Model answer → catalog candidates ──

interface RawCandidate {
  sku?: unknown;
  confidence?: unknown;
}

/**
 * Map the model's colorway-level answers onto catalog rows and fold to
 * parent products (max confidence per product wins). Unknown SKU codes
 * are dropped — the model must pick from the sheets, not invent.
 */
export function mapCandidates(raw: RawCandidate[], skus: ReferenceSku[]): MatchCandidate[] {
  const bySku = new Map(skus.map((s) => [s.sku.toUpperCase(), s]));
  const byProduct = new Map<string, MatchCandidate>();

  for (const item of raw) {
    if (typeof item?.sku !== "string") continue;
    const ref = bySku.get(item.sku.trim().toUpperCase());
    if (!ref) continue;
    const confidence = Math.max(0, Math.min(100, Math.round(Number(item.confidence) || 0)));
    const existing = byProduct.get(ref.productId);
    if (!existing || confidence > existing.confidence) {
      byProduct.set(ref.productId, {
        productId: ref.productId,
        productName: ref.productName,
        sku: ref.sku,
        skuId: ref.skuId,
        colorName: ref.colorName,
        confidence,
      });
    }
  }
  return [...byProduct.values()].sort((a, b) => b.confidence - a.confidence);
}

// ── Vision request ──

const MATCH_TOOL = {
  name: "report_sku_matches",
  description: "Report which catalog SKUs appear in the media frame.",
  input_schema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        description:
          "Catalog SKU codes that plausibly match, best first. Include several options when unsure. Empty if no catalog product is identifiable.",
        items: {
          type: "object",
          properties: {
            sku: { type: "string", description: "Exact SKU code from a reference sheet, e.g. JX1005-OLV" },
            confidence: { type: "number", description: "0-100 — how confident this product is in the frame" },
          },
          required: ["sku", "confidence"],
        },
      },
      noProductVisible: {
        type: "boolean",
        description: "True when no catalog eyewear is identifiable in the frame at all",
      },
    },
    required: ["candidates", "noProductVisible"],
  },
} as const;

function b64Image(buf: Buffer): { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } } {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: buf.toString("base64") } };
}

async function callVision(content: unknown[]): Promise<{ candidates: RawCandidate[]; noProductVisible: boolean }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: videoModel(),
      max_tokens: 1024,
      system:
        "You identify Jaxy eyewear products in marketing media. You are given labeled catalog reference sheets " +
        "(each cell shows one colorway with its SKU code) followed by ONE media frame to identify. Match by frame " +
        "shape, color/pattern, temple details and lens tint. Sunglasses are often worn on a model at an angle — " +
        "judge carefully. Only report SKU codes that appear on the sheets. Be honest: high confidence (80+) only " +
        "for clear matches; when torn between look-alikes, list each with moderate confidence.",
      tools: [MATCH_TOOL],
      tool_choice: { type: "tool", name: MATCH_TOOL.name },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = (await res.json()) as { content: Array<{ type: string; input?: Record<string, unknown> }> };
  const toolCall = data.content.find((c) => c.type === "tool_use");
  if (!toolCall?.input) throw new Error("Model returned no tool_use block");
  return {
    candidates: Array.isArray(toolCall.input.candidates) ? (toolCall.input.candidates as RawCandidate[]) : [],
    noProductVisible: toolCall.input.noProductVisible === true,
  };
}

// ── Media frame loading ──

async function loadFrame(mediaType: MediaType, mediaId: string): Promise<Buffer> {
  if (mediaType === "clip") {
    const clip = sqlite
      .prepare(`SELECT poster_path AS posterPath FROM marketing_video_clips WHERE id = ?`)
      .get(mediaId) as { posterPath: string | null } | undefined;
    if (!clip) throw new Error(`Clip not found: ${mediaId}`);
    if (!clip.posterPath) throw new Error("Clip has no poster frame yet (still normalizing?)");
    return readVideo(clip.posterPath);
  }
  const image = sqlite
    .prepare(`SELECT file_path AS filePath FROM catalog_images WHERE id = ?`)
    .get(mediaId) as { filePath: string | null } | undefined;
  if (!image?.filePath) throw new Error(`Image not found or has no file: ${mediaId}`);
  try {
    return await readImage(image.filePath);
  } catch {
    const r2 = await readFromR2IfPresent(`images/${image.filePath}`);
    if (!r2) throw new Error(`Image bytes unreadable: ${image.filePath}`);
    return r2;
  }
}

// ── Public API ──

function upsertMatch(
  mediaType: MediaType,
  mediaId: string,
  fields: Partial<{ status: string; candidatesJson: string | null; error: string | null; model: string }>,
): void {
  const existing = db
    .select({ id: mediaMatches.id })
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  const now = new Date().toISOString();
  if (existing) {
    sqlite
      .prepare(
        `UPDATE marketing_media_matches SET status = COALESCE(?, status),
           candidates_json = COALESCE(?, candidates_json), error = ?, model = COALESCE(?, model), updated_at = ?
         WHERE id = ?`,
      )
      .run(fields.status ?? null, fields.candidatesJson ?? null, fields.error ?? null, fields.model ?? null, now, existing.id);
  } else {
    sqlite
      .prepare(
        `INSERT INTO marketing_media_matches (id, media_type, media_id, status, candidates_json, error, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), mediaType, mediaId, fields.status ?? "pending", fields.candidatesJson ?? null, fields.error ?? null, fields.model ?? null, now, now);
  }
}

/**
 * Run identification for one media item and store the suggestion.
 * Idempotent for the job queue: an already-confirmed row is never
 * overwritten; a suggested row is only re-run with force.
 */
export async function identifyMedia(
  mediaType: MediaType,
  mediaId: string,
  opts: { force?: boolean } = {},
): Promise<{ status: string; candidates: MatchCandidate[] }> {
  const existing = db
    .select()
    .from(mediaMatches)
    .where(and(eq(mediaMatches.mediaType, mediaType), eq(mediaMatches.mediaId, mediaId)))
    .get();
  if (existing?.status === "confirmed") {
    return { status: "confirmed", candidates: JSON.parse(existing.candidatesJson ?? "[]") };
  }
  if (existing?.status === "suggested" && !opts.force) {
    return { status: "suggested", candidates: JSON.parse(existing.candidatesJson ?? "[]") };
  }

  try {
    const [{ sheets, skus }, frameRaw] = await Promise.all([
      getReferenceSheets(),
      loadFrame(mediaType, mediaId),
    ]);
    // Normalize the frame: bounded size, JPEG (posters already are; catalog
    // images may be large PNGs).
    const frame = await sharp(frameRaw).resize(1000, 1000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

    const content: unknown[] = [
      {
        type: "text",
        text:
          `CATALOG REFERENCE SHEETS (${skus.length} colorways across ${sheets.length} sheets). ` +
          `Each cell: product photo, product name, SKU code.`,
      },
      ...sheets.map(b64Image),
      { type: "text", text: "MEDIA FRAME TO IDENTIFY — which catalog product(s) appear here?" },
      b64Image(frame),
    ];

    const answer = await callVision(content);
    const candidates = mapCandidates(answer.candidates, skus);
    const status = answer.noProductVisible || candidates.length === 0 ? "no_product" : "suggested";
    upsertMatch(mediaType, mediaId, {
      status,
      candidatesJson: JSON.stringify(candidates),
      error: null,
      model: videoModel(),
    });
    return { status, candidates };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    upsertMatch(mediaType, mediaId, { status: "failed", error: message.slice(0, 1000) });
    throw e;
  }
}
