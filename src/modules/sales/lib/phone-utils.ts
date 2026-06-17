/**
 * Phone-number normalization.
 *
 * PhoneBurner expects 10 raw US digits — no `+`, no `1` country code,
 * no parens/spaces/dashes. (Per developer.phoneburner.com routes —
 * the `phone` field on POST /contacts.)
 *
 * Anything that's not a 10-digit US number returns null, leaving the
 * caller to decide whether to skip the lead or flag it for manual
 * review. We deliberately do NOT silently mangle international numbers
 * into US shape — Jaxy ships US-only today, but a `+44` phone that
 * slips through StoreLeads import should fail loudly rather than be
 * truncated.
 */

/** Return only the digit characters of a string. */
function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

/**
 * Normalize a phone string to PhoneBurner's expected format.
 *
 *   "+1 (555) 123-4567"  → "5551234567"
 *   "1-555-123-4567"     → "5551234567"
 *   "555-123-4567"       → "5551234567"
 *   "+44 20 7946 0958"   → null   (non-US)
 *   "123"                → null   (too short)
 *   null / "" / "abc"    → null
 */
export function formatToPbPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = digitsOnly(raw);
  // Drop a leading "1" country code if present and the rest is 10 digits.
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  if (digits.length === 10) return digits;
  return null;
}

/**
 * True when the input normalizes to a valid 10-digit US number.
 */
export function looksLikeValidUsPhone(raw: string | null | undefined): boolean {
  return formatToPbPhone(raw) !== null;
}
