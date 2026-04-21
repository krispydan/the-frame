/**
 * Idempotent seed runner for image-gen personas, templates, variable presets, image types.
 *
 * Strategy: for each seed row, look up by natural key (slug for personas/image-types,
 * persona_slug+slug for templates, image_type_slug+persona_slug+var_name+value for presets).
 * If missing, insert. If present, leave existing row untouched (so admin edits survive
 * subsequent seed runs). Delete nothing.
 */
import { db } from "@/lib/db";
import { and, eq, isNull } from "drizzle-orm";
import {
  personas as personasTable,
  promptTemplates,
  variablePresets,
  imageTypes,
} from "@/modules/catalog/schema";
import {
  SEED_PERSONAS,
  SEED_TEMPLATES,
  SEED_VARIABLE_PRESETS,
  SEED_IMAGE_TYPES,
} from "./seed-data";

export type SeedResult = {
  personas: { inserted: number; existing: number };
  imageTypes: { inserted: number; existing: number };
  templates: { inserted: number; existing: number };
  presets: { inserted: number; existing: number };
};

export async function seedImageGenData(): Promise<SeedResult> {
  const result: SeedResult = {
    personas: { inserted: 0, existing: 0 },
    imageTypes: { inserted: 0, existing: 0 },
    templates: { inserted: 0, existing: 0 },
    presets: { inserted: 0, existing: 0 },
  };

  // ── Personas ──
  for (const p of SEED_PERSONAS) {
    const existing = await db.select().from(personasTable).where(eq(personasTable.slug, p.slug)).get();
    if (existing) {
      result.personas.existing++;
      continue;
    }
    await db.insert(personasTable).values({
      slug: p.slug,
      name: p.name,
      description: p.description,
      ageRange: p.ageRange,
      moodKeywords: p.moodKeywords,
      kind: p.kind,
      sortOrder: p.sortOrder,
      active: true,
    });
    result.personas.inserted++;
  }

  // ── Image Types ──
  for (const it of SEED_IMAGE_TYPES) {
    const existing = await db.select().from(imageTypes).where(eq(imageTypes.slug, it.slug)).get();
    if (existing) {
      result.imageTypes.existing++;
      continue;
    }
    await db.insert(imageTypes).values({
      slug: it.slug,
      label: it.label,
      aspectRatio: it.aspectRatio,
      minWidth: it.minWidth,
      minHeight: it.minHeight,
      platform: it.platform ?? "all",
      description: it.description,
      active: true,
      sortOrder: it.sortOrder,
    });
    result.imageTypes.inserted++;
  }

  // ── Prompt Templates ──
  for (const t of SEED_TEMPLATES) {
    const existing = await db
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.personaSlug, t.personaSlug), eq(promptTemplates.slug, t.slug)))
      .get();
    if (existing) {
      result.templates.existing++;
      continue;
    }
    await db.insert(promptTemplates).values({
      personaSlug: t.personaSlug,
      imageTypeSlug: t.imageTypeSlug,
      kind: t.kind,
      slug: t.slug,
      name: t.name,
      templateText: t.templateText,
      requiredVars: t.requiredVars,
      orderIndex: t.orderIndex,
      active: true,
    });
    result.templates.inserted++;
  }

  // ── Variable Presets ──
  for (const preset of SEED_VARIABLE_PRESETS) {
    for (const value of preset.values) {
      // Natural key = (image_type_slug, persona_slug, var_name, value)
      const conds = [eq(variablePresets.varName, preset.varName), eq(variablePresets.value, value)];
      conds.push(
        preset.imageTypeSlug === null
          ? isNull(variablePresets.imageTypeSlug)
          : eq(variablePresets.imageTypeSlug, preset.imageTypeSlug),
      );
      conds.push(
        preset.personaSlug === null
          ? isNull(variablePresets.personaSlug)
          : eq(variablePresets.personaSlug, preset.personaSlug),
      );
      const existing = await db.select().from(variablePresets).where(and(...conds)).get();
      if (existing) {
        result.presets.existing++;
        continue;
      }
      const scope =
        preset.imageTypeSlug && preset.personaSlug
          ? "persona_image_type"
          : preset.imageTypeSlug
          ? "image_type"
          : preset.personaSlug
          ? "persona_image_type"
          : "global";
      await db.insert(variablePresets).values({
        scope: scope as "global" | "image_type" | "persona_image_type",
        imageTypeSlug: preset.imageTypeSlug,
        personaSlug: preset.personaSlug,
        varName: preset.varName,
        value,
        weight: 1.0,
        active: true,
      });
      result.presets.inserted++;
    }
  }

  return result;
}
