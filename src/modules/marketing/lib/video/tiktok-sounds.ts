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

/** String OR number id (accepts numeric ids; number stringified). */
function idStr(item: RawItem, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** First URL from either a flat string field or TikTok's nested
 *  { url_list: [...] } image/audio object. */
function urlFrom(item: RawItem, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      const list = (v as { url_list?: unknown }).url_list;
      if (Array.isArray(list) && typeof list[0] === "string" && list[0]) return list[0];
    }
  }
  return null;
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

export interface MappedSound {
  externalId: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
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
 * Map one actor dataset item → our columns.
 *
 * Primary shape (novi~tiktok-music-trend-api = TikTok's raw music
 * object): {id (number), id_str, mid, title, author, duration (sec),
 * user_count, cover_thumb/medium/large:{url_list:[…]}, play_url:{…}}.
 * There's NO rank or trend field — chart position is the array order.
 *
 * Also tolerates older Creative-Center / scraper field names via the
 * alias lists, and never drops an item that has a title (id falls back
 * to a title-derived slug) so a naming change degrades to sparse rows,
 * not silent loss.
 */
export function mapSoundItem(item: RawItem, position: number): MappedSound | null {
  const title = str(item, "title", "musicName", "music_name", "name", "song_name", "clip_title");
  if (!title) return null; // truly empty/error row

  // Prefer string ids (id_str/mid). The numeric `id` is deliberately
  // EXCLUDED — JS rounds it (…392000 vs the real …391617), so it's a
  // wrong id. No string id → a title-derived slug.
  const externalId =
    idStr(item, "id_str", "mid", "song_id", "songId", "music_id", "musicId", "clip_id", "clipId") ??
    `${slugify(title)}-${position}`;

  const rankDiff = num(item, "rank_diff", "rankDiff", "rank_change");
  const diffType = num(item, "rank_diff_type", "rankDiffType");
  // Creative Center diff types: 1=up, 2=down, 3=flat, 4=new. This actor
  // ships none of them → trendDirection stays null (no trend signal).
  let trendDirection: string | null = null;
  if (diffType === 4) trendDirection = "new";
  else if (diffType === 1 || (rankDiff ?? 0) > 0) trendDirection = "up";
  else if (diffType === 2 || (rankDiff ?? 0) < 0) trendDirection = "down";
  else if (rankDiff !== null || diffType !== null) trendDirection = "flat";

  const cover = urlFrom(item, "cover_thumb", "cover_medium", "cover_large", "cover_url", "coverUrl", "cover", "avatar");
  // Direct audio stream for inline preview (no trip to TikTok).
  const preview = urlFrom(item, "play_url", "playUrl", "play_url_list", "audio_url", "audioUrl", "music_url_full");
  // No share link in the payload — build the standard TikTok music page
  // URL from title + id (resolves/redirects); fall back to the audio url.
  const link =
    str(item, "link", "url", "music_url", "musicUrl", "share_url", "song_url") ??
    (externalId ? `https://www.tiktok.com/music/${slugify(title)}-${externalId}` : null) ??
    preview;

  return {
    externalId,
    title,
    author: str(item, "author", "authorName", "author_name", "artist", "artist_name"),
    coverUrl: cover,
    previewUrl: preview,
    tiktokLink: link,
    durationSec: num(item, "duration", "duration_sec", "durationSec", "music_duration"),
    rank: num(item, "rank", "chart_rank") ?? position + 1, // no rank field → array order
    rankDiff,
    trendDirection,
    usageCount: num(item, "user_count", "if_use_songs", "userCount", "video_count", "videoCount", "usage_count", "use_count"),
    isPromoted: item["is_original"] === true,
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

// ── Sync (run-sync-get-dataset-items — one call, returns items directly) ──
//
// The actor takes ~4-5 min and returns ~26 items. We call it ONCE from a
// background job (no browser connection to time out → no retry storms),
// derive breakout/popular from each item's trend, and replace the
// country snapshot. Every raw item is kept, the first item's shape is
// LOGGED (actor field naming can't be inspected from CI), and the mapper
// never drops an item that carries any data — so a naming surprise shows
// up as saved-but-sparse rows + a log line, not silent nothing.

const RUN_TIMEOUT_SECS = 600;
const FETCH_ABORT_MS = 7 * 60_000;

/**
 * Sync the trending chart with ONE actor run and replace the whole
 * country snapshot. Safe to retry (the background job guards duplicates).
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

  // run-sync-get-dataset-items returns the dataset rows directly, so
  // there's no run-status polling to mis-read. The connection is held
  // ~4-5min server-side (fine — no browser), capped by an abort timer.
  const url = `${APIFY_BASE}/acts/${ACTOR_TIKTOK_SOUNDS}/run-sync-get-dataset-items?token=${token}&timeout=${RUN_TIMEOUT_SECS}`;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), FETCH_ABORT_MS);
  let items: RawItem[];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    items = Array.isArray(data) ? (data as RawItem[]) : [];
  } finally {
    clearTimeout(abortTimer);
  }

  // Diagnostic — reveals the actor's REAL field names in Railway logs so
  // the mapper can be perfected (we can't reach Apify from CI to inspect).
  if (items.length > 0) {
    console.info(`[tiktok-sounds] ${items.length} items; first item keys: ${Object.keys(items[0]).join(", ")}`);
    console.info(`[tiktok-sounds] first item: ${JSON.stringify(items[0]).slice(0, 800)}`);
  }

  const mapped = items
    .map((item, i) => mapSoundItem(item, i))
    .filter((m): m is MappedSound => m !== null);
  result.skipped = items.length - mapped.length;
  if (mapped.length === 0) {
    // Keep the previous snapshot rather than wiping it to nothing.
    throw new Error(`0 usable items out of ${items.length} — snapshot left unchanged (see logs for item shape)`);
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
        (id, external_id, title, author, cover_url, preview_url, tiktok_link, duration_sec,
         rank, rank_diff, trend_direction, usage_count, country_code, rank_type,
         is_promoted, raw, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const m of mapped) {
      insert.run(
        crypto.randomUUID(), m.externalId, m.title, m.author, m.coverUrl,
        m.previewUrl, m.tiktokLink, m.durationSec, m.rank, m.rankDiff, m.trendDirection,
        m.usageCount, countryCode, rankTypeOf(m), m.isPromoted ? 1 : 0, m.raw, now,
      );
    }
  });
  replace();
  result.synced = mapped.length;

  console.info(`[tiktok-sounds] synced ${result.synced} sounds (${countryCode})`);
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
