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

  const item = (id: string, rank: number, diffType = 3) => ({
    song_id: id,
    title: `song ${id}`,
    author: "artist",
    rank,
    rank_diff_type: diffType,
  });

  /**
   * Mock the async Apify flow: runs/last (no in-flight run) → POST runs
   * (start) → runs/{id} (SUCCEEDED) → datasets/{id}/items. Returns the
   * fetch spy so tests can assert call shapes.
   */
  function mockApifyFlow(items: unknown[]) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/runs/last")) {
        return new Response(JSON.stringify({ data: { id: "old", status: "SUCCEEDED" } }), { status: 200 });
      }
      if (u.includes("/datasets/")) {
        return new Response(JSON.stringify(items), { status: 200 });
      }
      if (/\/runs\/[^/?]+\?/.test(u)) {
        // status poll for a specific run
        return new Response(JSON.stringify({ data: { id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1" } }), { status: 200 });
      }
      if (u.includes("/runs?")) {
        // start run
        return new Response(JSON.stringify({ data: { id: "run1", status: "READY", defaultDatasetId: "ds1" } }), { status: 201 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  }

  it("runs the actor ONCE and stores the derived chart", async () => {
    const fetchMock = mockApifyFlow([item("a", 1, 1), item("b", 2, 3)]); // a=up→breakout, b=flat→popular
    const first = await syncTrendingSounds();
    expect(first.synced).toBe(2);
    // Exactly one actor RUN was started (not one per rank type).
    const startCalls = fetchMock.mock.calls.filter((c) => /\/runs\?/.test(String(c[0])));
    expect(startCalls).toHaveLength(1);
    expect(String(startCalls[0][0])).toContain("novi~tiktok-music-trend-api");

    expect(getTrendingSounds({ rankType: "breakout" }).map((r) => r.externalId)).toEqual(["a"]);
    expect(getTrendingSounds({ rankType: "popular" }).map((r) => r.externalId)).toEqual(["b"]);
  });

  it("attaches to an in-flight run instead of starting a duplicate", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/runs/last")) {
        return new Response(JSON.stringify({ data: { id: "live", status: "RUNNING", defaultDatasetId: "dsLive" } }), { status: 200 });
      }
      if (u.includes("/datasets/")) {
        return new Response(JSON.stringify([item("x", 1)]), { status: 200 });
      }
      if (/\/runs\/[^/?]+\?/.test(u)) {
        return new Response(JSON.stringify({ data: { id: "live", status: "SUCCEEDED", defaultDatasetId: "dsLive" } }), { status: 200 });
      }
      throw new Error(`should not start a new run: ${u}`);
    });
    const result = await syncTrendingSounds();
    expect(result.synced).toBe(1);
    // No POST /runs? call was made — it attached to the live run.
    expect(fetchMock.mock.calls.some((c) => /\/runs\?/.test(String(c[0])))).toBe(false);
  });

  it("replaces the whole snapshot on the next sync", async () => {
    mockApifyFlow([item("a", 1), item("b", 2)]);
    await syncTrendingSounds();
    mockApifyFlow([item("c", 1)]);
    await syncTrendingSounds();
    expect(getTrendingSounds({}).map((r) => r.externalId)).toEqual(["c"]);
  });

  it("keeps the previous snapshot when a sync returns nothing usable", async () => {
    mockApifyFlow([item("a", 1)]);
    await syncTrendingSounds();
    mockApifyFlow([]);
    await expect(syncTrendingSounds()).rejects.toThrow(/0 usable/);
    expect(getTrendingSounds({})).toHaveLength(1);
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
