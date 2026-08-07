/**
 * Centralized AI model selection for the marketing-email pipeline.
 *
 * Was: an undated, hardcoded `claude-opus-4-7` in email-ai.ts with no
 * override. Every other AI caller in this repo uses a dated, known-valid
 * id. If that id ever stops resolving (or runs on a key without access)
 * every generation 502s with no fallback and no way to switch without a
 * code change. This makes the choice explicit and env-overridable.
 *
 * Override with MARKETING_EMAIL_MODEL (preferred) or ANTHROPIC_MODEL.
 */

// Known-valid default (matches the catalog AI callers in this repo).
// Bump via env once the account has access to a newer model — no code
// change needed.
// claude-opus-4-1 was retired and started 404ing (Aug 2026);
// sonnet-4-6 is what the sales AI callers run on in production.
const DEFAULT_MODEL = "claude-sonnet-4-6";

let logged = false;

export function emailModel(): string {
  const m =
    process.env.MARKETING_EMAIL_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    DEFAULT_MODEL;
  if (!logged) {
    logged = true;
    console.info(`[marketing-email] AI model: ${m}`);
  }
  return m;
}

let videoLogged = false;

/** Model for video caption/instruction generation. Same fallback chain
 *  as email, with its own env override so the two can diverge. */
export function videoModel(): string {
  const m =
    process.env.MARKETING_VIDEO_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    DEFAULT_MODEL;
  if (!videoLogged) {
    videoLogged = true;
    console.info(`[marketing-video] AI model: ${m}`);
  }
  return m;
}

let skuMatchLogged = false;

/**
 * Model for AI SKU identification (vision matching media vs the catalog).
 * Runs at volume over a whole library and is human-reviewed, so it
 * defaults to the CHEAP vision model (Haiku) rather than Opus. Override
 * with MARKETING_SKU_MATCH_MODEL (e.g. bump to Sonnet if accuracy needs it).
 */
export const DEFAULT_SKU_MATCH_MODEL = "gemini-2.5-flash-lite";

export function skuMatchModel(): string {
  const m =
    process.env.MARKETING_SKU_MATCH_MODEL ||
    process.env.ANTHROPIC_VISION_MODEL ||
    DEFAULT_SKU_MATCH_MODEL;
  if (!skuMatchLogged) {
    skuMatchLogged = true;
    console.info(
      `[sku-match] AI model: ${m} (${visionProvider(m)}, ${isCheapVisionModel(m) ? "cheap tier" : "EXPENSIVE TIER"})`,
    );
  }
  return m;
}

export type VisionProvider = "gemini" | "anthropic";

/**
 * Which API a model id belongs to. Anthropic is still supported so the
 * old model can be restored with one env var if Gemini's accuracy on
 * frame shapes turns out worse.
 */
export function visionProvider(model: string): VisionProvider {
  return /^gemini/i.test(model) ? "gemini" : "anthropic";
}

/**
 * Kill switch. Set SKU_MATCH_DISABLED=1 and every vision call returns an
 * error without touching the API — nothing can spend, whatever is queued.
 * Checked per call, not cached, so it takes effect the moment the env
 * changes (or a redeploy lands) even mid-batch.
 */
export function skuMatchDisabled(): boolean {
  const v = process.env.SKU_MATCH_DISABLED;
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Ceiling for ONE bulk identification run, in USD. The run stops when it
 * crosses this. Default is deliberately small: a batch over a whole clip
 * library is the only thing here that can spend real money unattended.
 */
export function skuMatchMaxUsd(): number {
  const n = Number(process.env.SKU_MATCH_MAX_USD);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * USD per MILLION tokens, by model. Costs were previously computed with
 * Haiku's prices hardcoded no matter which model ran — so a run on Opus
 * logged about 1/15th of what it actually billed, and the overspend was
 * invisible until the invoice. Pricing is looked up by model id now, and
 * an unknown id is assumed EXPENSIVE rather than cheap.
 */
interface ModelPrice {
  inPerM: number;
  outPerM: number;
  /** Multipliers on the input rate for prompt-cache writes/reads. */
  cacheWriteMult: number;
  cacheReadMult: number;
  cheap: boolean;
}

const ANTHROPIC_CACHE = { cacheWriteMult: 1.25, cacheReadMult: 0.1 };
// Gemini's implicit cache costs nothing to write and reads at 90% off.
const GEMINI_CACHE = { cacheWriteMult: 0, cacheReadMult: 0.1 };

// Order matters — first regex wins, so put the more specific ids first.
const MODEL_PRICING: Array<{ match: RegExp; price: ModelPrice }> = [
  { match: /^gemini-2\.5-flash-lite/i, price: { inPerM: 0.1, outPerM: 0.4, ...GEMINI_CACHE, cheap: true } },
  { match: /^gemini-2\.5-flash/i, price: { inPerM: 0.3, outPerM: 2.5, ...GEMINI_CACHE, cheap: true } },
  { match: /^gemini-3\.1-flash-lite/i, price: { inPerM: 0.25, outPerM: 1.5, ...GEMINI_CACHE, cheap: true } },
  { match: /^gemini-3\.5-flash-lite/i, price: { inPerM: 0.3, outPerM: 2.5, ...GEMINI_CACHE, cheap: true } },
  { match: /haiku/i, price: { inPerM: 1, outPerM: 5, ...ANTHROPIC_CACHE, cheap: true } },
  { match: /sonnet/i, price: { inPerM: 3, outPerM: 15, ...ANTHROPIC_CACHE, cheap: false } },
  { match: /opus/i, price: { inPerM: 15, outPerM: 75, ...ANTHROPIC_CACHE, cheap: false } },
];

/** Unknown ids fall back to the priciest tier — never under-report. */
const UNKNOWN_PRICE: ModelPrice = { inPerM: 15, outPerM: 75, ...ANTHROPIC_CACHE, cheap: false };

export function modelPricing(model: string): ModelPrice {
  return MODEL_PRICING.find((p) => p.match.test(model))?.price ?? UNKNOWN_PRICE;
}

export function isCheapVisionModel(model: string): boolean {
  return modelPricing(model).cheap;
}
