/**
 * AJ Morgan Faire export → segmented reactivation call lists.
 *
 * Ingests the full Faire "Customers" export (~17k rows, mostly never-ordered
 * email leads), keeps only stores that actually ordered on AJM's Faire, and —
 * using the frame to exclude anyone who has ALREADY ordered with Jaxy —
 * produces two value-segmented cohorts for the pre-Faire-Marketplace push:
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
  parsed: { rows: number; skipped: number; neverOrdered: number; ordered: number };
  funnel: {
    orderedTotal: number; // rows that have ever ordered on AJM Faire
    matchedToFrame: number;
    alreadyJaxyCustomers: number; // excluded
    notJaxy: number;
    notJaxy_withinWindow: number;
    notJaxy_unknownDate: number;
    notJaxy_tooOld: number;
  };
  target: {
    size: number; // ordered AND not-Jaxy AND within window
    withEmail: number;
    matchedInFrame: number;
    callable_hasPhone: number; // reachable by phone via frame match
    high_Christina: number;
    low_Sandra: number;
    highSpendTotal: number;
    lowSpendTotal: number;
  };
  spendPercentiles: { p10: number; p25: number; median: number; p75: number; p90: number; max: number } | null;
  sampleHigh: Array<{ store: string | null; spend: number; last: string | null; state: string | null; hasPhone: boolean }>;
  sampleLow: Array<{ store: string | null; spend: number; last: string | null; state: string | null; hasPhone: boolean }>;
  rows?: FaireAnalysisRow[]; // included only when opts.includeRows
}

/**
 * Keep only stores that ORDERED, match each against the frame, exclude existing
 * Jaxy customers, apply the recency window, and split the survivors by spend.
 * Contact reachability (phone) comes from the matched frame company, since the
 * Faire export carries no phone column.
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

  const { rows: allRows, skipped } = parseFaireExport(text);
  // We only care about stores that have actually ordered on AJM's Faire — the
  // export is mostly never-ordered email leads.
  const rows = allRows.filter((r) => r.ordered);
  const idx = buildDedupeIndex();

  // Company_ids that have ordered with Jaxy (non-cancelled) — the exclusion set.
  const jaxyOrderCompanyIds = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM orders WHERE status != 'cancelled' AND company_id IS NOT NULL").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );
  // Frame companies that have at least one phone on file (for callability).
  const companiesWithPhone = new Set(
    (sqlite.prepare("SELECT DISTINCT company_id FROM company_phones WHERE TRIM(COALESCE(phone,'')) <> ''").all() as Array<{
      company_id: string;
    }>).map((r) => r.company_id),
  );

  const analyzed: FaireAnalysisRow[] = rows.map((row) => {
    // Name + state + email all help the frame matcher (this export has no phone).
    const probe = { name: row.storeName, email: row.email, phone: null, state: row.state } as AjmRow;
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

  const hasPhone = (r: FaireAnalysisRow) => !!r.frameCompanyId && companiesWithPhone.has(r.frameCompanyId);
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
      .map((r) => ({ store: r.storeName, spend: r.spend, last: r.lastOrdered, state: r.state, hasPhone: hasPhone(r) }));

  return {
    params: { recencyYears, highMinSpend, cutoffIso: cutoff.toISOString().slice(0, 10) },
    parsed: { rows: allRows.length, skipped, neverOrdered: allRows.length - rows.length, ordered: rows.length },
    funnel: {
      orderedTotal: rows.length,
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
      matchedInFrame: target.filter((r) => r.frameCompanyId).length,
      callable_hasPhone: target.filter(hasPhone).length,
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
