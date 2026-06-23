/**
 * Strategy outcomes — the substrate the v2 data-driven recommender
 * will read. Kept separate from email-strategy.ts so that engine stays
 * pure/testable; this module owns the DB side-effect.
 *
 * When a campaign's results are captured, we re-derive the strategy
 * dimensions that produced it (layout / image style / subject angle)
 * from the deterministic engine and store them alongside the metrics.
 * Later, recommendForSlot() can weight its rotation toward the
 * dimensions that historically opened/clicked best.
 */

import { sqlite } from "@/lib/db";
import { recommendForSlot } from "./email-strategy";

function inferSlotFromDate(audience: "retail" | "wholesale", iso: string): 1 | 2 {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (audience === "retail") return dow === 4 ? 2 : 1; // Thu = slot 2
  return dow === 5 ? 2 : 1; // Fri = slot 2
}

export interface OutcomeInput {
  campaignId: string;
  audience: "retail" | "wholesale";
  weekOf: string;
  scheduledDate: string;
  recipients: number | null;
  opens: number | null;
  clicks: number | null;
}

/**
 * Persist a campaign outcome tagged with its strategy dimensions.
 * Idempotent-ish: one row per (campaign) — replaces a prior outcome.
 */
export function recordStrategyOutcome(o: OutcomeInput): void {
  const slot = inferSlotFromDate(o.audience, o.scheduledDate);
  const rec = recommendForSlot(o.audience, o.weekOf, slot);

  const openRate = o.recipients && o.opens != null ? o.opens / o.recipients : null;
  const clickRate = o.recipients && o.clicks != null ? o.clicks / o.recipients : null;

  sqlite
    .prepare(`DELETE FROM marketing_email_strategy_outcomes WHERE campaign_id = ?`)
    .run(o.campaignId);

  sqlite
    .prepare(
      `INSERT INTO marketing_email_strategy_outcomes
        (id, campaign_id, audience, week_of, layout_profile, image_style, subject_angle,
         recipients, opens, clicks, open_rate, click_rate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      crypto.randomUUID(),
      o.campaignId,
      o.audience,
      o.weekOf,
      rec.layoutProfile,
      rec.imageStyle,
      rec.subjectAngle,
      o.recipients,
      o.opens,
      o.clicks,
      openRate,
      clickRate,
    );
}

/**
 * Aggregate performance by a strategy dimension — the read side the v2
 * recommender (and a future dashboard) will use.
 */
export function outcomesByDimension(
  audience: "retail" | "wholesale",
  dimension: "subject_angle" | "image_style" | "layout_profile",
): Array<{ value: string; n: number; avgOpenRate: number | null; avgClickRate: number | null }> {
  const rows = sqlite
    .prepare(
      `SELECT ${dimension} AS value,
              COUNT(*) AS n,
              AVG(open_rate) AS avgOpenRate,
              AVG(click_rate) AS avgClickRate
       FROM marketing_email_strategy_outcomes
       WHERE audience = ?
       GROUP BY ${dimension}
       ORDER BY avgOpenRate DESC`,
    )
    .all(audience) as Array<{ value: string; n: number; avgOpenRate: number | null; avgClickRate: number | null }>;
  return rows;
}
