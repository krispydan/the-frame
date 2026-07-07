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
  rankTypes: RankType[];
  errors: string[];
}

/**
 * Pull the current charts and REPLACE our snapshot for each
 * (countryCode, rankType) slice. Throws only on config/HTTP failure of
 * the whole call; malformed items are counted in `skipped`.
 */
export async function syncTrendingSounds(opts: {
  countryCode?: string;
  rankTypes?: RankType[];
  limit?: number;
} = {}): Promise<SyncResult> {
  const token = resolveApifyToken();
  if (!token) {
    throw new Error("Apify not configured — set APIFY_API_TOKEN env or settings.apify_api_token");
  }

  const countryCode = (opts.countryCode ?? process.env.TIKTOK_SOUNDS_COUNTRY ?? "US").toUpperCase();
  const rankTypes = opts.rankTypes ?? (["popular", "breakout"] as RankType[]);
  const limit = Math.min(Math.max(opts.limit ?? 30, 5), 100);

  const result: SyncResult = { synced: 0, skipped: 0, countryCode, rankTypes, errors: [] };

  for (const rankType of rankTypes) {
    // Input mirrors TikTok Creative Center's parameters, which this
    // actor family passes through. Unknown fields are ignored by the
    // actor, so sending generous aliases is safe.
    const input = {
      countryCode,
      country_code: countryCode,
      period: 7,
      rankType,
      rank_type: rankType,
      limit,
      maxItems: limit,
      commercial_music: false,
    };

    const url = `${APIFY_BASE}/acts/${ACTOR_TIKTOK_SOUNDS}/run-sync-get-dataset-items?token=${token}&timeout=300`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      result.errors.push(`${rankType}: Apify HTTP ${res.status}: ${text.slice(0, 300)}`);
      continue;
    }
    const items = (await res.json()) as RawItem[];
    if (!Array.isArray(items)) {
      result.errors.push(`${rankType}: non-array response`);
      continue;
    }

    const mapped = items
      .map((item, i) => mapSoundItem(item, i))
      .filter((m): m is MappedSound => m !== null);
    result.skipped += items.length - mapped.length;
    if (mapped.length === 0) {
      result.errors.push(`${rankType}: 0 usable items out of ${items.length}`);
      continue; // keep the previous snapshot rather than wiping it
    }

    // Replace this chart slice atomically.
    const now = new Date().toISOString();
    const replace = sqlite.transaction(() => {
      sqlite
        .prepare(`DELETE FROM marketing_tiktok_sounds WHERE country_code = ? AND rank_type = ?`)
        .run(countryCode, rankType);
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
          m.usageCount, countryCode, rankType, m.isPromoted ? 1 : 0, m.raw, now,
        );
      }
    });
    replace();
    result.synced += mapped.length;
  }

  if (result.synced === 0 && result.errors.length > 0) {
    throw new Error(`TikTok sounds sync failed: ${result.errors.join(" | ")}`);
  }
  console.info(
    `[tiktok-sounds] synced ${result.synced} sounds (${countryCode}, ${rankTypes.join("+")})` +
    (result.errors.length ? ` — partial errors: ${result.errors.join(" | ")}` : ""),
  );
  return result;
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
