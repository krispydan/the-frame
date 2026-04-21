/**
 * One-shot seed runner for image-gen personas/templates/presets/image-types.
 *
 * Usage:
 *   npx tsx scripts/seed-image-gen.ts
 *
 * Safe to re-run — only inserts missing rows.
 */
import { seedImageGenData } from "@/modules/catalog/lib/image-gen/seed";

async function main() {
  console.log("[seed-image-gen] Running idempotent seed…");
  const result = await seedImageGenData();
  console.log("[seed-image-gen] Done:");
  console.log("  personas   :", result.personas);
  console.log("  imageTypes :", result.imageTypes);
  console.log("  templates  :", result.templates);
  console.log("  presets    :", result.presets);
}

main().catch((err) => {
  console.error("[seed-image-gen] FAILED:", err);
  process.exit(1);
});
