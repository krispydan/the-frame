/**
 * AJ Morgan Faire export → segmented reactivation call lists.
 *
 * Ingests the AJM Faire customer export (Store Name / Contact / Email / Email
 * from AI / Order Volume / Total Orders / Last Ordered / Store Type) and, using
 * the frame to exclude anyone who has ALREADY ordered with Jaxy, produces two
 * value-segmented cohorts for the pre-Faire-Marketplace calling push:
 *   - high spend  → Christina
 *   - low spend   → Sandra
 *
 * This module only PARSES + ANALYSES (no writes) so we can dry-run the counts,
 * exclusions and the Christina/Sandra split before committing anything.
 */
import { sqlite } from "@/lib/db";
import { buildDedupeIndex, findExistingCompany, type AjmRow } from "./ajm-import";
import { parseFaireExport, type FaireRow } from "./faire-marketplace-parse";

export { parseFaireExport, type FaireRow };

export interface FaireAnalysisRow extends FaireRow {
  frameCompanyId: string | null;
  matchedBy: string | null;
  alreadyJaxy: boolean;
  withinWindow: boolean;
  segment: "high" | "low";
}

export interface FaireAnalysis {
  params: { recencyYears: number; highMinSpend: number; cutoffIso: string };
  parsed: { rows: number; skipped: number };
  funnel: {
    matchedToFrame: number;
    alreadyJaxyCustomers: number; // excluded
    notJaxy: number;
    notJaxy_withinWindow: number;
    notJaxy_unknownDate: number;
    notJaxy_tooOld: number;
  };
  target: {
    size: number; // not-Jaxy AND within window
    withEmail: number;
    high_Christina: number;
    low_Sandra: number;
    highSpendTotal: number;
    lowSpendTotal: number;
  };
  spendPercentiles: { p10: number; p25: number; median: number; p75: number; p90: number; max: number } | null;
  sampleHigh: Array<{ store: string; spend: number; last: string | null; email: string | null }>;
  sampleLow: Array<{ store: string; spend: number; last: string | null; email: string | null }>;
  rows?: FaireAnalysisRow[]; // included only when opts.includeRows
}

/**
 * Match every Faire row against the frame, exclude existing Jaxy customers,
 * apply the recency window, and split the survivors by spend.
 */
export function analyzeFaireExport(
  text: string,
  opts: { recencyYears?: number; highMinSpend?: number; includeRows?: boolean } = {},
): FaireAnalysis {
  const recencyYears = opts.recencyYears ?? 4;
  const highMinSpend = opts.highMinSpend ?? 1500;
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - recencyYears);
  const cutoffTs = cutoff.getTime();

  const { rows, skipped } = parseFaireExport(text);
  const idx = buildDedupeIndex();

  // Which matched frame companies have actually ordered with Jaxy? Pull the set
  // of company_ids with a non-cancelled order once (cheap set membership).
  const jaxyOrderCompanyIds = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM orders WHERE status != 'cancelled' AND company_id IS NOT NULL").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );

  const analyzed: FaireAnalysisRow[] = rows.map((row) => {
    const probe = { name: row.storeName, email: row.email, phone: null, state: null } as AjmRow;
    const match = findExistingCompany(probe, idx);
    let alreadyJaxy = false;
    if (match) {
      const tags = (match.tags || "").toLowerCase();
      alreadyJaxy =
        match.status === "customer" ||
        jaxyOrderCompanyIds.has(match.id) ||
        tags.includes("ajm_already_customer");
    }
    const withinWindow = row.lastOrderedTs != null && row.lastOrderedTs >= cutoffTs;
    return {
      ...row,
      frameCompanyId: match?.id ?? null,
      matchedBy: match?.matched_by ?? null,
      alreadyJaxy,
      withinWindow,
      segment: row.spend >= highMinSpend ? "high" : "low",
    };
  });

  const matchedToFrame = analyzed.filter((r) => r.frameCompanyId).length;
  const alreadyJaxy = analyzed.filter((r) => r.alreadyJaxy);
  const notJaxy = analyzed.filter((r) => !r.alreadyJaxy);
  const notJaxyUnknown = notJaxy.filter((r) => r.lastOrderedTs == null);
  const notJaxyTooOld = notJaxy.filter((r) => r.lastOrderedTs != null && !r.withinWindow);
  const target = notJaxy.filter((r) => r.withinWindow);

  const spends = target.map((r) => r.spend).sort((a, b) => a - b);
  const pct = (p: number) => (spends.length ? spends[Math.min(spends.length - 1, Math.floor((p / 100) * spends.length))] : 0);
  const high = target.filter((r) => r.segment === "high");
  const low = target.filter((r) => r.segment === "low");
  const sum = (a: FaireAnalysisRow[]) => Math.round(a.reduce((s, r) => s + r.spend, 0));
  const sample = (a: FaireAnalysisRow[]) =>
    a
      .slice()
      .sort((x, y) => y.spend - x.spend)
      .slice(0, 10)
      .map((r) => ({ store: r.storeName, spend: r.spend, last: r.lastOrdered, email: r.email }));

  return {
    params: { recencyYears, highMinSpend, cutoffIso: cutoff.toISOString().slice(0, 10) },
    parsed: { rows: rows.length, skipped },
    funnel: {
      matchedToFrame,
      alreadyJaxyCustomers: alreadyJaxy.length,
      notJaxy: notJaxy.length,
      notJaxy_withinWindow: target.length,
      notJaxy_unknownDate: notJaxyUnknown.length,
      notJaxy_tooOld: notJaxyTooOld.length,
    },
    target: {
      size: target.length,
      withEmail: target.filter((r) => r.email).length,
      high_Christina: high.length,
      low_Sandra: low.length,
      highSpendTotal: sum(high),
      lowSpendTotal: sum(low),
    },
    spendPercentiles: spends.length
      ? { p10: pct(10), p25: pct(25), median: pct(50), p75: pct(75), p90: pct(90), max: spends[spends.length - 1] }
      : null,
    sampleHigh: sample(high),
    sampleLow: sample(low),
    rows: opts.includeRows ? analyzed : undefined,
  };
}
