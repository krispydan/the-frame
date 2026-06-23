/**
 * Central brand-context loader. The single reader of the snapshotted
 * brand docs so that email-ai.ts and the MCP get_brand_context tool
 * never drift in how they load/section the voice.
 *
 * Files are read once and cached for the process lifetime (small docs,
 * refreshed from Google Drive via scripts/sync-brand-context.sh).
 */

import fs from "fs";
import path from "path";

const BRAND_DIR = path.join(process.cwd(), "src", "modules", "marketing", "brand-context");

function readSafe(file: string): string {
  try {
    return fs.readFileSync(path.join(BRAND_DIR, file), "utf-8");
  } catch (e) {
    console.warn(`[brand-context] missing ${file}`, e);
    return "";
  }
}

export interface BrandContext {
  brandBible: string;
  wholesaleVoice: string;
  visualGuidelines: string;
  photoAesthetic: string;
}

let cached: BrandContext | null = null;

export function loadBrandContext(): BrandContext {
  if (cached) return cached;
  cached = {
    brandBible: readSafe("brand-bible.md"),
    wholesaleVoice: readSafe("wholesale-voice.md"),
    visualGuidelines: readSafe("visual-guidelines.md"),
    photoAesthetic: readSafe("photography-aesthetic.md"),
  };
  return cached;
}

/**
 * The brand bible is long; its voice section (§5) is the densest signal.
 * Snip just that part for the retail prompt so we don't burn tokens on
 * mission/positioning.
 */
export function brandBibleVoiceSection(bible: string): string {
  const start = bible.indexOf("## 5. Brand Voice");
  if (start < 0) return bible;
  const end = bible.indexOf("## 6.", start);
  return end > 0 ? bible.slice(start, end) : bible.slice(start);
}

/** The voice doc for an audience: retail → bible §5, wholesale → its doc. */
export function voiceFor(audience: "retail" | "wholesale"): string {
  const ctx = loadBrandContext();
  return audience === "wholesale"
    ? ctx.wholesaleVoice
    : brandBibleVoiceSection(ctx.brandBible);
}
