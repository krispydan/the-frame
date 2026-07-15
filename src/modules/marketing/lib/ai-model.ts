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
const DEFAULT_MODEL = "claude-opus-4-1-20250805";

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
export function skuMatchModel(): string {
  const m =
    process.env.MARKETING_SKU_MATCH_MODEL ||
    process.env.ANTHROPIC_VISION_MODEL ||
    "claude-haiku-4-5-20251001";
  if (!skuMatchLogged) {
    skuMatchLogged = true;
    console.info(`[sku-match] AI model: ${m}`);
  }
  return m;
}
