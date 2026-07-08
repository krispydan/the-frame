import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import {
  mapSoundItem,
  syncTrendingSounds,
  getTrendingSounds,
} from "@/modules/marketing/lib/video/tiktok-sounds";

describe("TikTok sounds mapper", () => {
  // The REAL novi~tiktok-music-trend-api item shape (TikTok's raw music
  // object) — this is what silently broke the old mapper.
  const realItem = {
    author: "Labrinth",
    cover_thumb: { url_list: ["https://p16.example/thumb.jpeg"] },
    cover_medium: { url_list: ["https://p16.example/med.jpeg"] },
    duration: 60,
    id: 6740248251825392000, // numeric — precision-lossy, must NOT be used as id
    id_str: "6740248251825391617",
    mid: "6740248251825391617",
    is_original: false,
    play_url: { url_list: ["https://sf.example/audio"] },
    title: 'Forever (From "Euphoria: Season 1" Soundtrack)',
    user_count: 3175407,
  };

  it("maps the real actor item using string ids + nested cover", () => {
    const mapped = mapSoundItem(realItem, 0)!;
    // id_str, NOT the precision-lossy numeric id
    expect(mapped.externalId).toBe("6740248251825391617");
    expect(mapped.title).toContain("Forever");
    expect(mapped.author).toBe("Labrinth");
    expect(mapped.coverUrl).toBe("https://p16.example/thumb.jpeg");
    // play_url → inline preview (no trip to TikTok)
    expect(mapped.previewUrl).toBe("https://sf.example/audio");
    expect(mapped.durationSec).toBe(60);
    expect(mapped.usageCount).toBe(3175407);
    expect(mapped.rank).toBe(1); // array order (no rank field)
    expect(mapped.trendDirection).toBeNull(); // no trend field in payload
    // a usable TikTok music link is constructed from title + id
    expect(mapped.tiktokLink).toContain("tiktok.com/music/");
    expect(mapped.tiktokLink).toContain("6740248251825391617");
  });

  it("never uses the precision-lossy numeric id", () => {
    const mapped = mapSoundItem({ title: "x", id: 6740248251825392000 }, 5)!;
    // no id_str/mid → falls back to a title-derived slug, NOT String(id)
    expect(mapped.externalId).not.toContain("6740248251825392000");
    expect(mapped.externalId).toContain("x");
  });

  it("still handles older Creative-Center field names", () => {
    const mapped = mapSoundItem(
      { song_id: "728412", title: "cc song", author: "a", duration: 42, rank_diff_type: 1, if_use_songs: 129000 },
      2,
    )!;
    expect(mapped.externalId).toBe("728412");
    expect(mapped.trendDirection).toBe("up");
    expect(mapped.usageCount).toBe(129000);
  });

  it("only rejects a truly empty (title-less) row", () => {
    expect(mapSoundItem({ foo: "bar" }, 0)).toBeNull();
    expect(mapSoundItem({ title: "kept" }, 0)).not.toBeNull();
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

  const item = (id: string, diffType?: number) => ({
    id_str: id,
    title: `song ${id}`,
    author: "artist",
    duration: 30,
    user_count: 1000,
    ...(diffType !== undefined ? { rank_diff_type: diffType } : {}),
  });

  /**
   * Mock the single run-sync-get-dataset-items call — it returns the
   * dataset rows directly (the whole point: no run-status polling to
   * mis-read). Returns the fetch spy for call-shape assertions.
   */
  function mockRunSync(items: unknown[]) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/run-sync-get-dataset-items")) {
        return new Response(JSON.stringify(items), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
  }

  it("runs the actor exactly ONCE via run-sync and stores the chart", async () => {
    const fetchMock = mockRunSync([item("a"), item("b")]);
    const first = await syncTrendingSounds();
    expect(first.synced).toBe(2);
    const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/run-sync-get-dataset-items"));
    expect(calls).toHaveLength(1); // one paid run, not one per chart type
    expect(String(calls[0][0])).toContain("novi~tiktok-music-trend-api");
    // no trend field → everything lands on the single trending chart
    expect(getTrendingSounds({ rankType: "popular" }).map((r) => r.externalId).sort()).toEqual(["a", "b"]);
  });

  it("derives breakout vs popular when the item DOES carry a trend", async () => {
    mockRunSync([item("up", 1), item("flat", 3)]);
    await syncTrendingSounds();
    expect(getTrendingSounds({ rankType: "breakout" }).map((r) => r.externalId)).toEqual(["up"]);
    expect(getTrendingSounds({ rankType: "popular" }).map((r) => r.externalId)).toEqual(["flat"]);
  });

  it("replaces the whole snapshot on the next sync", async () => {
    mockRunSync([item("a"), item("b")]);
    await syncTrendingSounds();
    mockRunSync([item("c")]);
    await syncTrendingSounds();
    expect(getTrendingSounds({}).map((r) => r.externalId)).toEqual(["c"]);
  });

  it("keeps the previous snapshot when a sync returns nothing usable", async () => {
    mockRunSync([item("a")]);
    await syncTrendingSounds();
    mockRunSync([]);
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
