/**
 * Prompt Engine — ported from ~/jaxy-catalog-tool/src/lib/prompt-engine.ts
 * Handles style detection and prompt construction for AI image/copy generation.
 */

export type StyleCategory = "retro" | "sporty" | "professional" | "fashion" | "casual";

export interface ProductContext {
  productId: string;
  skuPrefix: string;
  name: string | null;
  category: "sunglasses" | "optical" | "reading";
  frameShape: string | null;
  frameMaterial: string | null;
  gender: string | null;
  lensType: string | null;
  colors: string[];
  styleCategory: StyleCategory;
  tags: Record<string, string[]>;
}

const STYLE_KEYWORDS: Record<StyleCategory, string[]> = {
  retro: ["retro", "vintage", "round", "oval", "keyhole", "browline", "classic", "tortoise", "tortoiseshell", "havana", "acetate", "clubmaster"],
  sporty: ["sport", "sporty", "athletic", "wrap", "shield", "rectangular", "active", "running", "cycling", "polarized", "mirrored"],
  professional: ["professional", "classic", "rectangular", "square", "metal", "titanium", "rimless", "semi-rimless", "business", "office"],
  fashion: ["fashion", "bold", "oversized", "cat-eye", "cat eye", "geometric", "butterfly", "aviator", "statement", "trendy", "gradient"],
  casual: ["casual", "everyday", "wayfarer", "round", "simple", "lightweight", "comfortable", "versatile"],
};

export function detectStyleCategory(product: {
  frameShape?: string | null;
  frameMaterial?: string | null;
  gender?: string | null;
  lensType?: string | null;
  tags?: Record<string, string[]>;
}): StyleCategory {
  const allText = [
    product.frameShape, product.frameMaterial, product.gender, product.lensType,
    ...(product.tags?.style || []), ...(product.tags?.activity || []), ...(product.tags?.frameShape || []),
  ].filter(Boolean).join(" ").toLowerCase();

  const scores: Record<StyleCategory, number> = { retro: 0, sporty: 0, professional: 0, fashion: 0, casual: 0 };
  for (const [category, keywords] of Object.entries(STYLE_KEYWORDS)) {
    for (const keyword of keywords) {
      if (allText.includes(keyword)) scores[category as StyleCategory]++;
    }
  }

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? (best[0] as StyleCategory) : "casual";
}

const MODEL_DESCRIPTIONS = [
  "a young woman in her mid-20s with warm brown skin and curly dark hair",
  "a man in his late 20s with light skin, stubble, and wavy brown hair",
  "a woman in her early 30s with East Asian features and sleek black hair",
  "a man in his mid-20s with dark brown skin and a clean fade haircut",
  "a woman in her late 20s with olive skin and auburn hair",
  "a man in his early 30s with South Asian features and short dark hair",
  "a woman in her mid-35s with fair freckled skin and red hair",
  "a man in his late 20s with medium brown skin and a short beard",
  "a woman in her early 20s with light brown skin and long braids",
  "a man in his mid-30s with East Asian features and modern styled hair",
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

export function getModelDescription(productId: string, sceneIndex: number): string {
  const seed = hashString(productId) + sceneIndex;
  return MODEL_DESCRIPTIONS[Math.abs(seed) % MODEL_DESCRIPTIONS.length];
}

export function buildProductDescription(context: ProductContext): string {
  return [context.name, context.frameShape, context.frameMaterial, context.category].filter(Boolean).join(" ");
}

/** Copy generation prompt templates */
export const COPY_PROMPTS = {
  description: (name: string, details: string) =>
    `Write a compelling product description for "${name}" sunglasses by Jaxy. Details: ${details}. Keep it 2-3 paragraphs, focus on style and lifestyle appeal. Brand voice: confident, approachable, modern.`,
  
  shortDescription: (name: string, details: string) =>
    `Write a short product description (1-2 sentences, max 160 chars) for "${name}" by Jaxy. Details: ${details}.`,

  bulletPoints: (name: string, details: string) =>
    `Write 5 bullet points for "${name}" sunglasses by Jaxy. Details: ${details}. Each bullet should highlight a key feature or benefit. Keep each bullet under 100 characters.`,

  seoTitle: (name: string, category: string) =>
    `Write an SEO-optimized title for "${name}" ${category} by Jaxy. Max 60 characters. Include brand name.`,

  metaDescription: (name: string, details: string) =>
    `Write an SEO meta description for "${name}" by Jaxy. Details: ${details}. Max 160 characters. Include a call to action.`,

  productName: (details: string) =>
    `Suggest 5 creative product names for sunglasses with these details: ${details}. Names should be: short (1-2 words), evocative, memorable, and work for a modern eyewear brand called Jaxy. Return as a JSON array of strings.`,
};
