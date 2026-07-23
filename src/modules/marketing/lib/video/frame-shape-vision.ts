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

/** Token usage from the API — cache fields power accurate cost logging. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

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

/** Downscale a still (path or buffer) to a base64 JPEG — no crop. Used to
 *  send the whole frame to the glasses detector. */
export async function encodeImage(
  src: string | Buffer,
  maxDim = 768,
): Promise<{ base64: string; mime: "image/jpeg" }> {
  const buffer = await sharp(src)
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { base64: buffer.toString("base64"), mime: "image/jpeg" };
}

// ── Glasses detection (locate, then crop to the box) ──

/** Bounding box as fractions of the image, top-left origin. */
export interface GlassesBox { x: number; y: number; w: number; h: number }

export interface DetectResult {
  ok: boolean;
  box: GlassesBox | null;
  error?: string;
  usage?: TokenUsage;
}

const DETECT_TOOL = {
  name: "locate_glasses",
  description: "Report a tight bounding box around the eyewear in the image.",
  input_schema: {
    type: "object",
    required: ["found"],
    properties: {
      found: { type: "boolean", description: "true if a pair of glasses/sunglasses is visible." },
      box: {
        type: "object",
        description: "Tight box around JUST the glasses (lenses + frame + temples), as fractions 0-1 of the image. Omit when found is false.",
        required: ["x", "y", "w", "h"],
        properties: {
          x: { type: "number", description: "Left edge, 0-1 from the left." },
          y: { type: "number", description: "Top edge, 0-1 from the top." },
          w: { type: "number", description: "Width, 0-1 of image width." },
          h: { type: "number", description: "Height, 0-1 of image height." },
        },
      },
    },
  },
};

/**
 * Locate the glasses in a full frame so we can crop tightly to them —
 * fixes worn/off-centre shots a fixed crop misses. One cheap call; never
 * throws. Returns box=null when no glasses are found.
 */
export async function detectGlassesBox(
  base64: string,
  mime: string,
  model = skuMatchModel(),
): Promise<DetectResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, box: null, error: "ANTHROPIC_API_KEY not configured" };

  const body = {
    model,
    max_tokens: 256,
    system:
      "You locate eyewear in a photo or video still. Return a TIGHT bounding box around just the glasses or sunglasses — " +
      "the lenses, frame, and visible temples — whether worn on a face or held up. Coordinates are fractions of the image " +
      "(0-1), x/y at the top-left of the box. If no glasses are visible, set found=false.",
    tools: [DETECT_TOOL],
    tool_choice: { type: "tool", name: DETECT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
          { type: "text", text: "Locate the glasses and return a tight bounding box." },
        ],
      },
    ],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, box: null, error: `Anthropic API ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: unknown }>;
      usage?: TokenUsage;
    };
    const call = data.content.find((c) => c.type === "tool_use");
    if (!call?.input) return { ok: false, box: null, error: "No tool_use in response" };
    const input = call.input as { found?: boolean; box?: { x?: number; y?: number; w?: number; h?: number } };
    if (!input.found || !input.box) return { ok: true, box: null, usage: data.usage };
    const b = input.box;
    const box: GlassesBox = {
      x: Math.max(0, Math.min(1, Number(b.x) || 0)),
      y: Math.max(0, Math.min(1, Number(b.y) || 0)),
      w: Math.max(0, Math.min(1, Number(b.w) || 0)),
      h: Math.max(0, Math.min(1, Number(b.h) || 0)),
    };
    // A degenerate box is unusable — treat as not found.
    if (box.w < 0.02 || box.h < 0.02) return { ok: true, box: null, usage: data.usage };
    return { ok: true, box, usage: data.usage };
  } catch (e) {
    return { ok: false, box: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Crop a still to a detected glasses box (+ padding) and downscale.
 * Padding is a little more vertically so temples/brow aren't clipped.
 */
export async function cropToBox(
  src: string | Buffer,
  box: GlassesBox,
  opts: { pad?: number; maxDim?: number } = {},
): Promise<{ buffer: Buffer; base64: string; mime: "image/jpeg"; width: number; height: number }> {
  const meta = await sharp(src).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("Could not read still dimensions");

  const pad = opts.pad ?? 0.18;
  const x0 = Math.max(0, Math.round((box.x - pad) * W));
  const y0 = Math.max(0, Math.round((box.y - pad * 1.3) * H));
  const x1 = Math.min(W, Math.round((box.x + box.w + pad) * W));
  const y1 = Math.min(H, Math.round((box.y + box.h + pad * 1.3) * H));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const maxDim = opts.maxDim ?? 640;
  const buffer = await sharp(src)
    .extract({ left: x0, top: y0, width, height })
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const out = await sharp(buffer).metadata();
  return { buffer, base64: buffer.toString("base64"), mime: "image/jpeg", width: out.width ?? 0, height: out.height ?? 0 };
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
  usage?: TokenUsage;
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
      usage?: TokenUsage;
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

// ── Direct product match against a contact sheet ──

export interface ProductMatchGuess {
  /** The tile number from the contact sheet. */
  index: number;
  confidence: number; // 0-100
}

export interface ProductMatchResult {
  ok: boolean;
  clearShot: boolean;
  /** Optional overall shape word the model named, for display. */
  shape: string | null;
  /** Ranked product tile numbers, best first (≤10). */
  matches: ProductMatchGuess[];
  /** Video-type slug picked from the provided options (when asked). */
  videoType: string | null;
  error?: string;
  usage?: TokenUsage;
}

const MATCH_TOOL = {
  name: "match_products",
  description:
    "Rank the catalog products whose FRAME SHAPE best matches the target glasses, by tile number.",
  input_schema: {
    type: "object",
    required: ["clearShot", "matches"],
    properties: {
      clearShot: {
        type: "boolean",
        description:
          "true if the target glasses are clearly visible enough to judge their frame shape; false if none is visible or it's too small/blurry/occluded.",
      },
      shape: {
        type: "string",
        description: "One word for the target's overall frame shape (e.g. round, aviator, square). Optional.",
      },
      videoType: {
        type: "string",
        description:
          "Only when a VIDEO TYPES list is provided: the slug of the option that best describes the video, judged from the full frame. Omit otherwise.",
      },
      matches: {
        type: "array",
        maxItems: 10,
        description:
          "Up to 10 catalog tile numbers whose FRAME SHAPE best matches the target, most likely first. Empty when clearShot is false.",
        items: {
          type: "object",
          required: ["number", "confidence"],
          properties: {
            number: { type: "integer", description: "A tile number from the catalog sheets." },
            confidence: { type: "number", description: "0-100 likelihood this product is the same shape." },
          },
        },
      },
    },
  },
};

/**
 * Show the model the catalog — each product photo individually, preceded
 * by a plain-text label ("#12 — Solstice (JX1006)") — then the target
 * crop, and get back the top-10 products by FRAME SHAPE (colour ignored).
 *
 * The catalog comes FIRST and carries a cache_control breakpoint: it's
 * byte-identical across clips, so subsequent calls read it from the
 * prompt cache (~10x cheaper) and only the small crop varies. One call;
 * hallucinated / out-of-range numbers are dropped. Never throws.
 */
export async function matchProductsFromSheets(
  crops: Array<{ base64: string; mime: string }>,
  catalog: Array<{ label: string; base64: string }>,
  opts: {
    /** One full (uncropped) frame — context for video-type classification. */
    fullFrame?: { base64: string; mime: string };
    /** Video-type options; when present the model also classifies the video. */
    videoTypes?: Array<{ slug: string; name: string; description: string | null }>;
  } = {},
  model = skuMatchModel(),
): Promise<ProductMatchResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: "ANTHROPIC_API_KEY not configured" };
  if (catalog.length === 0) return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: "No catalog images" };
  if (crops.length === 0) return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: "No target crops" };
  const productCount = catalog.length;

  const system =
    "You identify eyewear by FRAME SHAPE for a sunglasses catalog. You are given every product we sell — one labelled photo " +
    "each — then one or more stills of the SAME target pair of glasses taken at different moments of a video. " +
    "Use every still together: different angles of the same pair reveal the shape better than any single frame. " +
    "Judge ONLY the frame's outline shape: the silhouette, lens shape, proportions, brow line, corners. " +
    "IGNORE colour, tint, lens darkness, and finish completely — a black pair matches a tortoise or clear pair if the shape is the same. " +
    `Return up to 10 product numbers (1–${productCount}) whose frame shape best matches the target, ranked most-likely first, ` +
    "each with a confidence 0–100. If no frame is clearly visible in any still, set clearShot=false and return an empty list.";

  // Catalog prefix (stable → cacheable), then the varying target.
  const content: unknown[] = [
    { type: "text", text: `CATALOG — all ${productCount} products, one labelled photo each:` },
  ];
  catalog.forEach((c, i) => {
    content.push({ type: "text", text: c.label });
    const img: Record<string, unknown> = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: c.base64 },
    };
    // Cache breakpoint on the last catalog image — everything up to here is
    // identical across clips.
    if (i === catalog.length - 1) img.cache_control = { type: "ephemeral" };
    content.push(img);
  });
  content.push({
    type: "text",
    text: `TARGET — the same pair of glasses, seen in ${crops.length} still${crops.length === 1 ? "" : "s"} from the video:`,
  });
  for (const c of crops) {
    content.push({ type: "image", source: { type: "base64", media_type: c.mime, data: c.base64 } });
  }
  if (opts.videoTypes?.length && opts.fullFrame) {
    const typeList = opts.videoTypes
      .map((t) => `- ${t.slug}: ${t.name}${t.description ? ` — ${t.description}` : ""}`)
      .join("\n");
    content.push(
      {
        type: "text",
        text:
          "FULL FRAME — one uncropped still, for classifying the VIDEO TYPE (what kind of shot this is):",
      },
      { type: "image", source: { type: "base64", media_type: opts.fullFrame.mime, data: opts.fullFrame.base64 } },
      {
        type: "text",
        text: `VIDEO TYPES — pick the one slug that best describes this video:\n${typeList}`,
      },
    );
  }
  content.push({
    type: "text",
    text: "List the up-to-10 product numbers whose FRAME SHAPE best matches the target, ranked most-likely first with a confidence %. Ignore colour entirely." +
      (opts.videoTypes?.length ? " Also set videoType to the best-fitting slug." : ""),
  });

  const body = {
    model,
    max_tokens: 1024,
    system,
    tools: [MATCH_TOOL],
    tool_choice: { type: "tool", name: MATCH_TOOL.name },
    messages: [{ role: "user", content }],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: `Anthropic API ${res.status}: ${await res.text()}` };
    const data = (await res.json()) as {
      content: Array<{ type: string; input?: unknown }>;
      usage?: TokenUsage;
    };
    const call = data.content.find((c) => c.type === "tool_use");
    if (!call?.input) return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: "No tool_use in response" };
    const input = call.input as {
      clearShot?: boolean;
      shape?: string;
      videoType?: string;
      matches?: Array<{ number?: number; confidence?: number }>;
    };
    const allowedTypes = new Set((opts.videoTypes ?? []).map((t) => t.slug));
    const videoType =
      input.videoType && allowedTypes.has(String(input.videoType).trim()) ? String(input.videoType).trim() : null;

    const seen = new Set<number>();
    const matches: ProductMatchGuess[] = (input.matches ?? [])
      .map((m) => ({ index: Math.round(Number(m.number)), confidence: Math.max(0, Math.min(100, Number(m.confidence) || 0)) }))
      .filter((m) => Number.isInteger(m.index) && m.index >= 1 && m.index <= productCount && !seen.has(m.index) && seen.add(m.index))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 10);
    return {
      ok: true,
      clearShot: Boolean(input.clearShot) && matches.length > 0,
      shape: input.shape ? normShape(input.shape) : null,
      matches,
      videoType,
      usage: data.usage,
    };
  } catch (e) {
    return { ok: false, clearShot: false, shape: null, matches: [], videoType: null, error: e instanceof Error ? e.message : String(e) };
  }
}
