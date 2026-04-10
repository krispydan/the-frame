/**
 * Gemini-backed product categorizer.
 *
 * Takes a Jaxy product (title, colorway, description, optional image URL)
 * and returns a structured AiCategorizationOutput containing:
 *   - An SEO title + meta description
 *   - 7 Shopify taxonomy metafield values (as metaobject handles)
 *
 * Uses Gemini 2.5 Flash with `response_mime_type: "application/json"` and a
 * response schema that constrains every field to a known enum so the model
 * can't invent handles. Falls back through the validator which catches any
 * drift and fills safe defaults.
 */
import {
  AGE_GROUP_HANDLES,
  COLOR_PATTERN_HANDLES,
  EYEWEAR_FRAME_DESIGN_HANDLES,
  LENS_POLARIZATION_HANDLES,
  TARGET_GENDER_HANDLES,
  validateAiCategorization,
  type AiCategorizationOutput,
  type ValidationProblem,
} from "./handles";
import { inferColorHandles } from "./color-mapping";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

export interface CategorizerInput {
  productId: string;
  name: string;
  colorName: string | null;
  description: string | null;
  frameShape: string | null;
  gender: string | null;
  /** Optional: absolute URL to the primary product image (1:1 square). */
  imageUrl?: string | null;
  /** Optional: raw image bytes base64-encoded, if we have them locally. */
  imageBase64?: string | null;
  imageMimeType?: string | null;
}

export interface CategorizerResult {
  output: AiCategorizationOutput | null;
  problems: ValidationProblem[];
  rawResponse?: unknown;
  error?: string;
  model: string;
}

const MODEL_NAME = "gemini-2.5-flash";

/**
 * JSON schema passed to Gemini to constrain the output. Gemini supports
 * OpenAPI-style schemas including `enum` so we can lock each field to a
 * known list of handles.
 */
function buildResponseSchema() {
  return {
    type: "object",
    properties: {
      seo: {
        type: "object",
        properties: {
          title: { type: "string", description: "SEO title, 50–60 chars, includes product name and 'Jaxy'." },
          description: { type: "string", description: "SEO meta description, 150–160 chars, includes frame shape, colorway, and benefit." },
        },
        required: ["title", "description"],
      },
      category_metafields: {
        type: "object",
        properties: {
          color_pattern: {
            type: "array",
            description: "1–2 high-level product colors (usually same as frame color).",
            items: { type: "string", enum: [...COLOR_PATTERN_HANDLES] },
          },
          eyewear_frame_color: {
            type: "array",
            description: "1–2 specific frame colors.",
            items: { type: "string", enum: [...COLOR_PATTERN_HANDLES] },
          },
          lens_color: {
            type: "array",
            description: "1 lens color. Dark/tinted lenses are 'black'. Mirrored lenses: pick dominant mirror color.",
            items: { type: "string", enum: [...COLOR_PATTERN_HANDLES] },
          },
          age_group: { type: "string", enum: [...AGE_GROUP_HANDLES] },
          lens_polarization: { type: "string", enum: [...LENS_POLARIZATION_HANDLES] },
          target_gender: { type: "string", enum: [...TARGET_GENDER_HANDLES] },
          eyewear_frame_design: { type: "string", enum: [...EYEWEAR_FRAME_DESIGN_HANDLES] },
        },
        required: [
          "color_pattern",
          "eyewear_frame_color",
          "lens_color",
          "age_group",
          "lens_polarization",
          "target_gender",
          "eyewear_frame_design",
        ],
      },
    },
    required: ["seo", "category_metafields"],
  };
}

function buildPrompt(input: CategorizerInput): string {
  const inferredColors = inferColorHandles(input.colorName);
  const colorHint = inferredColors.length > 0
    ? `Inferred color handles from the colorway "${input.colorName}": [${inferredColors.join(", ")}]. Use these as a strong prior for color-pattern and eyewear-frame-color unless the image clearly contradicts them.`
    : `Colorway: "${input.colorName || "unknown"}". Determine the frame color from the image.`;

  const shapeHint = input.frameShape
    ? `The product data says frame shape is "${input.frameShape}" — confirm this against the image and map to the closest enum value.`
    : `Frame shape is not provided in product data — infer from the image.`;

  const genderHint = input.gender
    ? `Target gender: "${input.gender}" (map to enum; default to unisex if ambiguous).`
    : `Target gender not specified — default to "unisex" unless clearly gendered.`;

  return `You are a Shopify taxonomy categorizer for Jaxy Eyewear, a California sunglasses brand. Your job is to return a JSON object matching the provided schema that classifies a sunglasses product into Shopify's standard taxonomy metafields.

Product name: ${input.name}
Colorway / variant: ${input.colorName || "(none)"}
Description: ${input.description ? input.description.slice(0, 500) : "(none provided)"}

${colorHint}
${shapeHint}
${genderHint}

All Jaxy products are sunglasses for adults, so use:
- age_group: "adults"
- lens_polarization: "non-polarized" UNLESS the product data or image clearly indicates polarized lenses

SEO title format: "<Product Name> — <Shape> Sunglasses by Jaxy" (target 50–60 characters, concise).
SEO description: 150–160 characters, include shape, colorway, and "UV400 protection, impact-resistant lenses". Always mention "Shop Jaxy" at the start.

Rules:
- Use ONLY the exact enum values listed in the schema — do not invent new ones.
- For color-pattern and eyewear-frame-color, emit 1 or 2 values (rarely more).
- For lens_color, emit exactly 1 value. Dark/tinted lenses are "black".
- Be consistent: color_pattern and eyewear_frame_color should usually match unless the frame has multiple distinct colors.

Return ONLY the JSON object, no prose.`;
}

export async function categorizeProduct(
  input: CategorizerInput,
): Promise<CategorizerResult> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return {
      output: null,
      problems: [{ field: "config", message: "GOOGLE_GEMINI_API_KEY not set" }],
      error: "Gemini API key not configured",
      model: MODEL_NAME,
    };
  }

  const prompt = buildPrompt(input);
  const schema = buildResponseSchema();

  // Assemble multimodal parts: prompt text + optional image.
  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } } | { fileData: { mimeType: string; fileUri: string } }> = [
    { text: prompt },
  ];
  if (input.imageBase64 && input.imageMimeType) {
    parts.push({ inlineData: { mimeType: input.imageMimeType, data: input.imageBase64 } });
  } else if (input.imageUrl) {
    // Gemini supports remote image URLs via fileData. If the URL 404s or
    // isn't accessible from Google's servers, the API will error and we
    // fall through to the catch below.
    parts.push({ fileData: { mimeType: "image/jpeg", fileUri: input.imageUrl } });
  }

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: schema,
      temperature: 0.2, // deterministic-ish for categorization
    },
  };

  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return {
      output: null,
      problems: [{ field: "network", message: String(e) }],
      error: `Gemini fetch failed: ${String(e)}`,
      model: MODEL_NAME,
    };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      output: null,
      problems: [{ field: "gemini", message: `${res.status}: ${text.slice(0, 500)}` }],
      error: `Gemini ${res.status}`,
      model: MODEL_NAME,
    };
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const textPart = json.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
  if (!textPart) {
    return {
      output: null,
      problems: [{ field: "gemini", message: "no text in response" }],
      rawResponse: json,
      error: "Gemini returned empty response",
      model: MODEL_NAME,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(textPart);
  } catch (e) {
    return {
      output: null,
      problems: [{ field: "gemini", message: `JSON parse failed: ${String(e)}` }],
      rawResponse: textPart,
      error: "Gemini returned invalid JSON",
      model: MODEL_NAME,
    };
  }

  const { output, problems } = validateAiCategorization(parsed);
  return { output, problems, rawResponse: parsed, model: MODEL_NAME };
}
