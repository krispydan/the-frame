/**
 * Centralized AI model selection for the marketing-email pipeline.
 *
 * Why this exists: the pipeline previously hard-coded an unversioned
 * model id that is not a valid Anthropic API model ("claude-opus-4-7"),
 * which would 4xx on every generation in production. Every other AI
 * call in this repo uses a dated, valid id. This module makes the
 * choice explicit, overridable, and consistent.
 *
 * Override with MARKETING_EMAIL_MODEL (preferred) or ANTHROPIC_MODEL.
 * The default is a known-valid, high-capability Opus id already used
 * elsewhere in the codebase. To move to a newer model, set the env var
 * — no code change required.
 */

// Known-valid default (matches src/modules/catalog/lib/seo/ai-generate.ts).
// Bump via env (e.g. MARKETING_EMAIL_MODEL=claude-opus-4-8) once the
// account has access — keeping a proven default avoids breaking
// generation if a newer id isn't enabled on the API key.
const DEFAULT_MODEL = "claude-opus-4-1-20250805";

let logged = false;

export function emailModel(): string {
  const m =
    process.env.MARKETING_EMAIL_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    DEFAULT_MODEL;
  if (!logged) {
    logged = true;
    // One-time visibility into which model the pipeline is using.
    console.info(`[marketing-email] AI model: ${m}`);
  }
  return m;
}

export const ANTHROPIC_VERSION = "2023-06-01";
