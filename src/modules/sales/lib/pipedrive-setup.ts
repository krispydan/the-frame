/**
 * Pipedrive pipeline + stage provisioning and sync config.
 *
 * Creates the three pipelines the CRM plan calls for (AJM Reactivation,
 * Catalog Interested, Customers) and their stages, idempotently, then stores
 * the resulting IDs in settings under `pipedrive_pipelines` so the sync layer
 * can look them up. Also stores the default deal owner (Christina).
 */

import { db } from "@/lib/db";
import { settings } from "@/modules/core/schema";
import { eq } from "drizzle-orm";
import { pdRequest, listPipelines, listStages } from "./pipedrive-client";

export interface PipelineConfig {
  ajm: { pipelineId: number; stages: Record<string, number> };
  catalog: { pipelineId: number; stages: Record<string, number> };
  customers: { pipelineId: number; stages: Record<string, number> };
}

const DESIRED: Array<{ key: keyof PipelineConfig; name: string; stages: string[] }> = [
  // AJM gets a "To Contact" stage because the curated 1,173 are seeded directly
  // (not gated on interest) — that's Christina's call/email queue.
  { key: "ajm", name: "AJM Reactivation", stages: ["To Contact", "Interested", "Catalog Sent", "Following Up"] },
  { key: "catalog", name: "Catalog Interested", stages: ["Interested", "Catalog Sent", "Following Up"] },
  { key: "customers", name: "Customers", stages: ["Order Placed", "Fulfilled", "Delivered"] },
];

function setSetting(key: string, value: string): void {
  db.insert(settings)
    .values({ key, value, type: "string" as const, module: "sales" })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date().toISOString() } })
    .run();
}
function getSetting(key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

/**
 * Create any missing pipelines/stages and persist the ID map. Idempotent:
 * matches existing pipelines/stages by (case-insensitive) name, creates only
 * what's absent. Safe to re-run.
 */
export async function ensurePipelines(): Promise<PipelineConfig> {
  const existingPipelines = await listPipelines();
  const existingStages = await listStages();

  const config = {} as PipelineConfig;

  for (const want of DESIRED) {
    // pipeline
    let pipeline = existingPipelines.find((p) => p.name.trim().toLowerCase() === want.name.toLowerCase());
    if (!pipeline) {
      const created = await pdRequest<{ id: number; name: string }>("POST", "/pipelines", { name: want.name });
      pipeline = { id: created.id, name: want.name };
      existingPipelines.push(pipeline);
    }
    const pipelineId = pipeline.id;

    // stages
    const stages: Record<string, number> = {};
    let order = 1;
    for (const stageName of want.stages) {
      let stage = existingStages.find(
        (s) => s.pipeline_id === pipelineId && s.name.trim().toLowerCase() === stageName.toLowerCase(),
      );
      if (!stage) {
        const created = await pdRequest<{ id: number }>("POST", "/stages", {
          name: stageName,
          pipeline_id: pipelineId,
          order_nr: order,
        });
        stage = { id: created.id, name: stageName, pipeline_id: pipelineId, order_nr: order };
        existingStages.push(stage);
      }
      stages[stageName] = stage.id;
      order++;
    }

    config[want.key] = { pipelineId, stages };
  }

  setSetting("pipedrive_pipelines", JSON.stringify(config));
  return config;
}

export function getPipelineConfig(): PipelineConfig | null {
  const raw = getSetting("pipedrive_pipelines");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PipelineConfig;
  } catch {
    return null;
  }
}

export function setPipedriveOwner(ownerId: number, ownerName?: string): void {
  setSetting("pipedrive_owner_id", String(ownerId));
  if (ownerName) setSetting("pipedrive_owner_name", ownerName);
}

export function getPipedriveOwner(): { id: number; name?: string } | null {
  const id = getSetting("pipedrive_owner_id");
  if (!id) return null;
  return { id: parseInt(id, 10), name: getSetting("pipedrive_owner_name") || undefined };
}
