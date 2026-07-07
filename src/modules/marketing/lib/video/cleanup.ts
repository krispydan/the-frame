/**
 * Disk hygiene + permutation-space telemetry for the video pipeline.
 *
 * Runs weekly via the `video-storage-hygiene` cron:
 *   - deletes render files for posts POSTED more than RETAIN_DAYS ago
 *     (the post row + caption stay; only the mp4/jpg go)
 *   - deletes render files for discarded/failed posts
 *   - sweeps stale tmp/ leftovers (crashed renders)
 *   - reports disk usage + permutation headroom per recipe
 *
 * Raw + normalized CLIPS are never touched — they're the reusable
 * asset. Renders are cheap to regenerate (stream-copy concat).
 */
import { readdir, stat, unlink } from "fs/promises";
import path from "path";
import { sqlite, db } from "@/lib/db";
import { videoRecipes } from "@/modules/marketing/schema";
import { getVideoFullPath, videosRoot, deleteVideo } from "@/lib/storage/videos";
import { parsePattern, recipeSatisfiable } from "./composer";
import { loadComposerClips } from "./scheduler";

const RETAIN_POSTED_DAYS = 60;
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function dirSizeBytes(rel: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try {
          total += (await stat(full)).size;
        } catch { /* raced deletion */ }
      }
    }
  }
  await walk(path.join(videosRoot(), rel));
  return total;
}

/**
 * Falling-factorial estimate of how many DISTINCT sequences a recipe
 * can still produce, given the current ready library. Deliberately
 * rough (ignores duration/variety constraints) — its job is to say
 * "plenty" vs "running dry", not to be exact. Capped at 1e6.
 */
export function estimateRecipeHeadroom(
  patternJson: string,
  clipCountByCategory: Map<string, number>,
): number {
  let slots;
  try {
    slots = parsePattern({ patternJson } as Parameters<typeof parsePattern>[0]);
  } catch {
    return 0;
  }
  let estimate = 1;
  const consumed = new Map<string, number>();
  for (const slot of slots) {
    const pool = slot.categories.reduce(
      (sum, cat) => sum + Math.max((clipCountByCategory.get(cat) ?? 0) - (consumed.get(cat) ?? 0), 0),
      0,
    );
    const take = Math.min(slot.min || 1, pool);
    if (take < (slot.optional ? 0 : slot.min)) return 0;
    // ordered arrangements: pool * (pool-1) * ... take times
    for (let i = 0; i < take; i++) estimate *= Math.max(pool - i, 1);
    // spread consumption evenly across the slot's categories
    for (const cat of slot.categories) {
      consumed.set(cat, (consumed.get(cat) ?? 0) + take / slot.categories.length);
    }
    if (estimate > 1e6) return 1e6;
  }
  return Math.floor(estimate);
}

export interface HygieneReport {
  deletedRenderFiles: number;
  sweptTmpFiles: number;
  diskUsage: { clipsBytes: number; rendersBytes: number; tmpBytes: number };
  library: { readyClips: number; byCategory: Record<string, number> };
  recipes: Array<{ name: string; satisfiable: boolean; estimatedHeadroom: number }>;
  usedPermutations: number;
  warnings: string[];
}

export async function runVideoStorageHygiene(): Promise<HygieneReport> {
  const warnings: string[] = [];
  let deletedRenderFiles = 0;

  // ── 1. Renders for posts posted > RETAIN_POSTED_DAYS ago ──
  const cutoff = new Date(Date.now() - RETAIN_POSTED_DAYS * 86400000).toISOString();
  const expired = sqlite.prepare(`
    SELECT id, file_path AS filePath, poster_path AS posterPath
    FROM marketing_video_posts
    WHERE status = 'posted' AND posted_at < ? AND file_path IS NOT NULL
  `).all(cutoff) as Array<{ id: string; filePath: string; posterPath: string | null }>;

  // ── 2. Renders for discarded/failed posts ──
  const dead = sqlite.prepare(`
    SELECT id, file_path AS filePath, poster_path AS posterPath
    FROM marketing_video_posts
    WHERE status IN ('discarded','failed') AND file_path IS NOT NULL
  `).all() as Array<{ id: string; filePath: string; posterPath: string | null }>;

  for (const post of [...expired, ...dead]) {
    await deleteVideo(post.filePath).catch(() => {});
    if (post.posterPath) await deleteVideo(post.posterPath).catch(() => {});
    sqlite.prepare(
      `UPDATE marketing_video_posts SET file_path = NULL, poster_path = NULL, updated_at = datetime('now') WHERE id = ?`,
    ).run(post.id);
    deletedRenderFiles++;
  }

  // ── 3. Sweep stale tmp/ files ──
  let sweptTmpFiles = 0;
  try {
    const tmpDir = getVideoFullPath("tmp");
    const entries = await readdir(tmpDir).catch(() => [] as string[]);
    for (const name of entries) {
      const full = path.join(tmpDir, name);
      try {
        const s = await stat(full);
        if (s.isFile() && Date.now() - s.mtimeMs > TMP_MAX_AGE_MS) {
          await unlink(full);
          sweptTmpFiles++;
        }
      } catch { /* raced */ }
    }
  } catch { /* tmp dir may not exist yet */ }

  // ── 4. Library + headroom telemetry ──
  const clips = loadComposerClips();
  const byCategory: Record<string, number> = {};
  const countMap = new Map<string, number>();
  for (const clip of clips) {
    byCategory[clip.categorySlug] = (byCategory[clip.categorySlug] ?? 0) + 1;
    countMap.set(clip.categorySlug, (countMap.get(clip.categorySlug) ?? 0) + 1);
  }

  const recipes = db.select().from(videoRecipes).all().map((r) => {
    const headroom = estimateRecipeHeadroom(r.patternJson, countMap);
    const satisfiable = r.enabled === 1 && recipeSatisfiable(r, clips);
    if (r.enabled === 1 && satisfiable && headroom < 50) {
      warnings.push(`Recipe "${r.name}" is running out of fresh permutations (~${headroom} left) — upload more clips`);
    }
    if (r.enabled === 1 && !satisfiable) {
      warnings.push(`Recipe "${r.name}" cannot be satisfied by the current library`);
    }
    return { name: r.name, satisfiable, estimatedHeadroom: headroom };
  });

  const usedPermutations = (sqlite.prepare(
    `SELECT COUNT(*) AS c FROM marketing_video_posts WHERE status NOT IN ('failed')`,
  ).get() as { c: number }).c;

  const [clipsBytes, rendersBytes, tmpBytes] = await Promise.all([
    dirSizeBytes("clips"),
    dirSizeBytes("renders"),
    dirSizeBytes("tmp"),
  ]);

  const report: HygieneReport = {
    deletedRenderFiles,
    sweptTmpFiles,
    diskUsage: { clipsBytes, rendersBytes, tmpBytes },
    library: { readyClips: clips.length, byCategory },
    recipes,
    usedPermutations,
    warnings,
  };

  if (warnings.length > 0) console.warn(`[video] hygiene warnings: ${warnings.join(" | ")}`);
  return report;
}
