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
import { getTrendingSounds } from "./tiktok-sounds";
import type { TiktokSound } from "@/modules/marketing/schema";

export interface SuggestedSound {
  id: string;
  title: string;
  author: string | null;
  tiktokLink: string | null;
  rank: number | null;
  rankType: string;
  trendDirection: string | null;
}

export interface PostingInstructions {
  audio: string;
  onScreenText: Array<{ text: string; timing: string; placement: string }>;
  tagProducts: string[];
  coverSuggestion: string;
  firstComment?: string;
  /** Concrete trending sounds to use, hydrated from the synced chart. */
  suggestedSounds?: SuggestedSound[];
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
          suggestedSoundIds: {
            type: "array",
            items: { type: "string" },
            maxItems: 3,
            description:
              "Up to 3 ids picked from the provided trendingSounds list, best fit first. Empty when the video keeps its original audio or the list is empty.",
          },
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

/** Slim, prompt-ready view of the current chart. */
function soundsForPrompt(): { list: TiktokSound[]; promptJson: string } {
  // One trending chart (the actor has no breakout/popular split), top 15.
  const list = getTrendingSounds({ limit: 15 });
  const promptJson = JSON.stringify(
    list.map((s) => ({
      id: s.id,
      title: s.title,
      author: s.author,
      chart: s.rankType,
      rank: s.rank,
      trend: s.trendDirection,
      durationSec: s.durationSec,
    })),
    null,
    2,
  );
  return { list, promptJson };
}

function hydrateSuggestedSounds(ids: unknown, available: TiktokSound[]): SuggestedSound[] {
  if (!Array.isArray(ids)) return [];
  const byId = new Map(available.map((s) => [s.id, s]));
  return ids
    .map((id) => byId.get(String(id)))
    .filter((s): s is TiktokSound => Boolean(s))
    .slice(0, 3)
    .map((s) => ({
      id: s.id,
      title: s.title,
      author: s.author,
      tiktokLink: s.tiktokLink,
      rank: s.rank,
      rankType: s.rankType,
      trendDirection: s.trendDirection,
    }));
}

/** Deterministic fallback when the API key is missing or the call fails. */
function fallbackCopy(
  audioTreatment: string,
  focusProducts: Array<{ name: string; color: string | null }>,
  sounds: TiktokSound[],
  allProductNames: string[],
): VideoCopy {
  const product = focusProducts[0];
  const caption = product
    ? `${product.name}${product.color ? ` in ${product.color}` : ""} — see it in motion.`
    : "New week, new frames.";
  // Even without AI, hand the poster real options: rising sounds first.
  const suggested =
    audioTreatment === "silent"
      ? [...sounds]
          .sort((a, b) => {
            const aRising = a.trendDirection === "up" || a.trendDirection === "new" ? 0 : 1;
            const bRising = b.trendDirection === "up" || b.trendDirection === "new" ? 0 : 1;
            return aRising - bRising || (a.rank ?? 99) - (b.rank ?? 99);
          })
          .slice(0, 3)
          .map((s) => ({
            id: s.id,
            title: s.title,
            author: s.author,
            tiktokLink: s.tiktokLink,
            rank: s.rank,
            rankType: s.rankType,
            trendDirection: s.trendDirection,
          }))
      : [];
  return {
    caption,
    hashtags: ["#sunglasses", "#eyewear", "#fyp"],
    postingInstructions: {
      audio:
        audioTreatment === "silent"
          ? suggested.length > 0
            ? "Video is silent — add one of the suggested trending sounds in the TikTok app before posting."
            : "Video is silent — pick a current trending sound in the TikTok app before posting."
          : "Original clip audio is included — post as-is or layer a trending sound at low volume.",
      suggestedSounds: suggested,
      onScreenText: [],
      tagProducts: allProductNames.length > 0 ? allProductNames : focusProducts.map((p) => p.name),
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

  const clipContext = loadClipContext(clipIds);
  const clipSequence = clipContext.map((c, i) => ({
    position: i + 1,
    category: c.categorySlug ?? "uncategorized",
    durationSec: c.durationSec ?? 0,
    products: c.products,
  }));
  const focusProducts = loadFocusProducts(aiCtx.focusSkuIds ?? []);

  // EVERY product visible anywhere in the video — the full tag list for
  // TikTok Shop (not just the featured focus SKUs). Deduped by name+color.
  const productsInVideo: Array<{ name: string; color: string | null; sku: string | null }> = [];
  const seenProduct = new Set<string>();
  for (const clip of clipContext) {
    for (const p of clip.products) {
      const key = `${p.name}|${p.color ?? ""}`;
      if (seenProduct.has(key)) continue;
      seenProduct.add(key);
      productsInVideo.push(p);
    }
  }

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

  const { list: chartSounds, promptJson: trendingSoundsJson } = soundsForPrompt();

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
    productsInVideo: productsInVideo.length > 0 ? JSON.stringify(productsInVideo, null, 2) : "(no products tagged on these clips)",
    trendContext: (aiCtx.trendNotes ?? []).join("\n") || "(no trend data this week)",
    events: JSON.stringify(events, null, 2),
    trendingSounds: chartSounds.length > 0 ? trendingSoundsJson : "(no chart synced yet — describe the vibe instead)",
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
    // Swap the AI's picked sound ids for full hydrated records (title,
    // author, link) so the UI needs no extra lookup.
    const instructions: PostingInstructions & { suggestedSoundIds?: unknown } = {
      ...(copy.postingInstructions ?? ({} as PostingInstructions)),
    };
    instructions.suggestedSounds = hydrateSuggestedSounds(
      instructions.suggestedSoundIds,
      chartSounds,
    );
    delete instructions.suggestedSoundIds;

    db.update(videoPosts)
      .set({
        caption: copy.caption,
        hashtags: JSON.stringify(copy.hashtags ?? []),
        instructions: JSON.stringify(instructions),
        status: post.status === "rendered" ? "ready" : post.status,
        updatedAt: now,
      })
      .where(eq(videoPosts.id, postId))
      .run();
    return { ok: true, usedFallback: false };
  }

  // Fallback: usable placeholder copy, status stays `rendered`.
  const allProductLabels = productsInVideo.map((p) => (p.color ? `${p.name} (${p.color})` : p.name));
  const fallback = fallbackCopy(post.audioTreatment, focusProducts, chartSounds, allProductLabels);
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
