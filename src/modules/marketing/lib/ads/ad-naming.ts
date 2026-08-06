/**
 * The ad naming convention — the performance-tracking key.
 *
 * Every ad's name encodes what it IS, because the name is what you see
 * (and can break down by) in Meta Ads Manager after manual upload:
 *
 *   JX_{RECIPE}_{FMT}_{PRODUCT}-{COLOR}_{MODEL}_{COPY}_{vNN}
 *   e.g. JX_PCARD_VID_BOULEVARD-BLK_JADE_C00_v01
 *
 * Render files append the ratio: ..._v01_4x5.mp4. Names are generated,
 * never typed, and `parseAdName` round-trips `buildAdName` exactly —
 * that parseability is what makes a future metrics report free (slice
 * spend/CTR by any segment without a schema for it).
 *
 * Segments are A–Z0–9 only; `_` separates segments and `-` joins
 * product to colour, so both characters are stripped from within
 * segment values.
 */
import type { AdRatio } from "./ratios";

export type AdFormat = "IMG" | "VID" | "CAR";

export const KIND_TO_FORMAT: Record<string, AdFormat> = {
  image: "IMG",
  video: "VID",
  carousel: "CAR",
};

/**
 * Talent → short code. Known models get stable readable codes; anyone
 * new falls back to first word, A–Z0–9, max 6 chars — add them here
 * when they become regulars so the code is chosen, not derived.
 */
const TALENT_CODES: Record<string, string> = {
  missjademonet: "JADE",
  daria: "DARIA",
  "shianne bateman": "SHIA",
};

export function talentCode(talent: string | null | undefined): string {
  const t = (talent ?? "").trim().toLowerCase();
  if (!t || t === "none") return "NONE";
  if (TALENT_CODES[t]) return TALENT_CODES[t];
  const first = t.split(/\s+/)[0].replace(/[^a-z0-9]/gi, "").toUpperCase();
  return first.slice(0, 6) || "NONE";
}

/** A segment value: A–Z0–9 only, so separators stay unambiguous. */
function seg(v: string, max: number): string {
  return v.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, max);
}

/**
 * Colour code from the SKU string — its last dash segment (JX4011-S-BLK
 * → BLK). SKU suffixes are already stable short codes; deriving from
 * color_name ("Tortoise") would invent a second vocabulary.
 */
export function colorCodeFromSku(sku: string): string {
  const parts = sku.split("-").filter(Boolean);
  return seg(parts[parts.length - 1] ?? "", 6) || "NA";
}

export interface AdNameInput {
  recipe: string;        // registry slug, e.g. 'pcard'
  kind: "image" | "video" | "carousel";
  productName: string;   // catalog product name
  sku: string;           // full SKU string, colour code derived
  talent?: string | null;
  copyVariant?: string;  // 'C00' | 'C01' | …
  version?: number;      // ≥1
}

export function buildAdName(input: AdNameInput): string {
  const recipe = seg(input.recipe, 8);
  const fmt = KIND_TO_FORMAT[input.kind];
  const product = seg(input.productName, 10) || "PRODUCT";
  const color = colorCodeFromSku(input.sku);
  const model = talentCode(input.talent);
  const copy = /^C\d{2}$/.test(input.copyVariant ?? "") ? input.copyVariant! : "C00";
  const version = Math.max(1, Math.floor(input.version ?? 1));
  return `JX_${recipe}_${fmt}_${product}-${color}_${model}_${copy}_v${String(version).padStart(2, "0")}`;
}

/** File name for one render: name + ratio + extension. */
export function renderFileName(adName: string, ratio: AdRatio, kind: "image" | "video"): string {
  return `${adName}_${ratio}.${kind === "video" ? "mp4" : "jpg"}`;
}

export interface ParsedAdName {
  recipe: string;
  format: AdFormat;
  product: string;
  color: string;
  model: string;
  copyVariant: string;
  version: number;
  /** Present when parsing a render file name rather than an ad name. */
  ratio?: string;
}

const NAME_RE =
  /^JX_([A-Z0-9]+)_(IMG|VID|CAR)_([A-Z0-9]+)-([A-Z0-9]+)_([A-Z0-9]+)_(C\d{2})_v(\d{2})(?:_(\d+x\d+))?(?:\.[a-z0-9]+)?$/;

export function parseAdName(name: string): ParsedAdName | null {
  const m = NAME_RE.exec(name.trim());
  if (!m) return null;
  return {
    recipe: m[1],
    format: m[2] as AdFormat,
    product: m[3],
    color: m[4],
    model: m[5],
    copyVariant: m[6],
    version: parseInt(m[7], 10),
    ...(m[8] ? { ratio: m[8] } : {}),
  };
}
