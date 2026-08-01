/**
 * Gemini vision calls for SKU identification.
 *
 * Why Gemini for this job specifically: it prices images FLAT (258 tokens
 * each on the 2.5 family) regardless of pixel size, and this workload
 * sends ~115 catalog tiles on every call. Anthropic bills per 28px patch
 * and, more decisively, caps a request at 100 images on the 200k-context
 * models — one short of what the single-shot catalog design needs.
 * Gemini allows 3,000.
 *
 * Structured output uses responseSchema (JSON mode) rather than function
 * calling: the schema IS the contract, and the response is plain JSON.
 *
 * Caching is implicit and automatic — no cache_control breakpoints to
 * place. It requires the shared prefix to be byte-identical and to come
 * FIRST, which is why callers must put the catalog ahead of the target.
 */

/** Neutral part list — the same shape both providers build from. */
export type VisionPart =
  | { kind: "text"; text: string }
  | { kind: "image"; mime: string; base64: string };

/**
 * Normalized to Anthropic's field names so one cost function prices every
 * provider — see TokenUsage in frame-shape-vision.ts.
 */
export interface VisionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface GeminiResult<T> {
  ok: boolean;
  data: T | null;
  usage?: VisionUsage;
  error?: string;
}

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

export function geminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
}

/**
 * One structured-JSON vision call.
 *
 * `schema` is an OpenAPI-subset schema with UPPERCASE type names, which
 * is the form the REST API's proto enum expects. Never throws — every
 * failure comes back as { ok: false, error }, because a single bad frame
 * must not sink a library-wide run.
 */
export async function geminiJsonCall<T>(
  model: string,
  system: string,
  parts: VisionPart[],
  schema: Record<string, unknown>,
  maxOutputTokens = 1024,
): Promise<GeminiResult<T>> {
  const key = geminiApiKey();
  if (!key) return { ok: false, data: null, error: "GEMINI_API_KEY not configured" };

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [
      {
        role: "user",
        parts: parts.map((p) =>
          p.kind === "text" ? { text: p.text } : { inlineData: { mimeType: p.mime, data: p.base64 } },
        ),
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      maxOutputTokens,
      // Identification should be repeatable, not creative.
      temperature: 0,
    },
  };

  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, data: null, error: `Gemini API ${res.status}: ${(await res.text()).slice(0, 400)}` };
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
      };
    };

    const um = json.usageMetadata;
    const cached = um?.cachedContentTokenCount ?? 0;
    const usage: VisionUsage = {
      // promptTokenCount INCLUDES cached tokens; split them so the two are
      // costed at their different rates rather than double-counted.
      input_tokens: Math.max(0, (um?.promptTokenCount ?? 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0, // implicit caching — writes are free
      output_tokens: um?.candidatesTokenCount ?? 0,
    };

    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) {
      const reason = json.candidates?.[0]?.finishReason;
      return { ok: false, data: null, usage, error: `Empty response${reason ? ` (${reason})` : ""}` };
    }
    try {
      return { ok: true, data: JSON.parse(text) as T, usage };
    } catch {
      return { ok: false, data: null, usage, error: `Response was not valid JSON: ${text.slice(0, 200)}` };
    }
  } catch (e) {
    return { ok: false, data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Response schemas (OpenAPI subset, uppercase types) ──

export const GEMINI_DETECT_SCHEMA = {
  type: "OBJECT",
  properties: {
    found: { type: "BOOLEAN", description: "true if a pair of glasses/sunglasses is visible." },
    box: {
      type: "OBJECT",
      description: "Tight box around JUST the glasses, as fractions 0-1 of the image.",
      properties: {
        x: { type: "NUMBER", description: "Left edge, 0-1 from the left." },
        y: { type: "NUMBER", description: "Top edge, 0-1 from the top." },
        w: { type: "NUMBER", description: "Width, 0-1 of image width." },
        h: { type: "NUMBER", description: "Height, 0-1 of image height." },
      },
      propertyOrdering: ["x", "y", "w", "h"],
    },
  },
  required: ["found"],
  propertyOrdering: ["found", "box"],
};

export const GEMINI_MATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    clearShot: {
      type: "BOOLEAN",
      description:
        "true if the target glasses are clearly visible enough to judge frame shape; false if none visible or too small/blurry.",
    },
    shape: { type: "STRING", description: "One word for the target's overall frame shape (e.g. round, aviator)." },
    videoType: {
      type: "STRING",
      description: "Only when a VIDEO TYPES list is provided: the slug that best describes the video.",
    },
    matches: {
      type: "ARRAY",
      description: "Up to 10 catalog numbers whose FRAME SHAPE best matches, most likely first.",
      items: {
        type: "OBJECT",
        properties: {
          number: { type: "INTEGER", description: "A product number from the catalog." },
          confidence: { type: "NUMBER", description: "0-100 likelihood this product is the same shape." },
        },
        required: ["number", "confidence"],
        propertyOrdering: ["number", "confidence"],
      },
    },
  },
  required: ["clearShot", "matches"],
  propertyOrdering: ["clearShot", "shape", "videoType", "matches"],
};
