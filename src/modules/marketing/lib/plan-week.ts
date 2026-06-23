/**
 * Week planning — the self-serve "plan N weeks" flow, shared by the
 * HTTP route (dashboard button) and the MCP plan_week tool so there is
 * one implementation.
 *
 * For each planned week it: (1) asks Claude for a theme per week via the
 * theme prompt, (2) persists the themes, (3) for each cadence slot
 * (retail Mon/Thu, wholesale Tue/Fri) creates a campaign seeded with the
 * strategy engine's variant layout + a per-slot brief (slot 1 ≠ slot 2,
 * different image style + subject angle) + designer notes. Every brief
 * is editable before generation.
 */

import { sqlite } from "@/lib/db";
import { generateThemes } from "./email-ai";
import { recommendForSlot } from "./email-strategy";

export interface PlanWeeksInput {
  audience: "retail" | "wholesale";
  weekStart?: string; // ISO Monday; defaults to next Monday
  weeks?: number; // default 4 (clamped 1..8)
  createCampaigns?: boolean; // default true
}

export interface PlannedCampaign {
  id: string;
  scheduledDate: string;
  themeId: string;
  themeTitle: string;
  briefTitle: string;
  slotInWeek: 1 | 2;
  layoutProfile: string;
  imageStyle: string;
  subjectAngle: string;
}

export interface PlanWeeksResult {
  ok: true;
  audience: "retail" | "wholesale";
  weekStart: string;
  weeksPlanned: number;
  themes: Array<Record<string, unknown>>;
  campaignsCreated: PlannedCampaign[];
}

export async function planWeeks(
  input: PlanWeeksInput,
): Promise<PlanWeeksResult | { ok: false; error: string }> {
  const audience = input.audience;
  const weeks = Math.min(Math.max(input.weeks ?? 4, 1), 8);
  const createCampaigns = input.createCampaigns !== false;
  const weekStart = input.weekStart ?? nextMonday();

  const themeRes = await generateThemes({ audience, weekStart, count: weeks });
  if (!themeRes.ok) return { ok: false, error: themeRes.error };

  const themes = (themeRes.output.themes ?? []) as Array<{
    weekOf: string;
    title: string;
    angle: string;
    productHook?: string | null;
    seasonalContext?: string | null;
  }>;

  const themeInsert = sqlite.prepare(
    `INSERT INTO marketing_email_themes
       (id, week_of, audience, title, angle, product_hook, seasonal_context, raw_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insertedThemes = themes.map((t) => {
    const id = crypto.randomUUID();
    themeInsert.run(
      id, t.weekOf, audience, t.title, t.angle ?? null,
      t.productHook ?? null, t.seasonalContext ?? null, JSON.stringify(t),
    );
    return { id, ...t };
  });

  const campaignsCreated: PlannedCampaign[] = [];
  if (createCampaigns) {
    const campaignInsert = sqlite.prepare(
      `INSERT INTO marketing_email_campaigns
        (id, audience, scheduled_date, week_of, theme_id, status,
         hero_variant, section_a_variant, secondary_image_variant, section_b_variant,
         brief_title, brief_angle, brief_product_hook, brief_seasonal_context,
         designer_notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'themed', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );

    for (const theme of insertedThemes) {
      for (const slot of [1, 2] as const) {
        const rec = recommendForSlot(audience, theme.weekOf, slot);
        const id = crypto.randomUUID();
        const designerNote = `STRATEGY: ${rec.rationale}\n\nIMAGE STYLE: ${rec.imageStyleDirective}\n\nSUBJECT ANGLE: ${rec.subjectAngleHint}`;
        const slotLabel = slot === 1
          ? audience === "retail" ? "Mon" : "Tue"
          : audience === "retail" ? "Thu" : "Fri";
        const imageStyleLabel = rec.imageStyle === "product_flatlay"
          ? "product still-life angle"
          : rec.imageStyle === "on_model_lifestyle"
            ? "on-model lifestyle angle"
            : rec.imageStyle.replace(/_/g, " ");
        const briefTitle = `${theme.title} — ${slotLabel} (${imageStyleLabel})`;
        const briefAngle = `${theme.angle ?? ""}\n\nSlot context: ${imageStyleLabel}. Subject-angle direction: ${rec.subjectAngleHint}`;

        campaignInsert.run(
          id, audience, rec.scheduledDate, theme.weekOf, theme.id,
          rec.layoutVariants.heroVariant, rec.layoutVariants.sectionAVariant,
          rec.layoutVariants.secondaryImageVariant, rec.layoutVariants.sectionBVariant,
          briefTitle, briefAngle, theme.productHook ?? null, theme.seasonalContext ?? null,
          designerNote,
        );
        campaignsCreated.push({
          id, scheduledDate: rec.scheduledDate, themeId: theme.id, themeTitle: theme.title,
          briefTitle, slotInWeek: slot, layoutProfile: rec.layoutProfile,
          imageStyle: rec.imageStyle, subjectAngle: rec.subjectAngle,
        });
      }
    }
  }

  return {
    ok: true,
    audience,
    weekStart,
    weeksPlanned: weeks,
    themes: insertedThemes,
    campaignsCreated,
  };
}

export function nextMonday(): string {
  const d = new Date();
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 7 : 8 - day));
  return d.toISOString().slice(0, 10);
}
