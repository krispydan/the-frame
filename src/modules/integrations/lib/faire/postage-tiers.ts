/**
 * Configurable postage tiers for Faire shipments.
 *
 * When we mark a Faire order shipped via Faire's API, we have to declare
 * the postage WE paid (maker_cost_cents). That's not the same as Faire's
 * shipping fee charged to the retailer — it's our cost, used by Faire to
 * reconcile reimbursement.
 *
 * We approximate our cost via tiers keyed on the order total:
 *   < $50            → $5
 *   $50 ≤ x < $250   → $15
 *   ≥ $250           → $25
 *
 * The defaults match the values Daniel specified. They're stored in the
 * settings table under the key `faire_postage_tiers_json` so the values
 * can be edited from /settings/integrations/faire without a deploy.
 *
 * Tiers are ordered ascending by maxOrderTotalCents. The last tier with
 * maxOrderTotalCents = null is the catch-all (everything above the
 * previous tier).
 */

import { sqlite } from "@/lib/db";

export interface PostageTier {
  /** Inclusive of orders strictly LESS than this amount. null = catch-all. */
  maxOrderTotalCents: number | null;
  /** Postage to declare for orders in this tier. */
  postageCents: number;
}

export const SETTINGS_KEY = "faire_postage_tiers_json";

export const DEFAULT_TIERS: PostageTier[] = [
  { maxOrderTotalCents: 5000, postageCents: 500 },    // < $50  → $5
  { maxOrderTotalCents: 25000, postageCents: 1500 },  // < $250 → $15
  { maxOrderTotalCents: null, postageCents: 2500 },   // else   → $25
];

/**
 * Read the active tier config from settings. Falls back to DEFAULT_TIERS
 * when the row is missing or malformed (which is the case on first install
 * before anyone has touched the UI).
 */
export function getPostageTiers(): PostageTier[] {
  try {
    const row = sqlite
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get(SETTINGS_KEY) as { value: string } | undefined;
    if (!row?.value) return DEFAULT_TIERS;
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_TIERS;
    const valid = parsed.every(
      (t) =>
        t &&
        typeof t === "object" &&
        (typeof (t as Record<string, unknown>).maxOrderTotalCents === "number" ||
          (t as Record<string, unknown>).maxOrderTotalCents === null) &&
        typeof (t as Record<string, unknown>).postageCents === "number",
    );
    if (!valid) return DEFAULT_TIERS;
    return parsed as PostageTier[];
  } catch (e) {
    console.error("[faire/postage-tiers] read failed, using defaults:", e);
    return DEFAULT_TIERS;
  }
}

/**
 * Resolve postage in cents for a given order total (in dollars).
 *
 * Tier match: pick the first tier whose maxOrderTotalCents is greater than
 * the order total. The last tier (maxOrderTotalCents=null) is the catch-all.
 */
export function getPostageCentsForOrderTotal(orderTotalDollars: number): number {
  const totalCents = Math.round(orderTotalDollars * 100);
  const tiers = getPostageTiers();
  for (const tier of tiers) {
    if (tier.maxOrderTotalCents === null) return tier.postageCents;
    if (totalCents < tier.maxOrderTotalCents) return tier.postageCents;
  }
  // Shouldn't reach here unless tiers had no catch-all. Default to the last
  // tier's postage rather than throw.
  return tiers[tiers.length - 1]?.postageCents ?? 2500;
}

export function savePostageTiers(tiers: PostageTier[]): void {
  // Validate ordering + shape before persisting. Catch-all (null) must be
  // last; non-null entries must be strictly ascending. Postage values must
  // be non-negative integers.
  for (let i = 0; i < tiers.length - 1; i++) {
    if (tiers[i].maxOrderTotalCents === null) {
      throw new Error("Only the last tier can be a catch-all (maxOrderTotalCents=null)");
    }
  }
  let lastMax = -1;
  for (const t of tiers) {
    if (t.maxOrderTotalCents !== null) {
      if (t.maxOrderTotalCents <= lastMax) {
        throw new Error("Tiers must be strictly ascending by maxOrderTotalCents");
      }
      lastMax = t.maxOrderTotalCents;
    }
    if (!Number.isInteger(t.postageCents) || t.postageCents < 0) {
      throw new Error("postageCents must be a non-negative integer");
    }
  }

  const value = JSON.stringify(tiers);
  sqlite
    .prepare(
      `INSERT INTO settings (key, value, type, module, updated_at)
       VALUES (?, ?, 'string', 'integrations', datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(SETTINGS_KEY, value);
}
