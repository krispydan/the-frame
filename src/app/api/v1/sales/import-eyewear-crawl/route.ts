export const dynamic = "force-dynamic";
// 18s benchmark locally for full 116K-row run; give plenty of headroom
// on Railway disk latency + classifier.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { runEyewearImport } from "../../../../../../scripts/import-eyewear-crawl";

/**
 * POST /api/v1/sales/import-eyewear-crawl
 *
 * Ingests the three CSVs from a Shopify eyewear crawl and merges them
 * into the `companies` table. Used by both the upload-eyewear-to-prod
 * script (multipart upload) and the `sales.import_eyewear_crawl` MCP
 * tool (which forwards from staged paths).
 *
 * Two invocation modes:
 *
 *   multipart/form-data — drop the three CSV files into one request:
 *     products: <File>     (sunglasses-products.csv)
 *     state:    <File>     (sunglasses-state.jsonl)
 *     cohort:   <File>     (apparel-filtered.csv)
 *     dryRun?:  "true"
 *     limit?:   "N"
 *     noClassifier?: "true"
 *
 *   application/json — point at already-staged paths on the server:
 *     {
 *       productsPath: "/tmp/sunglasses-products.csv",
 *       statePath:    "/tmp/sunglasses-state.jsonl",
 *       cohortPath:   "/tmp/apparel-filtered.csv",
 *       dryRun?, limit?, noClassifier?
 *     }
 *
 * Dedup: the importer's selectByDomain is source-agnostic — any
 * existing row with matching `domain` gets the eyewear data merged
 * via COALESCE rather than duplicating. Crucially, `companies.tags`
 * always picks up the `eyewear_cohort` (or `apparel_no_eyewear_v1`)
 * label on merge — so the canned Smart Lists filter by tag, NOT by
 * source_query, to catch merged rows whose source_query was set by
 * an earlier import.
 *
 * Returns:
 *   {
 *     ok: true,
 *     eyewear:  { inserted, mergedExisting, skipped... },
 *     noEyewear: {...},
 *     classifierTiers: { A: ..., B: ..., ... } | null,
 *     instantlyOverlap: {
 *       totalTouchedEyewear, mergedExisting, alreadyInInstantly
 *     },
 *     durationMs
 *   }
 */
export async function POST(req: NextRequest) {
  const tmpFiles: string[] = [];
  try {
    const contentType = req.headers.get("content-type") || "";

    let productsPath: string;
    let statePath: string;
    let cohortPath: string;
    let dryRun = false;
    let limit: number | null = null;
    let noClassifier = false;

    if (contentType.startsWith("multipart/form-data")) {
      const formData = await req.formData();
      const products = formData.get("products") as File | null;
      const state = formData.get("state") as File | null;
      const cohort = formData.get("cohort") as File | null;
      if (!products || !state || !cohort) {
        return NextResponse.json(
          { error: "Required files: products, state, cohort" },
          { status: 400 },
        );
      }

      const stamp = Date.now();
      productsPath = path.join(os.tmpdir(), `eyewear-products-${stamp}.csv`);
      statePath = path.join(os.tmpdir(), `eyewear-state-${stamp}.jsonl`);
      cohortPath = path.join(os.tmpdir(), `eyewear-cohort-${stamp}.csv`);
      tmpFiles.push(productsPath, statePath, cohortPath);

      fs.writeFileSync(productsPath, Buffer.from(await products.arrayBuffer()));
      fs.writeFileSync(statePath, Buffer.from(await state.arrayBuffer()));
      fs.writeFileSync(cohortPath, Buffer.from(await cohort.arrayBuffer()));

      dryRun = formData.get("dryRun") === "true";
      const limitStr = formData.get("limit") as string | null;
      if (limitStr) limit = parseInt(limitStr, 10) || null;
      noClassifier = formData.get("noClassifier") === "true";
    } else {
      // JSON mode — paths already exist on the server (e.g. staged
      // earlier via the admin chunked-upload endpoint, or copied via
      // ssh).
      const body = await req.json() as {
        productsPath?: string;
        statePath?: string;
        cohortPath?: string;
        dryRun?: boolean;
        limit?: number;
        noClassifier?: boolean;
      };
      if (!body.productsPath || !body.statePath || !body.cohortPath) {
        return NextResponse.json(
          { error: "Required: productsPath, statePath, cohortPath" },
          { status: 400 },
        );
      }
      productsPath = body.productsPath;
      statePath = body.statePath;
      cohortPath = body.cohortPath;
      dryRun = !!body.dryRun;
      limit = body.limit ?? null;
      noClassifier = !!body.noClassifier;
    }

    // Run the import — same callable as the CLI script.
    const result = await runEyewearImport({
      productsCsv: productsPath,
      stateLog: statePath,
      cohortCsv: cohortPath,
      dryRun,
      limit,
      noClassifier,
      log: () => { /* swallow — return stats in JSON instead */ },
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  } finally {
    // Cleanup temp files we wrote for multipart uploads. JSON-mode
    // callers manage their own paths.
    for (const f of tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }
}
