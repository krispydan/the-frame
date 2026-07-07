import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  mapSoundItem,
  syncTrendingSounds,
  getTrendingSounds,
} from "@/modules/marketing/lib/video/tiktok-sounds";

describe("TikTok sounds mapper", () => {
  it("maps a TikTok Creative Center shaped item", () => {
    const mapped = mapSoundItem(
      {
        song_id: "728412",
        title: "cool song",
        author: "cool artist",
        cover_url: "https://p16.example/cover.jpg",
        link: "https://ads.tiktok.com/business/creativecenter/music/728412",
        duration: 42,
        rank: 3,
        rank_diff: 5,
        rank_diff_type: 1,
        if_use_songs: 129000,
        promoted: false,
      },
      2,
    );
    expect(mapped).toMatchObject({
      externalId: "728412",
      title: "cool song",
      author: "cool artist",
      rank: 3,
      rankDiff: 5,
      trendDirection: "up",
      usageCount: 129000,
      isPromoted: false,
    });
    expect(JSON.parse(mapped!.raw).song_id).toBe("728412");
  });

  it("maps an alternate scraper shape (camelCase, different names)", () => {
    const mapped = mapSoundItem(
      {
        musicId: "999",
        musicName: "other song",
        authorName: "someone",
        coverThumb: "https://x/cover.jpg",
        music_url: "https://www.tiktok.com/music/other-song-999",
        durationSec: 15,
        rank_diff_type: 4,
      },
      0,
    );
    expect(mapped).toMatchObject({
      externalId: "999",
      title: "other song",
      author: "someone",
      trendDirection: "new",
      rank: 1, // falls back to position + 1
    });
  });

  it("rejects items with no id/title instead of inserting junk", () => {
    expect(mapSoundItem({ error: "quota" }, 0)).toBeNull();
    expect(mapSoundItem({ title: "nameless" }, 0)).toBeNull();
  });
});

describe("TikTok sounds sync", () => {
  beforeEach(() => {
    resetTestDb();
    process.env.APIFY_API_TOKEN = "test-token";
  });
  afterEach(() => {
    delete process.env.APIFY_API_TOKEN;
    vi.restoreAllMocks();
  });

  const item = (id: string, rank: number) => ({
    song_id: id,
    title: `song ${id}`,
    author: "artist",
    rank,
    rank_diff_type: 3,
  });

  it("stores the chart and replaces it on the next sync", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([item("a", 1), item("b", 2)]), { status: 200 }),
    );

    const first = await syncTrendingSounds({ rankTypes: ["popular"] });
    expect(first.synced).toBe(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain("novi~tiktok-music-trend-api");

    // Second sync returns a different chart — must fully replace.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([item("c", 1)]), { status: 200 }),
    );
    await syncTrendingSounds({ rankTypes: ["popular"] });

    const rows = getTrendingSounds({ rankType: "popular" });
    expect(rows.map((r) => r.externalId)).toEqual(["c"]);
  });

  it("keeps the previous snapshot when a sync returns nothing usable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([item("a", 1)]), { status: 200 }),
    );
    await syncTrendingSounds({ rankTypes: ["popular"] });

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await expect(syncTrendingSounds({ rankTypes: ["popular"] })).rejects.toThrow(/0 usable/);
    expect(getTrendingSounds({ rankType: "popular" })).toHaveLength(1);
  });

  it("throws a config error without a token", async () => {
    delete process.env.APIFY_API_TOKEN;
    await expect(syncTrendingSounds()).rejects.toThrow(/not configured/i);
  });

  it("orders reads by chart then rank", async () => {
    const db = getTestDb();
    const insert = db.prepare(`
      INSERT INTO marketing_tiktok_sounds (id, external_id, title, rank, country_code, rank_type)
      VALUES (?, ?, ?, ?, 'US', ?)
    `);
    insert.run("1", "x1", "pop 2", 2, "popular");
    insert.run("2", "x2", "pop 1", 1, "popular");
    insert.run("3", "x3", "brk 1", 1, "breakout");
    const rows = getTrendingSounds({});
    expect(rows.map((r) => r.title)).toEqual(["brk 1", "pop 1", "pop 2"]);
  });
});
