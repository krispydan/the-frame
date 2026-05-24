/**
 * Map a product's curated attributes (derived from catalog_tags) to
 * Amazon's enum-validated category columns. Returns the literal enum
 * string Amazon expects, or null when no confident mapping exists — the
 * validator catches null required fields as blocked issues so we never
 * silently ship a wrong value.
 *
 * The AI vision pipeline can override any of these via the
 * suggestedFrameMaterial / suggestedLensMaterial / suggestedPolarization
 * / suggestedItemShape columns on catalog_amazon_listings — it sees the
 * actual photos and is generally better than tag-derived defaults. The
 * column-mapper uses suggested* when populated, falls back to these.
 */
import type { CuratedAttrs } from "@/modules/catalog/lib/curated-attributes";
import { findEnumValue } from "./template-snapshot";

/**
 * Map curated frameShape tag → item_shape enum value. Amazon's enum
 * includes Aviator, Browline, Butterfly, Cat-Eye, Geometric, Hexagonal,
 * Oval, Oversized, Rectangular, Round, Shield, Square, Wayfarer, etc.
 * We normalise our tag values (lowercase, hyphenated) and let
 * findEnumValue do case-insensitive matching against the snapshot.
 */
export function mapItemShape(frameShape: string | null): string | null {
  if (!frameShape) return null;
  const v = frameShape.trim().toLowerCase();
  // Our tag presets use "cat-eye"; Amazon uses "Cat Eye" (with space). Try both.
  const candidates = [
    v,
    v.replace(/-/g, " "),
    v.replace(/-/g, ""),
    // Common one-off normalisations
    v === "cateye" ? "Cat Eye" : v,
    v === "rectangle" ? "Rectangular" : v,
    v === "oversized" ? "Oversized" : v,
  ];
  for (const c of candidates) {
    const matched = findEnumValue("item_shape", c);
    if (matched) return matched;
  }
  return null;
}

/**
 * Map curated frameMaterial tag → frame_material_type enum. Amazon only
 * accepts Wood, Plastic, Metal, Rubber — so acetate, TR90, and similar
 * synthetic frame plastics all map to Plastic. Our tag presets use
 * "acetate", "metal", "plastic", "wood".
 */
export function mapFrameMaterial(frameMaterial: string | null): string | null {
  if (!frameMaterial) return null;
  const v = frameMaterial.trim().toLowerCase();
  if (["acetate", "plastic", "tr90", "polycarbonate", "nylon", "resin"].includes(v)) return "Plastic";
  if (["metal", "steel", "titanium", "aluminum", "stainless"].includes(v)) return "Metal";
  if (["wood", "bamboo", "wooden"].includes(v)) return "Wood";
  if (["rubber", "silicone"].includes(v)) return "Rubber";
  // Catch-all: try the snapshot's case-insensitive matcher.
  return findEnumValue("frame_material_type", v);
}

/**
 * Map curated lensType tag → lens_material_type enum. Amazon's list is
 * Gradient, Nylon, Glass, Plastic, Polarized, Acetate, Mirrored, Resin,
 * TAC, Photochromic, PVC, Polycarbonate, Acrylic. Our tag presets put
 * "polarized" and "uv400" under dimension=lens; those imply a coating
 * more than a material so we map polarized → Polarized (the lens
 * material AND the polarization_type column both accept it) and let the
 * AI override with a real material when it sees the photo.
 */
export function mapLensMaterial(lensType: string | null): string | null {
  if (!lensType) return null;
  const v = lensType.trim().toLowerCase();
  if (v === "polarized") return "Polarized";
  if (v === "uv400") return null; // not a material — leave for AI / suggested*
  return findEnumValue("lens_material_type", v);
}

/**
 * polarization_type enum: Mirrored, Non-Polarized, Polarized. We default
 * Non-Polarized when no polarized tag is present — that's the safe Amazon
 * answer (over-claiming polarization is a return-rate / review risk).
 */
export function mapPolarizationFromTags(tagSet: Set<string>): "Polarized" | "Mirrored" | "Non-Polarized" {
  if (tagSet.has("polarized")) return "Polarized";
  if (tagSet.has("mirrored") || tagSet.has("mirror")) return "Mirrored";
  return "Non-Polarized";
}

/** Map curated gender → target_gender enum (Unisex, Female, Male). */
export function mapTargetGender(gender: string | null): "Unisex" | "Female" | "Male" | null {
  if (!gender) return null;
  const v = gender.trim().toLowerCase();
  if (["women", "womens", "female", "ladies"].includes(v)) return "Female";
  if (["men", "mens", "male"].includes(v)) return "Male";
  if (["unisex", "uni"].includes(v)) return "Unisex";
  return null;
}

/** Map curated category → Amazon department_name. */
export function mapDepartmentName(gender: string | null): string {
  const tg = mapTargetGender(gender);
  if (tg === "Female") return "womens";
  if (tg === "Male") return "mens";
  return "unisex-adult";
}

/**
 * Pull all tag names into a lowercase set so callers can do membership
 * checks without re-iterating the rows.
 */
export function tagSetFromRows(
  rows: Array<{ tagName: string | null; dimension: string | null }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const n = (r.tagName ?? "").trim().toLowerCase();
    if (n) out.add(n);
  }
  return out;
}

/**
 * Collect free-text keywords for the generic_keywords column. We pull
 * everything under dimension='keyword' (curated by the SEO flow,
 * already filtered against FORBIDDEN_TERMS) plus the curated attribute
 * values. Joined with space because Amazon parses generic_keywords as
 * whitespace-delimited search terms.
 */
export function buildGenericKeywords(opts: {
  rows: Array<{ tagName: string | null; dimension: string | null }>;
  curated: CuratedAttrs;
}): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | null | undefined) => {
    const v = (raw ?? "").trim().toLowerCase();
    if (!v) return;
    if (seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const r of opts.rows) {
    if ((r.dimension ?? "").toLowerCase() === "keyword") add(r.tagName);
  }
  add(opts.curated.frameShape);
  add(opts.curated.frameMaterial);
  add(opts.curated.gender);
  add(opts.curated.lensType);
  // Amazon caps generic_keywords at ~250 bytes; keep us under that.
  let total = 0;
  const result: string[] = [];
  for (const term of out) {
    if (total + term.length + 1 > 240) break;
    result.push(term);
    total += term.length + 1;
  }
  return result.join(" ");
}
