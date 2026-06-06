export const dynamic = "force-dynamic";
// Importing 116K rows + classifier on Railway: local benchmark was 18s
// against the same DB. Give the run action a generous ceiling so a slow
// disk doesn't kill it mid-transaction.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { runEyewearImport } from "../../../../../scripts/import-eyewear-crawl";

/**
 * POST /api/admin/eyewear-import
 *
 * Mirrors the chunked-upload pattern used by /api/admin/restore-db
 * (4MB base64 chunks, action discriminator). Three input files are
 * uploaded in sequence — products, state, cohort — then a `run`
 * action triggers the import in-process against the current
 * /data/the-frame.db (or local data/the-frame.db).
 *
 * Auth: same `x-admin-key: jaxy2026` header as the rest of /api/admin.
 *
 * Body shape:
 *   { action: 'start', file?: 'products'|'state'|'cohort' }
 *     Resets any in-progress upload (or just the named file).
 *
 *   { action: 'chunk', file: 'products'|'state'|'cohort',
 *     chunk: <int>, data: <base64> }
 *     Appends the decoded chunk to that file's staging path.
 *
 *   { action: 'run', dryRun?: bool, limit?: int, noClassifier?: bool }
 *     Runs the import. Returns stats.
 *
 *   { action: 'status' }
 *     Returns the staging-file sizes + whether the DB exists.
 *
 *   { action: 'cleanup' }
 *     Deletes the staging files.
 */

const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(process.cwd(), "data");
const STAGING_DIR = path.join(DATA_DIR, "eyewear-import-staging");

const FILES = {
  products: path.join(STAGING_DIR, "sunglasses-products.csv"),
  state: path.join(STAGING_DIR, "sunglasses-state.jsonl"),
  cohort: path.join(STAGING_DIR, "apparel-filtered.csv"),
} as const;

type FileKey = keyof typeof FILES;

function ensureDir() {
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
}

function isFileKey(s: unknown): s is FileKey {
  return typeof s === "string" && (s === "products" || s === "state" || s === "cohort");
}

export async function POST(request: NextRequest) {
  try {
    const key = request.headers.get("x-admin-key");
    if (key !== "jaxy2026") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await request.json() as {
      action?: string;
      file?: string;
      data?: string;
      chunk?: number;
      dryRun?: boolean;
      limit?: number | null;
      noClassifier?: boolean;
    };

    ensureDir();

    if (body.action === "start") {
      if (body.file && isFileKey(body.file)) {
        // Reset just this one staging file.
        try { fs.unlinkSync(FILES[body.file]); } catch { /* ok */ }
        fs.writeFileSync(FILES[body.file], Buffer.alloc(0));
        return NextResponse.json({ status: "ready", file: body.file, path: FILES[body.file] });
      }
      // No `file` → reset all three.
      for (const k of Object.keys(FILES) as FileKey[]) {
        try { fs.unlinkSync(FILES[k]); } catch { /* ok */ }
        fs.writeFileSync(FILES[k], Buffer.alloc(0));
      }
      return NextResponse.json({ status: "ready", stagingDir: STAGING_DIR });
    }

    if (body.action === "chunk") {
      if (!isFileKey(body.file)) {
        return NextResponse.json({ error: "invalid or missing 'file'" }, { status: 400 });
      }
      if (typeof body.data !== "string" || body.data.length === 0) {
        return NextResponse.json({ error: "missing 'data'" }, { status: 400 });
      }
      const buf = Buffer.from(body.data, "base64");
      fs.appendFileSync(FILES[body.file], buf);
      const size = fs.statSync(FILES[body.file]).size;
      return NextResponse.json({ status: "ok", file: body.file, chunk: body.chunk, size });
    }

    if (body.action === "status") {
      const out: Record<string, unknown> = { stagingDir: STAGING_DIR, dataDir: DATA_DIR };
      for (const k of Object.keys(FILES) as FileKey[]) {
        const p = FILES[k];
        const exists = fs.existsSync(p);
        out[k] = { path: p, exists, size: exists ? fs.statSync(p).size : 0 };
      }
      return NextResponse.json(out);
    }

    if (body.action === "cleanup") {
      let removed = 0;
      for (const k of Object.keys(FILES) as FileKey[]) {
        try { fs.unlinkSync(FILES[k]); removed++; } catch { /* ok */ }
      }
      return NextResponse.json({ status: "cleaned", removed });
    }

    if (body.action === "run") {
      // Validate all three files were uploaded.
      for (const k of Object.keys(FILES) as FileKey[]) {
        if (!fs.existsSync(FILES[k])) {
          return NextResponse.json(
            { error: `Missing staging file: ${k} (${FILES[k]}). Upload via action='chunk' first.` },
            { status: 400 },
          );
        }
      }

      // Buffer log lines so the operator gets the full run trace
      // back in the JSON response — a Railway tail-of-logs is
      // also useful but this is faster for one-off triggers.
      const lines: string[] = [];
      const result = await runEyewearImport({
        productsCsv: FILES.products,
        stateLog: FILES.state,
        cohortCsv: FILES.cohort,
        dryRun: body.dryRun,
        limit: body.limit ?? null,
        noClassifier: body.noClassifier,
        log: (s) => lines.push(s),
      });

      return NextResponse.json({
        status: "done",
        ...result,
        log: lines,
      });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json(
      { error: e.message, stack: e.stack?.split("\n").slice(0, 5) },
      { status: 500 },
    );
  }
}
