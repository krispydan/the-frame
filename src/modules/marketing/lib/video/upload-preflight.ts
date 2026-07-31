/**
 * Upload preflight + repair — "re-upload everything, only ingest what's new".
 *
 * The library already dedupes by content checksum (both clips and sources
 * have a UNIQUE checksum column, and /register returns the existing row).
 * But that check runs AFTER the browser has hashed the file and pushed
 * every byte to R2 — so re-dropping a shoot folder costs a full re-upload
 * to learn we already had it.
 *
 * Preflight moves the question earlier, to the only key available before
 * reading a single byte: FILE NAME + SIZE. It's a hint, not proof, so it
 * is used only to SKIP work — anything it isn't sure about still uploads
 * and still hits the checksum gate at /register. Two tiers, and the cheap
 * one can only ever cause extra work, never a wrong ingest.
 *
 * The subtle part is that "already in the system" must NOT mean "skip".
 * A failed upload usually LEFT A ROW BEHIND (status='failed'), so naive
 * dedupe would skip precisely the files the operator is re-uploading to
 * fix. Hence three verdicts:
 *
 *   skip    — we have a healthy copy; don't upload
 *   repair  — we have the row AND the bytes, only the job failed;
 *             re-run the job instead of re-uploading 400MB
 *   upload  — genuinely new, or the bytes are gone
 */
import { db, sqlite } from "@/lib/db";
import { videoClips, videoSources } from "@/modules/marketing/schema";
import { eq } from "drizzle-orm";
import { videoStat, listVideos } from "@/lib/storage/videos";
import { jobQueue } from "@/modules/core/lib/job-queue";

export type PreflightVerdict = "skip" | "repair" | "upload";
export type UploadKind = "clip" | "source";

export interface PreflightFile {
  fileName: string;
  sizeBytes: number;
}

export interface PreflightResult extends PreflightFile {
  verdict: PreflightVerdict;
  /** Short human sentence for the UI — why this file got its verdict. */
  reason: string;
  /** Which table matched, if any. */
  kind: UploadKind | null;
  id: string | null;
  status: string | null;
  /** For a matched source: how many clips it produced. */
  clipCount?: number;
}

export interface PreflightSummary {
  total: number;
  skip: number;
  repair: number;
  upload: number;
}

/**
 * A clip whose status means "we're done with it, don't touch it".
 * `archived` counts as done ON PURPOSE — someone archived that clip, and
 * a re-upload must not quietly resurrect it.
 */
const HEALTHY_CLIP_STATUS = new Set(["ready", "archived"]);

interface ClipMatch {
  id: string;
  status: string;
  rawPath: string;
}
interface SourceMatch {
  id: string;
  status: string;
  rawPath: string;
  rawDeleted: number;
  clipCount: number;
}

/**
 * Look a file up by name+size in BOTH tables.
 *
 * Both, regardless of the uploader's auto-clip toggle: the same file
 * lands in `sources` with auto-clip on and in `clips` with it off, and
 * re-dropping it with the toggle flipped shouldn't ingest it twice.
 *
 * size_bytes is NULL on some early rows; those simply don't match here
 * and fall through to a normal upload + checksum dedupe.
 */
function findByNameSize(fileName: string, sizeBytes: number): { clip?: ClipMatch; source?: SourceMatch } {
  const clip = sqlite
    .prepare(
      `SELECT id, status, raw_path AS rawPath
         FROM marketing_video_clips
        WHERE file_name = ? AND size_bytes = ?
        ORDER BY CASE status WHEN 'ready' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END
        LIMIT 1`,
    )
    .get(fileName, sizeBytes) as ClipMatch | undefined;

  const source = sqlite
    .prepare(
      // clip_count is what the split actually PRODUCED, not how many
      // clips still exist. That's the right question here — "did this
      // upload work?" — and it means clips the operator deliberately
      // deleted afterwards don't get silently re-extracted.
      `SELECT s.id, s.status, s.raw_path AS rawPath, s.raw_deleted AS rawDeleted,
              s.clip_count AS clipCount
         FROM marketing_video_sources s
        WHERE s.file_name = ? AND s.size_bytes = ?
        ORDER BY CASE s.status WHEN 'done' THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .get(fileName, sizeBytes) as SourceMatch | undefined;

  return { clip, source };
}

/** Decide one file's fate. Async only because it may HEAD the storage. */
async function verdictFor(file: PreflightFile): Promise<PreflightResult> {
  const base = { ...file, kind: null, id: null, status: null } as PreflightResult;
  if (!file.fileName || !Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
    return { ...base, verdict: "upload", reason: "New — no name/size to match on" };
  }

  const { clip, source } = findByNameSize(file.fileName, file.sizeBytes);

  // ── Source (auto-clip) match takes precedence: it's the path most
  // uploads take, and one source stands in for many clips. ──
  if (source) {
    const s = { ...base, kind: "source" as const, id: source.id, status: source.status, clipCount: source.clipCount };
    if (source.status === "done" && source.clipCount > 0) {
      return { ...s, verdict: "skip", reason: `Already clipped into ${source.clipCount} clips` };
    }
    // Not done (or done with nothing to show for it). Can we fix it
    // without making them upload the footage again?
    const rawPresent = source.rawDeleted === 0 && (await videoStat(source.rawPath)).exists;
    if (rawPresent) {
      return {
        ...s,
        verdict: "repair",
        reason:
          source.status === "failed"
            ? "Split failed but the footage is still here — can re-run it"
            : "Uploaded but never finished splitting — can re-run it",
      };
    }
    return {
      ...s,
      verdict: "upload",
      reason:
        source.clipCount === 0
          ? "Previous upload produced no clips and the footage is gone"
          : "Footage was deleted — needs re-uploading",
    };
  }

  // ── Single-clip match ──
  if (clip) {
    const c = { ...base, kind: "clip" as const, id: clip.id, status: clip.status };
    if (HEALTHY_CLIP_STATUS.has(clip.status)) {
      return {
        ...c,
        verdict: "skip",
        reason: clip.status === "archived" ? "Already here (archived)" : "Already in the library",
      };
    }
    const rawPresent = (await videoStat(clip.rawPath)).exists;
    if (rawPresent) {
      return {
        ...c,
        verdict: "repair",
        reason:
          clip.status === "failed"
            ? "Processing failed but the file is still here — can re-run it"
            : "Uploaded but never finished processing — can re-run it",
      };
    }
    return { ...c, verdict: "upload", reason: "File is missing from storage — needs re-uploading" };
  }

  return { ...base, verdict: "upload", reason: "New" };
}

/** Preflight a whole batch. Order is preserved so the UI can zip results. */
export async function preflightFiles(
  files: PreflightFile[],
): Promise<{ results: PreflightResult[]; summary: PreflightSummary }> {
  const results: PreflightResult[] = [];
  for (const f of files) results.push(await verdictFor(f));
  return {
    results,
    summary: {
      total: results.length,
      skip: results.filter((r) => r.verdict === "skip").length,
      repair: results.filter((r) => r.verdict === "repair").length,
      upload: results.filter((r) => r.verdict === "upload").length,
    },
  };
}

// ── Repair ──────────────────────────────────────────────────────────────

export interface RepairTarget {
  kind: UploadKind;
  id: string;
}
export interface RepairResult {
  requeued: number;
  skipped: number;
  errors: string[];
}

/**
 * Re-run the processing job for rows whose BYTES survived — the whole
 * point being that a failed normalize/split needs no upload at all.
 *
 * A source is reset off `done`/`failed` first: splitSource() early-returns
 * on status='done', so a source that "finished" with zero clips would
 * otherwise no-op forever.
 */
export async function repairUploads(targets: RepairTarget[]): Promise<RepairResult> {
  let requeued = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const t of targets) {
    try {
      if (t.kind === "clip") {
        const clip = db.select().from(videoClips).where(eq(videoClips.id, t.id)).get();
        if (!clip) {
          errors.push(`clip ${t.id}: no such clip`);
          continue;
        }
        if (!(await videoStat(clip.rawPath)).exists) {
          skipped++; // bytes gone — only a real re-upload fixes this
          continue;
        }
        db.update(videoClips)
          .set({ status: "uploaded", error: null, updatedAt: new Date().toISOString() })
          .where(eq(videoClips.id, clip.id))
          .run();
        jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId: clip.id }, { priority: 3 });
        requeued++;
      } else {
        const source = db.select().from(videoSources).where(eq(videoSources.id, t.id)).get();
        if (!source) {
          errors.push(`source ${t.id}: no such source`);
          continue;
        }
        if (source.rawDeleted === 1 || !(await videoStat(source.rawPath)).exists) {
          skipped++;
          continue;
        }
        db.update(videoSources)
          .set({ status: "uploaded", error: null, updatedAt: new Date().toISOString() })
          .where(eq(videoSources.id, source.id))
          .run();
        jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: source.id }, { priority: 3 });
        requeued++;
      }
    } catch (e) {
      errors.push(`${t.kind} ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { requeued, skipped, errors };
}

// ── Orphan adoption ─────────────────────────────────────────────────────

export interface AdoptResult {
  adopted: number;
  skipped: number;
  errors: string[];
}

/**
 * Turn orphaned storage objects into real rows so the bytes stop being
 * invisible. Recovers uploads whose /register never landed.
 *
 * What's lost is the metadata, not the footage: the object key is
 * `{checksum}.{ext}`, so the original file name and the batch's
 * category/product tags are gone. The row is created UNTAGGED and the
 * caller tells the operator to tag it — untagged clips never enter the
 * composer, so nothing half-known leaks into a published video.
 */
export async function adoptOrphans(paths: string[]): Promise<AdoptResult> {
  let adopted = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const rawPath of paths) {
    try {
      const match = /^(clips\/raw|sources)\/([0-9a-f]{16})\.([a-z0-9]+)$/.exec(rawPath);
      if (!match) {
        skipped++; // not a content-addressed raw object — leave it alone
        continue;
      }
      const [, dir, checksum, ext] = match;
      const kind: UploadKind = dir === "sources" ? "source" : "clip";

      const stat = await videoStat(rawPath);
      if (!stat.exists) {
        skipped++;
        continue;
      }

      if (kind === "clip") {
        if (db.select().from(videoClips).where(eq(videoClips.checksum, checksum)).get()) {
          skipped++;
          continue;
        }
        const id = crypto.randomUUID();
        db.insert(videoClips)
          .values({
            id,
            fileName: `${checksum}.${ext}`,
            checksum,
            rawPath,
            sizeBytes: stat.size,
            status: "uploaded",
            notes: "Recovered from storage — upload never registered. Needs tagging.",
          })
          .run();
        jobQueue.enqueue("marketing.video.normalize-clip", "marketing", { clipId: id }, { priority: 3 });
      } else {
        if (db.select().from(videoSources).where(eq(videoSources.checksum, checksum)).get()) {
          skipped++;
          continue;
        }
        const id = crypto.randomUUID();
        db.insert(videoSources)
          .values({
            id,
            fileName: `${checksum}.${ext}`,
            checksum,
            rawPath,
            sizeBytes: stat.size,
            status: "uploaded",
          })
          .run();
        jobQueue.enqueue("marketing.video.split-source", "marketing", { sourceId: id }, { priority: 3 });
      }
      adopted++;
    } catch (e) {
      errors.push(`${rawPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { adopted, skipped, errors };
}

// ── Health report ───────────────────────────────────────────────────────

export interface BrokenRow {
  kind: UploadKind;
  id: string;
  fileName: string;
  status: string;
  error: string | null;
  /** True when the raw bytes are still in storage → repairable in place. */
  repairable: boolean;
  createdAt: string | null;
}

export interface OrphanObject {
  kind: UploadKind;
  path: string;
  sizeBytes: number;
}

export interface UploadHealthReport {
  clips: { total: number; ready: number; failed: number; stuck: number };
  sources: { total: number; done: number; failed: number; stuck: number; emptyDone: number };
  broken: BrokenRow[];
  /** Bytes in storage with no DB row — an upload whose /register never
   *  landed. These are invisible losses: the file is paid for and stored,
   *  but nothing in the app knows it exists. */
  orphans: OrphanObject[];
  orphansTruncated: boolean;
}

/** A row is "stuck" if it never reached a terminal state. */
const STUCK_CLIP = `status IN ('uploaded','normalizing')`;
const STUCK_SOURCE = `status IN ('uploaded','splitting')`;

const MAX_BROKEN = 200;
const MAX_ORPHANS = 200;

export async function buildUploadHealthReport(): Promise<UploadHealthReport> {
  const clipCounts = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'ready')  AS ready,
              SUM(status = 'failed') AS failed,
              SUM(${STUCK_CLIP})     AS stuck
         FROM marketing_video_clips`,
    )
    .get() as { total: number; ready: number | null; failed: number | null; stuck: number | null };

  const sourceCounts = sqlite
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(status = 'done')   AS done,
              SUM(status = 'failed') AS failed,
              SUM(${STUCK_SOURCE})   AS stuck,
              SUM(status = 'done' AND clip_count = 0) AS emptyDone
         FROM marketing_video_sources`,
    )
    .get() as {
    total: number; done: number | null; failed: number | null; stuck: number | null; emptyDone: number | null;
  };

  const brokenClips = sqlite
    .prepare(
      `SELECT id, file_name AS fileName, status, error, raw_path AS rawPath, created_at AS createdAt
         FROM marketing_video_clips
        WHERE status = 'failed' OR ${STUCK_CLIP}
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(MAX_BROKEN) as Array<{
    id: string; fileName: string; status: string; error: string | null; rawPath: string; createdAt: string | null;
  }>;

  const brokenSources = sqlite
    .prepare(
      `SELECT id, file_name AS fileName, status, error, raw_path AS rawPath,
              raw_deleted AS rawDeleted, created_at AS createdAt
         FROM marketing_video_sources
        WHERE status = 'failed' OR ${STUCK_SOURCE} OR (status = 'done' AND clip_count = 0)
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(MAX_BROKEN) as Array<{
    id: string; fileName: string; status: string; error: string | null; rawPath: string;
    rawDeleted: number; createdAt: string | null;
  }>;

  const broken: BrokenRow[] = [];
  for (const c of brokenClips) {
    broken.push({
      kind: "clip",
      id: c.id,
      fileName: c.fileName,
      status: c.status,
      error: c.error,
      repairable: (await videoStat(c.rawPath)).exists,
      createdAt: c.createdAt,
    });
  }
  for (const s of brokenSources) {
    broken.push({
      kind: "source",
      id: s.id,
      fileName: s.fileName,
      status: s.status,
      error: s.error,
      repairable: s.rawDeleted === 0 && (await videoStat(s.rawPath)).exists,
      createdAt: s.createdAt,
    });
  }

  const { orphans, truncated } = await findOrphanObjects();

  return {
    clips: {
      total: clipCounts.total,
      ready: clipCounts.ready ?? 0,
      failed: clipCounts.failed ?? 0,
      stuck: clipCounts.stuck ?? 0,
    },
    sources: {
      total: sourceCounts.total,
      done: sourceCounts.done ?? 0,
      failed: sourceCounts.failed ?? 0,
      stuck: sourceCounts.stuck ?? 0,
      emptyDone: sourceCounts.emptyDone ?? 0,
    },
    broken,
    orphans,
    orphansTruncated: truncated,
  };
}

/**
 * Raw objects in storage that no DB row points at.
 *
 * These are the silent losses: the browser PUT the bytes, then the
 * /register call never landed (tab closed, network blip), so the app has
 * no idea the file is there. Nothing surfaces them today — the upload
 * simply looks like it worked.
 */
export async function findOrphanObjects(): Promise<{ orphans: OrphanObject[]; truncated: boolean }> {
  const known = new Set<string>();
  for (const r of sqlite.prepare(`SELECT raw_path FROM marketing_video_clips`).all() as Array<{ raw_path: string }>) {
    known.add(r.raw_path);
  }
  for (const r of sqlite.prepare(`SELECT raw_path FROM marketing_video_sources`).all() as Array<{ raw_path: string }>) {
    known.add(r.raw_path);
  }

  const orphans: OrphanObject[] = [];
  let truncated = false;
  for (const [kind, prefix] of [["clip", "clips/raw/"], ["source", "sources/"]] as const) {
    const objects = await listVideos(prefix);
    for (const o of objects) {
      if (known.has(o.path)) continue;
      if (orphans.length >= MAX_ORPHANS) {
        truncated = true;
        break;
      }
      orphans.push({ kind, path: o.path, sizeBytes: o.sizeBytes });
    }
  }
  return { orphans, truncated };
}
