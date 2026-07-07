/**
 * AI copy for generated videos — caption, hashtags, and the manual
 * posting checklist (trending audio to add, on-screen text to type,
 * products to tag — all done in the TikTok/IG apps).
 *
 * Rides the email assistant's stack: live-editable prompt from
 * prompt-store ("video-caption-prompt"), brand voice via
 * system-prompt-base, forced tool-use JSON via callClaude.
 *
 * A failed/missing-key generation NEVER blocks the video: the post
 * stays `rendered` (usable, copy regenerable) and we fall back to a
 * deterministic template caption.
 */
import { eq } from "drizzle-orm";
import { db, sqlite } from "@/lib/db";
import { videoPosts, videoRecipes } from "@/modules/marketing/schema";
import { videoModel } from "../ai-model";
import { getDocContent } from "../prompt-store";
import { callClaude, extractPromptBody, fillTemplate } from "../email-ai";
import { SLOT_TIMES, type Slot } from "./scheduler";

export interface PostingInstructions {
  audio: string;
  onScreenText: Array<{ text: string; timing: string; placement: string }>;
  tagProducts: string[];
  coverSuggestion: string;
  firstComment?: string;
}

export interface VideoCopy {
  caption: string;
  hashtags: string[];
  postingInstructions: PostingInstructions;
}

interface ClipContextRow {
  id: string;
  categorySlug: string | null;
  durationSec: number | null;
  products: Array<{ name: string; color: string | null; sku: string | null }>;
}

function loadClipContext(clipIds: string[]): ClipContextRow[] {
  const clipStmt = sqlite.prepare(`
    SELECT c.id, cat.slug AS categorySlug, c.duration_sec AS durationSec
    FROM marketing_video_clips c
    LEFT JOIN marketing_video_clip_categories cat ON cat.id = c.category_id
    WHERE c.id = ?
  `);
  const productStmt = sqlite.prepare(`
    SELECT p.name AS name, s.color_name AS color, s.sku AS sku
    FROM marketing_video_clip_products cp
    JOIN catalog_skus s ON s.id = cp.sku_id
    JOIN catalog_products p ON p.id = s.product_id
    WHERE cp.clip_id = ?
  `);
  return clipIds.map((id) => {
    const clip = clipStmt.get(id) as { id: string; categorySlug: string | null; durationSec: number | null } | undefined;
    const products = (productStmt.all(id) as Array<{ name: string; color: string | null; sku: string | null }>) ?? [];
    return { id, categorySlug: clip?.categorySlug ?? null, durationSec: clip?.durationSec ?? null, products };
  });
}

function loadFocusProducts(skuIds: string[]): Array<{
  name: string; color: string | null; sku: string | null; price: number | null;
}> {
  if (skuIds.length === 0) return [];
  const stmt = sqlite.prepare(`
    SELECT p.name AS name, s.color_name AS color, s.sku AS sku,
           COALESCE(s.retail_price, p.retail_price) AS price
    FROM catalog_skus s
    JOIN catalog_products p ON p.id = s.product_id
    WHERE s.id = ?
  `);
  return skuIds
    .map((id) => stmt.get(id) as { name: string; color: string | null; sku: string | null; price: number | null } | undefined)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
}

const SUBMIT_TOOL = {
  name: "submit_video_copy",
  description: "Submit the caption, hashtags and posting instructions for the video",
  input_schema: {
    type: "object",
    required: ["caption", "hashtags", "postingInstructions"],
    properties: {
      caption: { type: "string", description: "Caption for both platforms, <=220 chars" },
      hashtags: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
      postingInstructions: {
        type: "object",
        required: ["audio", "onScreenText", "tagProducts", "coverSuggestion"],
        properties: {
          audio: { type: "string" },
          onScreenText: {
            type: "array",
            items: {
              type: "object",
              required: ["text", "timing", "placement"],
              properties: {
                text: { type: "string" },
                timing: { type: "string" },
                placement: { type: "string" },
              },
            },
          },
          tagProducts: { type: "array", items: { type: "string" } },
          coverSuggestion: { type: "string" },
          firstComment: { type: "string" },
        },
      },
    },
  },
};

/** Deterministic fallback when the API key is missing or the call fails. */
function fallbackCopy(audioTreatment: string, focusProducts: Array<{ name: string; color: string | null }>): VideoCopy {
  const product = focusProducts[0];
  const caption = product
    ? `${product.name}${product.color ? ` in ${product.color}` : ""} — see it in motion.`
    : "New week, new frames.";
  return {
    caption,
    hashtags: ["#sunglasses", "#eyewear", "#fyp"],
    postingInstructions: {
      audio:
        audioTreatment === "silent"
          ? "Video is silent — pick a current trending sound in the TikTok app before posting."
          : "Original clip audio is included — post as-is or layer a trending sound at low volume.",
      onScreenText: [],
      tagProducts: focusProducts.map((p) => p.name),
      coverSuggestion: "Use the opening frame.",
      firstComment: undefined,
    },
  };
}

/**
 * Generate + persist caption/hashtags/instructions for a rendered post.
 * Returns { ok, usedFallback }. Only flips status rendered → ready on a
 * real AI success; fallback copy keeps status=rendered so the queue UI
 * shows it as "copy pending" and regenerate can retry.
 */
export async function generateVideoCopy(postId: string): Promise<{ ok: boolean; usedFallback: boolean; error?: string }> {
  const post = db.select().from(videoPosts).where(eq(videoPosts.id, postId)).get();
  if (!post) throw new Error(`Post not found: ${postId}`);

  const clipIds = JSON.parse(post.clipIds) as string[];
  const aiCtx = JSON.parse(post.aiContext ?? "{}") as { focusSkuIds?: string[]; trendNotes?: string[]; recipeId?: string };
  const recipe = post.recipeId
    ? db.select().from(videoRecipes).where(eq(videoRecipes.id, post.recipeId)).get()
    : undefined;

  const clipSequence = loadClipContext(clipIds).map((c, i) => ({
    position: i + 1,
    category: c.categorySlug ?? "uncategorized",
    durationSec: c.durationSec ?? 0,
    products: c.products,
  }));
  const focusProducts = loadFocusProducts(aiCtx.focusSkuIds ?? []);

  const scheduledFor = post.scheduledDate
    ? `${post.scheduledDate}, ${post.scheduledSlot ? SLOT_TIMES[post.scheduledSlot as Slot] : "any time"}`
    : "unscheduled";

  // Events overlapping the posting date (or today for unscheduled).
  const forDate = post.scheduledDate ?? new Date().toISOString().slice(0, 10);
  const events = sqlite.prepare(`
    SELECT title, event_type AS type, date_start AS dateStart, date_end AS dateEnd,
           priority, description
    FROM marketing_calendar_events
    WHERE date_end >= ? AND date_start <= ?
    ORDER BY priority ASC
    LIMIT 6
  `).all(forDate, new Date(new Date(forDate).getTime() + 7 * 86400000).toISOString().slice(0, 10)) as Array<{
    title: string; type: string; dateStart: string; dateEnd: string; priority: number; description: string | null;
  }>;

  const promptDoc = getDocContent("video-caption-prompt");
  const systemBase = extractPromptBody(getDocContent("system-prompt-base"))
    .replace(/\{\{?AUDIENCE\}?\}/g, "retail")
    // Video captions are always retail-voiced; strip audience conditionals.
    .replace(/\{IF\s+audience[^}]*\}([\s\S]*?)\{(ELSE[^}]*|ENDIF)\}/g, "$1");

  const userPrompt = fillTemplate(extractPromptBody(promptDoc), {
    scheduledFor,
    recipeName: recipe?.name ?? "custom mix",
    recipeDescription: recipe?.description ?? "",
    durationSec: (post.durationSec ?? 0).toFixed(1),
    audioState: post.audioTreatment,
    clipSequence: JSON.stringify(clipSequence, null, 2),
    focusProducts: JSON.stringify(focusProducts, null, 2),
    trendContext: (aiCtx.trendNotes ?? []).join("\n") || "(no trend data this week)",
    events: JSON.stringify(events, null, 2),
  });

  const result = await callClaude({
    systemPrompt: systemBase,
    userPrompt,
    tool: SUBMIT_TOOL,
    maxTokens: 2048,
    model: videoModel(),
  });

  const now = new Date().toISOString();

  if (result.ok) {
    const copy = result.output as unknown as VideoCopy;
    db.update(videoPosts)
      .set({
        caption: copy.caption,
        hashtags: JSON.stringify(copy.hashtags ?? []),
        instructions: JSON.stringify(copy.postingInstructions ?? {}),
        status: post.status === "rendered" ? "ready" : post.status,
        updatedAt: now,
      })
      .where(eq(videoPosts.id, postId))
      .run();
    return { ok: true, usedFallback: false };
  }

  // Fallback: usable placeholder copy, status stays `rendered`.
  const fallback = fallbackCopy(post.audioTreatment, focusProducts);
  db.update(videoPosts)
    .set({
      caption: post.caption ?? fallback.caption,
      hashtags: post.hashtags ?? JSON.stringify(fallback.hashtags),
      instructions: post.instructions ?? JSON.stringify(fallback.postingInstructions),
      updatedAt: now,
    })
    .where(eq(videoPosts.id, postId))
    .run();
  console.warn(`[video] AI copy failed for post ${postId}: ${result.error}`);
  return { ok: false, usedFallback: true, error: result.error };
}
