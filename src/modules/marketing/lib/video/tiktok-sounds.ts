/**
 * TikTok trending sounds — sync + read.
 *
 * Sync pulls the current trending-music charts from the Apify actor
 * `novi~tiktok-music-trend-api` (a relay of TikTok Creative Center's
 * charts) via run-sync-get-dataset-items — same call pattern and token
 * resolution as src/modules/sales/lib/apify-client.ts.
 *
 * Actor field names have drifted across revisions of these scrapers,
 * so the mapper reads every known alias and ALWAYS stores the raw item
 * JSON — if a future revision renames a field, the data is still in
 * `raw` and only the mapper needs a one-line fix.
 *
 * Consumers:
 *   - video-ai.ts feeds the current chart into the caption prompt so
 *     posting instructions can name real sounds.
 *   - the queue UI's Trending Sounds browser + per-post suggestions.
 */
import { db, sqlite } from "@/lib/db";
import { tiktokSounds, type TiktokSound } from "@/modules/marketing/schema";
import { and, asc, eq } from "drizzle-orm";
import { jobQueue } from "@/modules/core/lib/job-queue";

const APIFY_BASE = "https://api.apify.com/v2";

/** Override via env if the actor is renamed or you switch providers. */
const ACTOR_TIKTOK_SOUNDS =
  process.env.APIFY_TIKTOK_SOUNDS_ACTOR_ID || "novi~tiktok-music-trend-api";

export type RankType = "popular" | "breakout";

function resolveApifyToken(): string | null {
  const env = process.env.APIFY_API_TOKEN?.trim();
  if (env) return env;
  try {
    const row = sqlite
      .prepare(`SELECT value FROM settings WHERE key='apify_api_token' LIMIT 1`)
      .get() as { value?: string } | undefined;
    const val = row?.value?.trim();
    return val && val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

// ── Defensive item mapping ──

type RawItem = Record<string, unknown>;

function str(item: RawItem, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function num(item: RawItem, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}

export interface MappedSound {
  externalId: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  tiktokLink: string | null;
  durationSec: number | null;
  rank: number | null;
  rankDiff: number | null;
  trendDirection: string | null;
  usageCount: number | null;
  isPromoted: boolean;
  raw: string;
}

/**
 * Map one actor dataset item → our columns. Returns null for items with
 * no usable id/title (e.g. actor error rows).
 *
 * Known shapes covered: TikTok Creative Center passthrough
 * ({song_id,title,author,cover_url,duration,rank,rank_diff,
 *   rank_diff_type,if_use_songs,link,promoted}) and common scraper
 * variants ({id,music_id,clip_id,musicName,authorName,coverUrl,...}).
 */
export function mapSoundItem(item: RawItem, position: number): MappedSound | null {
  const externalId =
    str(item, "song_id", "songId", "music_id", "musicId", "clip_id", "clipId", "id") ??
    // some revisions only ship a link — derive a stable id from it
    str(item, "link", "url", "music_url")?.replace(/[^a-zA-Z0-9]+/g, "-") ??
    null;
  const title = str(item, "title", "musicName", "music_name", "name", "song_name");
  if (!externalId || !title) return null;

  const rankDiff = num(item, "rank_diff", "rankDiff", "rank_change");
  const diffType = num(item, "rank_diff_type", "rankDiffType");
  // Creative Center diff types: 1=up, 2=down, 3=flat/steady, 4=new.
  let trendDirection: string | null = null;
  if (diffType === 4) trendDirection = "new";
  else if (diffType === 1 || (rankDiff ?? 0) > 0) trendDirection = "up";
  else if (diffType === 2 || (rankDiff ?? 0) < 0) trendDirection = "down";
  else if (rankDiff !== null || diffType !== null) trendDirection = "flat";

  const promoted = item["promoted"] ?? item["is_commercial"] ?? item["isCommercial"];

  return {
    externalId,
    title,
    author: str(item, "author", "authorName", "author_name", "artist", "artist_name"),
    coverUrl: str(item, "cover_url", "coverUrl", "cover", "cover_thumb", "coverThumb", "avatar"),
    tiktokLink: str(item, "link", "url", "music_url", "musicUrl", "share_url", "song_url"),
    durationSec: num(item, "duration", "duration_sec", "durationSec", "music_duration"),
    rank: num(item, "rank", "position", "chart_rank") ?? position + 1,
    rankDiff,
    trendDirection,
    usageCount: num(item, "if_use_songs", "user_count", "userCount", "video_count", "videoCount", "usage_count", "use_count"),
    isPromoted: promoted === true || promoted === 1,
    raw: JSON.stringify(item),
  };
}

// ── Sync ──

export interface SyncResult {
  synced: number;
  skipped: number;
  countryCode: string;
  errors: string[];
}

// ── Apify run lifecycle (async start + poll — cost-safe) ──
//
// We deliberately do NOT use run-sync-get-dataset-items: it holds an
// HTTP connection open for the whole ~4-5min run, so the browser (or a
// proxy) times out and RETRIES, spawning duplicate paid runs. Instead:
//   1. If a run is already in-flight on Apify, attach to it (never
//      start a second — this is the guard against duplicate runs).
//   2. Otherwise start ONE run.
//   3. Poll its status server-side until it finishes, then read the
//      dataset. A broken poll connection re-reads status; it never
//      re-triggers the actor.

const POLL_INTERVAL_MS = 8000;
const MAX_WAIT_MS = 6 * 60_000;
const IN_FLIGHT = new Set(["READY", "RUNNING"]);

interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId?: string;
}

async function apifyJson(url: string, init?: RequestInit): Promise<{ data?: ApifyRun }> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function startOrAttachRun(token: string, input: Record<string, unknown>): Promise<ApifyRun> {
  // Guard: is a run already going? Attach instead of starting another.
  try {
    const last = await apifyJson(`${APIFY_BASE}/acts/${ACTOR_TIKTOK_SOUNDS}/runs/last?token=${token}`);
    if (last.data && IN_FLIGHT.has(last.data.status)) {
      console.info(`[tiktok-sounds] attaching to in-flight run ${last.data.id} (${last.data.status})`);
      return last.data;
    }
  } catch {
    /* no prior run / transient — fall through to start */
  }
  const started = await apifyJson(
    `${APIFY_BASE}/acts/${ACTOR_TIKTOK_SOUNDS}/runs?token=${token}&timeout=300`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
  );
  if (!started.data?.id) throw new Error("Apify did not return a run id");
  return started.data;
}

async function waitForRun(token: string, runId: string): Promise<ApifyRun> {
  const deadline = Date.now() + MAX_WAIT_MS;
  // Check immediately; only sleep between polls (keeps tests fast).
  for (;;) {
    const { data } = await apifyJson(`${APIFY_BASE}/acts/${ACTOR_TIKTOK_SOUNDS}/runs/${runId}?token=${token}`);
    if (!data) throw new Error("Apify run lookup returned no data");
    if (!IN_FLIGHT.has(data.status)) return data; // terminal (SUCCEEDED/FAILED/…)
    if (Date.now() > deadline) {
      throw new Error(`Apify run ${runId} still ${data.status} after ${MAX_WAIT_MS / 1000}s — leaving it; next sync will attach`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

async function fetchDatasetItems(token: string, datasetId: string): Promise<RawItem[]> {
  const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${token}&clean=true&format=json`);
  if (!res.ok) throw new Error(`Apify dataset HTTP ${res.status}`);
  const items = await res.json();
  return Array.isArray(items) ? (items as RawItem[]) : [];
}

/**
 * Sync the trending chart with ONE actor run and replace the whole
 * country snapshot. "breakout" vs "popular" is derived from each
 * sound's own trend signal — no second run needed. Safe to retry: an
 * in-flight run is attached to, never duplicated.
 */
export async function syncTrendingSounds(opts: {
  countryCode?: string;
  limit?: number;
} = {}): Promise<SyncResult> {
  const token = resolveApifyToken();
  if (!token) {
    throw new Error("Apify not configured — set APIFY_API_TOKEN env or settings.apify_api_token");
  }

  const countryCode = (opts.countryCode ?? process.env.TIKTOK_SOUNDS_COUNTRY ?? "US").toUpperCase();
  const limit = Math.min(Math.max(opts.limit ?? 40, 5), 100);
  const result: SyncResult = { synced: 0, skipped: 0, countryCode, errors: [] };

  // Generous aliases — the actor ignores unknown fields.
  const input = {
    countryCode,
    country_code: countryCode,
    period: 7,
    limit,
    maxItems: limit,
    commercial_music: false,
  };

  const run = await startOrAttachRun(token, input);
  const final = await waitForRun(token, run.id);
  if (final.status !== "SUCCEEDED") {
    throw new Error(`Apify run ${run.id} ended ${final.status}`);
  }
  const datasetId = final.defaultDatasetId ?? run.defaultDatasetId;
  if (!datasetId) throw new Error("Apify run has no dataset id");

  const items = await fetchDatasetItems(token, datasetId);
  const mapped = items
    .map((item, i) => mapSoundItem(item, i))
    .filter((m): m is MappedSound => m !== null);
  result.skipped = items.length - mapped.length;
  if (mapped.length === 0) {
    // Keep the previous snapshot rather than wiping it to nothing.
    throw new Error(`0 usable items out of ${items.length} — snapshot left unchanged`);
  }

  // A sound is "breakout" if it's climbing or brand new; everything
  // else is the established "popular" chart. One run feeds both tabs.
  const rankTypeOf = (m: MappedSound): RankType =>
    m.trendDirection === "up" || m.trendDirection === "new" ? "breakout" : "popular";

  const now = new Date().toISOString();
  const replace = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM marketing_tiktok_sounds WHERE country_code = ?`).run(countryCode);
    const insert = sqlite.prepare(`
      INSERT INTO marketing_tiktok_sounds
        (id, external_id, title, author, cover_url, tiktok_link, duration_sec,
         rank, rank_diff, trend_direction, usage_count, country_code, rank_type,
         is_promoted, raw, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of mapped) {
      insert.run(
        crypto.randomUUID(), m.externalId, m.title, m.author, m.coverUrl,
        m.tiktokLink, m.durationSec, m.rank, m.rankDiff, m.trendDirection,
        m.usageCount, countryCode, rankTypeOf(m), m.isPromoted ? 1 : 0, m.raw, now,
      );
    }
  });
  replace();
  result.synced = mapped.length;

  console.info(`[tiktok-sounds] synced ${result.synced} sounds (${countryCode}, run ${run.id})`);
  return result;
}

// ── Guarded enqueue (browser + cron entry point) ──

const SYNC_JOB_TYPE = "marketing.tiktok-sounds.sync";

/** Is a sync job already queued or running? */
export function isSoundsSyncActive(): boolean {
  try {
    const row = sqlite
      .prepare(`SELECT 1 FROM jobs WHERE type = ? AND status IN ('pending','running') LIMIT 1`)
      .get(SYNC_JOB_TYPE);
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Enqueue a sync unless one is already in flight. Returning
 * alreadyRunning (rather than starting a duplicate) is what stops the
 * "clicked twice → paid twice" problem at the app boundary; the
 * Apify-side attach guard covers cross-process races.
 */
export function enqueueSoundsSync(): { enqueued: boolean; alreadyRunning: boolean; jobId?: string } {
  if (isSoundsSyncActive()) return { enqueued: false, alreadyRunning: true };
  const jobId = jobQueue.enqueue(SYNC_JOB_TYPE, "marketing", {}, { priority: 2 });
  return { enqueued: true, alreadyRunning: false, jobId };
}

// ── Read ──

export function getTrendingSounds(opts: {
  rankType?: RankType;
  countryCode?: string;
  limit?: number;
} = {}): TiktokSound[] {
  const conditions = [
    eq(tiktokSounds.countryCode, (opts.countryCode ?? "US").toUpperCase()),
  ];
  if (opts.rankType) conditions.push(eq(tiktokSounds.rankType, opts.rankType));
  return db
    .select()
    .from(tiktokSounds)
    .where(and(...conditions))
    .orderBy(asc(tiktokSounds.rankType), asc(tiktokSounds.rank))
    .limit(opts.limit ?? 60)
    .all();
}

/** Newest sync stamp, or null if never synced. */
export function lastSyncedAt(): string | null {
  try {
    const row = sqlite
      .prepare(`SELECT MAX(synced_at) AS t FROM marketing_tiktok_sounds`)
      .get() as { t: string | null } | undefined;
    return row?.t ?? null;
  } catch {
    return null;
  }
}
