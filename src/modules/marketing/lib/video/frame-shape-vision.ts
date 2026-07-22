/**
 * Frame-shape vision primitives — crop + classify a glasses close-up.
 *
 * DB-free on purpose: the crop math and the Haiku classification call take
 * only pixels + a vocabulary, so a standalone harness (or a unit test) can
 * exercise them without opening the app database. The DB orchestration
 * (catalog vocabulary, product matching, persistence) lives in
 * frame-shape.ts, which composes these.
 */
import sharp from "sharp";
import { skuMatchModel } from "../ai-model";

export const normShape = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

// ── Crop (deterministic) ──

export interface CropOptions {
  /** Fraction of frame width to keep (centered). */
  widthFrac?: number;
  /** Fraction of frame height to keep. */
  heightFrac?: number;
  /** Vertical anchor of the kept band, 0=top … 1=bottom. Portrait shots
   *  (worn frames) put the glasses high; product shots are centered. */
  yAnchor?: number;
  /** Longest edge of the output (downscale for cheap image tokens). */
  maxDim?: number;
}

/**
 * Pure crop-rectangle math (pixels), exported for unit tests. Keeps the
 * kept band inside the image and honours the vertical anchor. Portrait
 * frames (a worn pair in a 9:16 clip) default to a tall-ish upper band;
 * landscape/square (product shots) to a centred near-full crop.
 */
export function cropRect(
  width: number,
  height: number,
  opts: CropOptions = {},
): { left: number; top: number; width: number; height: number } {
  const portrait = height > width;
  const wf = opts.widthFrac ?? (portrait ? 0.92 : 0.86);
  const hf = opts.heightFrac ?? (portrait ? 0.55 : 0.86);
  const yAnchor = opts.yAnchor ?? (portrait ? 0.4 : 0.5);

  const cw = Math.max(1, Math.min(width, Math.round(width * wf)));
  const ch = Math.max(1, Math.min(height, Math.round(height * hf)));
  const left = Math.round((width - cw) / 2);
  const topRaw = Math.round((height - ch) * yAnchor);
  const top = Math.max(0, Math.min(height - ch, topRaw));
  return { left, top, width: cw, height: ch };
}

/**
 * Crop a still (path or buffer) to a glasses-sized close-up and return
 * JPEG bytes + the base64 the model gets. Downscaled so the vision call
 * stays cheap.
 */
export async function cropGlasses(
  src: string | Buffer,
  opts: CropOptions = {},
): Promise<{ buffer: Buffer; base64: string; mime: "image/jpeg"; width: number; height: number }> {
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("Could not read still dimensions");

  const rect = cropRect(W, H, opts);
  const maxDim = opts.maxDim ?? 640;
  const buffer = await sharp(src)
    .extract(rect)
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const out = await sharp(buffer).metadata();
  return {
    buffer,
    base64: buffer.toString("base64"),
    mime: "image/jpeg",
    width: out.width ?? 0,
    height: out.height ?? 0,
  };
}

// ── AI classification (base64 vision, forced tool-use) ──

export interface ShapeGuess {
  shape: string;
  confidence: number; // 0-100
}

export interface ClassifyResult {
  ok: boolean;
  /** Ranked shapes, best first. Empty when no clear frame is visible. */
  shapes: ShapeGuess[];
  /** False when the model couldn't see a frame clearly (send another frame). */
  clearShot: boolean;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

const CLASSIFY_TOOL = {
  name: "classify_frame_shape",
  description:
    "Report the eyewear frame shape(s) visible in the image, chosen ONLY from the provided catalog vocabulary.",
  input_schema: {
    type: "object",
    required: ["clearShot", "shapes"],
    properties: {
      clearShot: {
        type: "boolean",
        description:
          "true if a pair of glasses/sunglasses is clearly visible enough to judge its shape; false if none is visible or it's too small/blurry/occluded.",
      },
      shapes: {
        type: "array",
        maxItems: 3,
        description:
          "Up to 3 candidate shapes, most likely first. Empty when clearShot is false. Each shape MUST be copied verbatim from the vocabulary list.",
        items: {
          type: "object",
          required: ["shape", "confidence"],
          properties: {
            shape: { type: "string", description: "One value from the vocabulary list, verbatim." },
            confidence: { type: "number", description: "0-100 confidence for this shape." },
          },
        },
      },
    },
  },
};

/**
 * Classify the frame shape of a cropped glasses image. One cheap Haiku
 * call, forced tool-use, closed vocabulary. Self-contained (base64) so it
 * works on transient crops. Never throws — returns ok:false on any error.
 * Hallucinated shapes (outside the vocabulary) are dropped.
 */
export async function classifyFrameShapeFromImage(
  base64: string,
  mime: string,
  vocabulary: string[],
  model = skuMatchModel(),
): Promise<ClassifyResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, shapes: [], clearShot: false, error: "ANTHROPIC_API_KEY not configured" };

  const vocab = [...new Set(vocabulary.map(normShape).filter(Boolean))];
  const allowed = new Set(vocab);
  const system =
    "You identify eyewear frame shapes for a sunglasses catalog. You are given a close-up of a single pair of glasses. " +
    "Judge ONLY the frame's outline shape, not the color or lens. Choose exclusively from this catalog vocabulary — never invent a shape:\n" +
    vocab.map((v) => `- ${v}`).join("\n") +
    "\nIf several shapes are plausible, rank them by likelihood. If no frame is clearly visible, set clearShot=false and return an empty shapes list.";

  const body = {
    model,
    max_tokens: 512,
    system,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
          { type: "text", text: "Classify the frame shape of these glasses using only the catalog vocabulary." },
        ],
      },
    ],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, shapes: [], clearShot: false, error: `Anthropic API ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as {
      content: Array<{ type: string; name?: string; input?: unknown }>;
      usage?: { input_tokens: number; output_tokens: number };
    };
    const call = data.content.find((c) => c.type === "tool_use");
    if (!call?.input) return { ok: false, shapes: [], clearShot: false, error: "No tool_use in response" };
    const input = call.input as { clearShot?: boolean; shapes?: Array<{ shape?: string; confidence?: number }> };

    const shapes: ShapeGuess[] = (input.shapes ?? [])
      .map((s) => ({ shape: normShape(s.shape), confidence: Math.max(0, Math.min(100, Number(s.confidence) || 0)) }))
      .filter((s) => allowed.has(s.shape))
      .sort((a, b) => b.confidence - a.confidence);
    return { ok: true, shapes, clearShot: Boolean(input.clearShot) && shapes.length > 0, usage: data.usage };
  } catch (e) {
    return { ok: false, shapes: [], clearShot: false, error: e instanceof Error ? e.message : String(e) };
  }
}
