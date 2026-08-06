/**
 * AJ Morgan product categorization — sunglasses vs reading glasses.
 *
 * WHY THIS MATTERS: AJM sold readers; Jaxy (until the Aug 2026 launch) sells
 * only sunglasses. On AJM's Faire channel readers were ~25% of revenue and
 * ~46% of customers bought them, so the category split is a large part of the
 * AJM-vs-Jaxy sales gap — and the reader-buyer list is the launch target list.
 *
 * The exports label categories inconsistently, so classification is layered,
 * best evidence first. Every line records WHICH rule fired (category_source)
 * so coverage is auditable rather than a black box:
 *
 *   1. faire_label   Faire product names carry an explicit suffix
 *                    ("Flanders - Optical Quality Reading Glasses").
 *   2. style_map     Style codes are shared across channels (54371-OLV on
 *                    Faire, 54371-TOR on Shopify), so Faire's labels propagate
 *                    to Shopify by SKU style code.
 *   3. diopter       "Leader - Olive / 1.75" — a lens strength only readers
 *                    have. Unambiguous.
 *   4. name_map      Style NAME learned from Faire, applied to Shopify names.
 *   5. keyword       Direct keywords in the name.
 *   6. no_detail     Lump-sum legacy orders: one line per order, an invoice
 *                    number as the product name, qty 1, no SKU (~$2.5M of
 *                    AJM's Shopify wholesale). These carry NO product data —
 *                    they are reported separately, never guessed at.
 *   7. unclassified  Everything else. Surfaced explicitly so percentages stay
 *                    honest.
 */
import { sqlite } from "@/lib/db";

export const READER_CATEGORIES = ["reading", "blue_light", "sunglass_reader"] as const;
export type AjmCategory =
  | "sun" | "reading" | "blue_light" | "sunglass_reader"
  | "accessory" | "no_detail" | "unclassified";

/** Is this category a reading-glasses product of any kind? */
export function isReader(c: string | null | undefined): boolean {
  return !!c && (READER_CATEGORIES as readonly string[]).includes(c);
}

export const CATEGORY_LABEL: Record<string, string> = {
  sun: "Sunglasses",
  reading: "Reading glasses",
  blue_light: "Blue-light readers",
  sunglass_reader: "Sunglass/bifocal readers",
  accessory: "Accessories",
  no_detail: "No line detail (legacy lump order)",
  unclassified: "Unclassified",
};

/** Style code = the leading token of a SKU ("54234R1-TOR" → "54234R1"). */
export function styleCodeOf(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const t = String(sku).split(/[-\s/]/)[0]?.trim().toUpperCase();
  return t && t.length >= 3 ? t : null;
}

/** Style name = text before the first " - " ("Classroom - Olive" → "classroom"). */
export function styleNameOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = String(name);
  const cut = s.indexOf(" - ");
  const head = (cut > 0 ? s.slice(0, cut) : s).trim().toLowerCase();
  return head.length >= 3 && /[a-z]/.test(head) ? head : null;
}

/** Category from explicit words in a product name. Null when nothing matches. */
export function categoryFromName(name: string | null | undefined): AjmCategory | null {
  const n = (name ?? "").toUpperCase();
  if (!n) return null;
  // Order matters: "BIFOCAL SUNGLASS READER" must not fall through to "SUNGLASS".
  if (n.includes("SUNGLASS READER") || n.includes("SUN READER") || n.includes("BIFOCAL")) return "sunglass_reader";
  if ((n.includes("BLUE LIGHT") || n.includes("BLUE-LIGHT") || n.includes("COMPUTER")) && /READ|GLASS/.test(n)) return "blue_light";
  if (n.includes("READER") || n.includes("READING")) return "reading";
  if (n.includes("SUNGLASS")) return "sun";
  if (/MICROFIBER|DRAWSTRING|DISPLAY|POUCH|\bCASE\b|CLEANER|LANYARD|CHAIN|TESTER|SPINNER/.test(n)) return "accessory";
  return null;
}

/** A lens-strength token ("/ 1.75", "+2.00") only appears on readers. */
export function hasDiopter(name: string | null | undefined): boolean {
  const s = String(name ?? "");
  return /(^|[\s/+])[+]?[123]\.\d{2}(\s|$|\/)/.test(s) || /\/\s*[123]\.\d{1,2}\b/.test(s);
}

/**
 * Lump-sum legacy line — one line standing in for a whole order, with no
 * product data at all. Two observed shapes, both with no SKU and qty 1:
 *   "282705"              a bare invoice/PO number
 *   "Invoice # 261544"    the same thing, spelled out ("Inv # 289708-710",
 *                         "INVOICE 262954")
 * These can never be categorized, so they get their own bucket rather than
 * polluting the sun/reader split.
 *
 * NOTE: style-code numeric bands were evaluated as a category predictor and
 * REJECTED — against labeled Faire data the major bands were only 52–69% pure
 * (3xxxx 64%, 5xxxx 56%, 6xxxx 69%), so inferring from them would be closer to
 * guessing than measuring. Lines we cannot evidence stay "unclassified".
 */
export function isNoDetailLine(name: string | null | undefined, sku: string | null | undefined, qty: number): boolean {
  const n = (name ?? "").trim();
  if (sku || qty > 1) return false;
  if (/^[0-9]{4,}/.test(n)) return true;
  return /^(inv|invoice)\b[\s#.:]*[0-9]/i.test(n);
}

export interface CategorizeResult {
  updated: number;
  byCategory: Array<{ category: string; lines: number; units: number; revenue: number }>;
  bySource: Array<{ category_source: string; lines: number; revenue: number }>;
  coverage: { classifiedRevenue: number; noDetailRevenue: number; unclassifiedRevenue: number; totalRevenue: number };
}

/**
 * Classify every AJM line item. Idempotent — safe to re-run after new imports
 * (a fresh import adds rows with NULL category; this fills them and refreshes
 * existing ones, since the learned maps improve as more data lands).
 */
export function categorizeAjmItems(): CategorizeResult {
  // ── Learn maps from the labeled Faire lines ──
  const labeled = sqlite.prepare(`
    SELECT i.sku, i.product_name AS name, SUM(i.quantity) AS units
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.source = 'faire'
    GROUP BY i.sku, i.product_name
  `).all() as Array<{ sku: string | null; name: string | null; units: number }>;

  // style code/name → category votes weighted by units (a style's dominant
  // category wins; guards against a one-off mislabeled line).
  const styleVotes = new Map<string, Map<string, number>>();
  const nameVotes = new Map<string, Map<string, number>>();
  const vote = (m: Map<string, Map<string, number>>, key: string, cat: string, units: number) => {
    const inner = m.get(key) ?? m.set(key, new Map()).get(key)!;
    inner.set(cat, (inner.get(cat) ?? 0) + units);
  };
  for (const r of labeled) {
    const cat = categoryFromName(r.name);
    if (!cat || cat === "unclassified") continue;
    const sc = styleCodeOf(r.sku);
    if (sc) vote(styleVotes, sc, cat, Number(r.units) || 1);
    const sn = styleNameOf(r.name);
    if (sn) vote(nameVotes, sn, cat, Number(r.units) || 1);
  }
  const pick = (m: Map<string, Map<string, number>>) => {
    const out = new Map<string, string>();
    for (const [k, votes] of m) {
      const best = [...votes].sort((a, b) => b[1] - a[1])[0];
      if (best) out.set(k, best[0]);
    }
    return out;
  };
  const styleMap = pick(styleVotes);
  const nameMap = pick(nameVotes);

  // ── Classify every line ──
  const rows = sqlite.prepare(
    "SELECT id, sku, product_name AS name, quantity FROM ajm_order_items",
  ).all() as Array<{ id: string; sku: string | null; name: string | null; quantity: number }>;

  const upd = sqlite.prepare("UPDATE ajm_order_items SET category = ?, category_source = ?, style_code = ? WHERE id = ?");
  let updated = 0;
  const run = sqlite.transaction(() => {
    for (const r of rows) {
      const sc = styleCodeOf(r.sku);
      let cat: AjmCategory | null = null;
      let src = "";

      const named = categoryFromName(r.name);
      if (named) { cat = named; src = "faire_label"; }
      if (!cat && sc && styleMap.has(sc)) { cat = styleMap.get(sc) as AjmCategory; src = "style_map"; }
      if (!cat && hasDiopter(r.name)) { cat = "reading"; src = "diopter"; }
      if (!cat) {
        const sn = styleNameOf(r.name);
        if (sn && nameMap.has(sn)) { cat = nameMap.get(sn) as AjmCategory; src = "name_map"; }
      }
      if (!cat && isNoDetailLine(r.name, r.sku, Number(r.quantity) || 0)) { cat = "no_detail"; src = "no_detail"; }
      if (!cat) { cat = "unclassified"; src = "none"; }

      upd.run(cat, src, sc, r.id);
      updated++;
    }
  });
  run();

  // ── Report coverage (non-cancelled orders only) ──
  const byCategory = sqlite.prepare(`
    SELECT i.category, COUNT(*) AS lines, SUM(i.quantity) AS units, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0
    GROUP BY i.category ORDER BY revenue DESC
  `).all() as CategorizeResult["byCategory"];
  const bySource = sqlite.prepare(`
    SELECT i.category_source, COUNT(*) AS lines, ROUND(SUM(i.line_total), 2) AS revenue
    FROM ajm_order_items i JOIN ajm_orders o ON o.id = i.order_id
    WHERE o.cancelled = 0
    GROUP BY i.category_source ORDER BY revenue DESC
  `).all() as CategorizeResult["bySource"];

  const total = byCategory.reduce((s, r) => s + (r.revenue || 0), 0);
  const noDetail = byCategory.find((r) => r.category === "no_detail")?.revenue ?? 0;
  const unclassified = byCategory.find((r) => r.category === "unclassified")?.revenue ?? 0;

  return {
    updated,
    byCategory,
    bySource,
    coverage: {
      classifiedRevenue: Math.round((total - noDetail - unclassified) * 100) / 100,
      noDetailRevenue: noDetail,
      unclassifiedRevenue: unclassified,
      totalRevenue: Math.round(total * 100) / 100,
    },
  };
}
