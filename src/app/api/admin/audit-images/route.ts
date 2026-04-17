/**
 * GET /api/admin/audit-images
 *
 * Read-only audit: checks every approved catalog_images row against the
 * /data/images volume and classifies missing files as:
 *  - stale_duplicate: a newer approved sibling exists and its file is on disk
 *  - stale_no_replacement: newer sibling exists but ALSO missing
 *  - truly_missing: this row is the newest and nothing is on disk
 *
 * Dedup key: (sku_id, source, image_type_id, position)
 *
 * Auth: x-admin-key: jaxy2026
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";
import { imageStat, imagesRoot, getFullPath } from "@/lib/storage/local";
import { requireAdmin } from "@/lib/admin-auth";
import { stat } from "fs/promises";

type Row = {
  id: string;
  sku_id: string;
  source: string | null;
  image_type_id: string | null;
  position: number | null;
  file_path: string;
  checksum: string | null;
  created_at: string;
};

type Classification = "stale_duplicate" | "stale_no_replacement" | "truly_missing";

const BATCH_SIZE = 50;

function groupKey(r: Pick<Row, "sku_id" | "source" | "image_type_id" | "position">): string {
  return `${r.sku_id}|${r.source ?? ""}|${r.image_type_id ?? ""}|${r.position ?? 0}`;
}

export async function GET(request: NextRequest) {
  const deny = requireAdmin(request);
  if (deny) return deny;

  const { searchParams } = request.nextUrl;
  if (searchParams.get("debug") === "1") {
    const testPath = searchParams.get("path") || "f9869e4b-9b17-419d-a893-a1e33b87212c/square/f8849cd5929998a8.jpg";
    const fs = await import("fs/promises");
    const pathMod = await import("path");

    async function statOne(abs: string) {
      try {
        const s = await fs.stat(abs);
        return { size: s.size, isFile: s.isFile(), mtime: s.mtime.toISOString() };
      } catch (e: unknown) {
        return { error: (e as Error).message, code: (e as NodeJS.ErrnoException)?.code };
      }
    }
    async function readdir(abs: string) {
      try {
        const d = await fs.readdir(abs);
        return { count: d.length, sample: d.slice(0, 10) };
      } catch (e: unknown) {
        return { error: (e as Error).message, code: (e as NodeJS.ErrnoException)?.code };
      }
    }

    const resolved = getFullPath(testPath);
    return NextResponse.json({
      imagesRoot: imagesRoot(),
      env_IMAGES_PATH: process.env.IMAGES_PATH ?? null,
      env_DATA_DIR: process.env.DATA_DIR ?? null,
      env_DATABASE_URL: process.env.DATABASE_URL ?? null,
      env_DATABASE_PATH: process.env.DATABASE_PATH ?? null,
      cwd: process.cwd(),
      testPath,
      currentResolved: resolved,
      stat_via_helper: await statOne(resolved),
      stat_app_data_images: await statOne(pathMod.join("/app", "data", "images", testPath)),
      stat_data_images: await statOne(pathMod.join("/data", "images", testPath)),
      stat_data: await statOne("/data"),
      readdir_data: await readdir("/data"),
      readdir_data_images: await readdir("/data/images"),
      readdir_app_data: await readdir("/app/data"),
      readdir_app_data_images: await readdir("/app/data/images"),
    });
  }

  const rows = sqlite.prepare(`
    SELECT id, sku_id, source, image_type_id, position, file_path, checksum, created_at
    FROM catalog_images
    WHERE status = 'approved' AND file_path IS NOT NULL AND file_path != ''
  `).all() as Row[];

  // Check file existence in parallel batches
  const exists = new Map<string, boolean>();
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (r) => [r.id, (await imageStat(r.file_path)).exists] as const));
    for (const [id, e] of results) exists.set(id, e);
  }

  // Group rows by dedup key, keep newest first
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = groupKey(r);
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }

  type MissingEntry = {
    row: Row;
    classification: Classification;
    newer?: Row;
  };

  const missing: MissingEntry[] = [];

  for (const r of rows) {
    if (exists.get(r.id)) continue;

    const siblings = groups.get(groupKey(r))!;
    const newerSiblings = siblings.filter((s) => s.created_at > r.created_at);

    if (newerSiblings.length === 0) {
      missing.push({ row: r, classification: "truly_missing" });
    } else {
      // Is any newer sibling actually on disk?
      const newerOnDisk = newerSiblings.find((s) => exists.get(s.id));
      if (newerOnDisk) {
        missing.push({ row: r, classification: "stale_duplicate", newer: newerOnDisk });
      } else {
        missing.push({ row: r, classification: "stale_no_replacement", newer: newerSiblings[0] });
      }
    }
  }

  // Aggregate per-source
  type SourceBucket = {
    total: number;
    missing: number;
    stale_duplicate: number;
    stale_no_replacement: number;
    truly_missing: number;
  };
  const bySource: Record<string, SourceBucket> = {};
  const bucket = (s: string | null): SourceBucket => {
    const k = s ?? "(null)";
    if (!bySource[k]) bySource[k] = { total: 0, missing: 0, stale_duplicate: 0, stale_no_replacement: 0, truly_missing: 0 };
    return bySource[k];
  };
  for (const r of rows) bucket(r.source).total++;
  for (const m of missing) {
    const b = bucket(m.row.source);
    b.missing++;
    b[m.classification]++;
  }

  const staleDuplicateSample = missing
    .filter((m) => m.classification === "stale_duplicate")
    .slice(0, 20)
    .map((m) => ({
      id: m.row.id,
      sku_id: m.row.sku_id,
      source: m.row.source,
      file_path: m.row.file_path,
      newer_id: m.newer?.id,
      newer_file_path: m.newer?.file_path,
    }));

  const trulyMissing = missing
    .filter((m) => m.classification === "truly_missing")
    .map((m) => ({
      id: m.row.id,
      sku_id: m.row.sku_id,
      source: m.row.source,
      image_type_id: m.row.image_type_id,
      position: m.row.position,
      file_path: m.row.file_path,
      checksum: m.row.checksum,
      created_at: m.row.created_at,
    }));

  const staleNoReplacement = missing
    .filter((m) => m.classification === "stale_no_replacement")
    .slice(0, 20)
    .map((m) => ({
      id: m.row.id,
      sku_id: m.row.sku_id,
      source: m.row.source,
      file_path: m.row.file_path,
      newer_id: m.newer?.id,
      newer_file_path: m.newer?.file_path,
    }));

  return NextResponse.json({
    total_approved: rows.length,
    missing_total: missing.length,
    by_source: bySource,
    stale_duplicate_sample: staleDuplicateSample,
    stale_no_replacement_sample: staleNoReplacement,
    truly_missing: trulyMissing,
  });
}
