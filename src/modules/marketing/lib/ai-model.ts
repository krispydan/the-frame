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
