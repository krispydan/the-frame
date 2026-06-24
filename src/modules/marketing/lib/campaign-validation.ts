/**
 * Write-time validation for campaign PATCH/POST. The renderer degrades
 * gracefully on bad enums, but we don't want junk in the row — a bad
 * variant breaks the strategy/export assumptions and a non-URL CTA
 * ships a broken link. Pure + testable.
 */

const ENUMS: Record<string, readonly string[]> = {
  audience: ["retail", "wholesale"],
  heroVariant: ["full_bleed_overlay", "image_75_solid", "split_50_50"],
  sectionAVariant: ["centered", "with_pullquote"],
  secondaryImageVariant: ["full_bleed", "centered_75", "grid_2up"],
  sectionBVariant: ["centered_with_cta", "two_column_with_cta"],
  heroScrim: ["dark", "light", "none"],
};

const URL_FIELDS = ["heroCtaUrl", "sectionBCtaUrl"] as const;

// Sanity length caps (the linter handles brand-tuned limits; these stop
// pathological writes).
const MAX_LEN: Record<string, number> = {
  subject: 120,
  preheader: 200,
  heroHeadline: 200,
  heroSubtitle: 400,
  sectionAHeading: 200,
  sectionBHeading: 200,
  sectionABody: 4000,
  sectionBBody: 4000,
  briefTitle: 300,
  briefAngle: 2000,
};

function isHttpOrEmpty(v: string): boolean {
  const s = v.trim();
  // http(s), mailto:, tel:, the "#" placeholder, or empty. Wholesale
  // CTAs are frequently mailto (Christina), so those must pass.
  return (
    s === "" ||
    s === "#" ||
    /^https?:\/\/[^\s]+/.test(s) ||
    /^mailto:[^\s@]+@[^\s]+/.test(s) ||
    /^tel:[+\d][\d\s().-]*$/.test(s)
  );
}

/** Returns a list of validation errors for the patch body (empty = ok). */
export function validateCampaignPatch(body: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const [field, allowed] of Object.entries(ENUMS)) {
    const v = body[field];
    if (v !== undefined && v !== null && !allowed.includes(String(v))) {
      errors.push(`${field} must be one of: ${allowed.join(", ")} (got "${String(v)}")`);
    }
  }

  for (const field of URL_FIELDS) {
    const v = body[field];
    if (typeof v === "string" && !isHttpOrEmpty(v)) {
      errors.push(`${field} must be an http(s) URL (got "${v}")`);
    }
  }

  for (const [field, max] of Object.entries(MAX_LEN)) {
    const v = body[field];
    if (typeof v === "string" && v.length > max) {
      errors.push(`${field} exceeds ${max} characters`);
    }
  }

  if (typeof body.scheduledDate === "string" && body.scheduledDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.scheduledDate)) {
    errors.push("scheduledDate must be YYYY-MM-DD");
  }

  return errors;
}
