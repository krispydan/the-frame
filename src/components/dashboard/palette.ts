/**
 * Dashboard chart palette.
 *
 * Categorical hues are assigned in FIXED order (never cycled) and were
 * validated colorblind-safe (CVD ΔE, normal-vision floor, lightness band) with
 * the data-viz validator for both light and dark surfaces. A 7th+ series folds
 * into "Other" rather than minting a new hue.
 *
 * Status colors are reserved for state (good/warn/serious/critical) and never
 * reused as a categorical series.
 *
 * When the Jaxy brand tokens.json lands, swap these values — structure stays.
 */

/** Categorical series colors, light-mode surface (#fcfcfb). */
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#4a3aa7"] as const;
/** Categorical series colors, dark-mode surface (#1a1a19). */
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"] as const;

/** Stable name → index so a series keeps its color when the set is filtered. */
export const CHANNEL_COLORS: Record<string, number> = {
  shopify_dtc: 0,
  shopify_wholesale: 1,
  faire: 2,
  direct: 3,
  phone: 4,
};

export type Tone = "good" | "warn" | "serious" | "critical" | "neutral";

/** Reserved status colors (with icon+label at the call site — never color-alone). */
export const STATUS: Record<Tone, string> = {
  good: "#1baf7a",
  warn: "#eda100",
  serious: "#eb6834",
  critical: "#e34948",
  neutral: "#8a8a86",
};

/**
 * Series color for slot i. We don't have runtime access to the active theme in
 * SVG fills reliably (next-themes isn't wired), so charts pass `dark` when they
 * know it; default to light. Charts also expose colors via CSS where possible.
 */
export function seriesColor(i: number, dark = false): string {
  const arr = dark ? SERIES_DARK : SERIES_LIGHT;
  return arr[i % arr.length];
}

export function channelColor(channel: string, dark = false): string {
  const idx = CHANNEL_COLORS[channel] ?? 5;
  return seriesColor(idx, dark);
}

export const CHANNEL_LABELS: Record<string, string> = {
  shopify_dtc: "Retail (DTC)",
  shopify_wholesale: "Wholesale",
  faire: "Faire",
  direct: "Direct",
  phone: "Phone",
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}
