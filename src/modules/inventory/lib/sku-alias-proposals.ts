/**
 * Proposing catalog aliases for SKU spellings the warehouse and Amazon use.
 *
 * The catalog spells a SKU `JX3004-S-BLK`. ShipHero reports `JX3004-BLK` and
 * Amazon reports `JX3004-BLK-FBA`. Nothing reconciles those, so stock that
 * plainly exists reads as zero everywhere downstream — inventory levels,
 * days-of-stock, reorder points, and the FIFO-vs-physical check.
 *
 * The mapping is mechanical (drop the segment the feeds omit) but it is NOT
 * safe to apply blind: if the catalog carried `JX3004-S-BLK` and
 * `JX3004-M-BLK`, both would collapse onto the same feed spelling and there
 * would be no way to know which one the warehouse means. Guessing there would
 * silently attribute stock — and later COGS — to the wrong SKU.
 *
 * So this proposes, and separates the proposals into three buckets. Only the
 * unambiguous bucket is safe to write, and the caller decides when.
 */

import { sqlite } from "@/lib/db";

export type AliasProposal = {
  /** The spelling the feed uses. */
  alias: string;
  source: "shiphero" | "fba";
  /** Units riding on this alias — how much is at stake if it stays unmapped. */
  units: number;
  skuId: string;
  canonicalSku: string;
};

export type AmbiguousProposal = {
  alias: string;
  source: "shiphero" | "fba";
  units: number;
  /** Every catalog SKU that collapses onto this alias. */
  candidates: string[];
};

export type ProposalReport = {
  /** Safe to write: exactly one catalog SKU collapses onto the alias. */
  proposed: AliasProposal[];
  /** Never write these — more than one catalog SKU claims the alias. */
  ambiguous: AmbiguousProposal[];
  /** Feed SKUs no catalog SKU explains. Genuinely unknown product. */
  unmatched: Array<{ alias: string; source: "shiphero" | "fba"; units: number }>;
  totals: { proposedUnits: number; ambiguousUnits: number; unmatchedUnits: number };
};

/**
 * Feed spellings a catalog SKU could plausibly be written as.
 *
 * Only ever DROPS segments — never invents them — so a proposal can merge two
 * catalog SKUs onto one alias (caught as ambiguous) but can never invent a
 * product that does not exist.
 */
export function feedSpellings(catalogSku: string): string[] {
  const parts = catalogSku.split("-");
  const out = new Set<string>([catalogSku]);
  // Drop any single interior segment: JX3004-S-BLK → JX3004-BLK.
  // Interior only — the leading style code and trailing colour both carry
  // meaning that no feed omits.
  for (let i = 1; i < parts.length - 1; i++) {
    out.add([...parts.slice(0, i), ...parts.slice(i + 1)].join("-"));
  }
  return [...out];
}

/** Amazon appends -FBA to stock held in Amazon's warehouses. */
function stripFba(sku: string): string {
  return sku.replace(/-FBA$/i, "");
}

export function proposeSkuAliases(): ProposalReport {
  const catalog = sqlite.prepare(
    "SELECT id, sku FROM catalog_skus WHERE sku IS NOT NULL AND sku != ''",
  ).all() as Array<{ id: string; sku: string }>;

  // spelling → every catalog SKU that could be written that way.
  const bySpelling = new Map<string, Array<{ id: string; sku: string }>>();
  for (const row of catalog) {
    for (const spelling of feedSpellings(row.sku)) {
      const list = bySpelling.get(spelling) ?? [];
      list.push(row);
      bySpelling.set(spelling, list);
    }
  }

  const existingAliases = new Set(
    (sqlite.prepare("SELECT alias FROM catalog_sku_aliases").all() as Array<{ alias: string }>)
      .map((r) => r.alias),
  );
  const exactCatalog = new Set(catalog.map((r) => r.sku));

  // ── Feed SKUs that need a mapping ──
  const feed: Array<{ alias: string; source: "shiphero" | "fba"; units: number }> = [];

  for (const r of sqlite.prepare(`
    SELECT sku, SUM(on_hand) AS units FROM shiphero_inventory
    WHERE on_hand > 0 GROUP BY sku
  `).all() as Array<{ sku: string; units: number }>) {
    feed.push({ alias: r.sku, source: "shiphero", units: r.units });
  }

  const latestSnapshot = (sqlite.prepare(
    "SELECT MAX(snapshot_date) AS d FROM amazon_fba_inventory",
  ).get() as { d: string | null }).d;

  if (latestSnapshot) {
    for (const r of sqlite.prepare(`
      SELECT sku, internal_sku, SUM(total_qty) AS units FROM amazon_fba_inventory
      WHERE snapshot_date = ? AND total_qty > 0 GROUP BY sku, internal_sku
    `).all(latestSnapshot) as Array<{ sku: string; internal_sku: string | null; units: number }>) {
      // The alias worth storing is the internal spelling, since that is what
      // resolveCatalogSku() looks up after stripping -FBA.
      feed.push({ alias: r.internal_sku || stripFba(r.sku), source: "fba", units: r.units });
    }
  }

  const proposed: AliasProposal[] = [];
  const ambiguous: AmbiguousProposal[] = [];
  const unmatched: ProposalReport["unmatched"] = [];
  const seen = new Set<string>();

  for (const f of feed) {
    // Already resolvable — nothing to propose.
    if (exactCatalog.has(f.alias) || existingAliases.has(f.alias)) continue;
    // One feed spelling can arrive from both sources; propose it once.
    if (seen.has(f.alias)) continue;
    seen.add(f.alias);

    const candidates = bySpelling.get(f.alias) ?? [];
    if (candidates.length === 1) {
      proposed.push({
        alias: f.alias, source: f.source, units: f.units,
        skuId: candidates[0].id, canonicalSku: candidates[0].sku,
      });
    } else if (candidates.length > 1) {
      ambiguous.push({
        alias: f.alias, source: f.source, units: f.units,
        candidates: candidates.map((c) => c.sku).sort(),
      });
    } else {
      unmatched.push({ alias: f.alias, source: f.source, units: f.units });
    }
  }

  const sum = <T extends { units: number }>(xs: T[]) => xs.reduce((t, x) => t + x.units, 0);

  return {
    proposed: proposed.sort((a, b) => b.units - a.units),
    ambiguous: ambiguous.sort((a, b) => b.units - a.units),
    unmatched: unmatched.sort((a, b) => b.units - a.units),
    totals: {
      proposedUnits: sum(proposed),
      ambiguousUnits: sum(ambiguous),
      unmatchedUnits: sum(unmatched),
    },
  };
}

/**
 * Write the unambiguous proposals into `catalog_sku_aliases`.
 *
 * Ambiguous and unmatched proposals are never written — they need a human to
 * say which SKU the warehouse means.
 */
export function applySkuAliases(opts?: { dryRun?: boolean }): {
  written: number;
  skipped: { ambiguous: number; unmatched: number };
  aliases: Array<{ alias: string; canonicalSku: string; units: number }>;
} {
  const report = proposeSkuAliases();
  const aliases = report.proposed.map((p) => ({
    alias: p.alias, canonicalSku: p.canonicalSku, units: p.units,
  }));

  if (!opts?.dryRun) {
    const insert = sqlite.prepare(`
      INSERT INTO catalog_sku_aliases (alias, sku_id, canonical_sku, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(alias) DO NOTHING
    `);
    const tx = sqlite.transaction((rows: AliasProposal[]) => {
      for (const p of rows) {
        insert.run(p.alias, p.skuId, p.canonicalSku, `auto: ${p.source} feed spelling`);
      }
    });
    tx(report.proposed);
  }

  return {
    written: opts?.dryRun ? 0 : report.proposed.length,
    skipped: { ambiguous: report.ambiguous.length, unmatched: report.unmatched.length },
    aliases,
  };
}
