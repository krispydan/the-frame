/**
 * Clip library search — term parsing, LIKE escaping, and the real query
 * running against a seeded database.
 *
 * The three failures this replaced are pinned as tests below: multi-word
 * queries across different columns, SKU strings, and underscores in
 * filenames being treated as wildcards.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { parseSearchTerms, likePattern, buildSearchClause } from "@/modules/marketing/lib/video/clip-search";
import { GET } from "@/app/api/v1/marketing/videos/clips/route";

describe("parseSearchTerms", () => {
  it("splits on whitespace", () => {
    expect(parseSearchTerms("jade boulevard")).toEqual(["jade", "boulevard"]);
    expect(parseSearchTerms("  spaced   out  ")).toEqual(["spaced", "out"]);
  });

  it("keeps a quoted phrase together", () => {
    expect(parseSearchTerms('"take it all" jade')).toEqual(["take it all", "jade"]);
  });

  it("is empty for an empty query", () => {
    expect(parseSearchTerms("")).toEqual([]);
    expect(parseSearchTerms('   ""  ')).toEqual([]);
  });
});

describe("likePattern", () => {
  it("escapes the SQL wildcards so filenames match literally", () => {
    // `_` is a single-char wildcard; clip filenames are full of them.
    expect(likePattern("3_Sub_207")).toBe("%3\\_Sub\\_207%");
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("buildSearchClause", () => {
  it("returns nothing for an empty query", () => {
    expect(buildSearchClause("").sql).toBeNull();
    expect(buildSearchClause(null).params).toEqual([]);
  });

  it("ANDs the terms so each word narrows the result", () => {
    const c = buildSearchClause("jade boulevard");
    expect(c.terms).toEqual(["jade", "boulevard"]);
    // One field-group per term (counted by a marker unique to the group —
    // the SQL's own ANDs inside the EXISTS subquery are not joiners).
    expect((c.sql!.match(/c\.file_name LIKE/g) ?? []).length).toBe(2);
    // Every field placeholder for a term gets the same pattern.
    expect(c.params.filter((p) => p === "%jade%").length).toBeGreaterThan(1);
    expect(c.params.filter((p) => p === "%boulevard%").length).toBeGreaterThan(1);
  });

  it("emits one param per placeholder", () => {
    const c = buildSearchClause("one two three");
    expect(c.params.length).toBe((c.sql!.match(/\?/g) ?? []).length);
  });
});

// ── Against the real route + a real database ──

function req(qs: string) {
  return { nextUrl: new URL(`http://test/api/v1/marketing/videos/clips?${qs}`) } as unknown as Parameters<typeof GET>[0];
}
const names = async (qs: string) => {
  const res = await GET(req(qs));
  const d = await res.json();
  return (d.clips as Array<{ file_name: string }>).map((c) => c.file_name);
};

function seed() {
  const d = getTestDb();
  d.prepare(`INSERT INTO marketing_video_clip_categories (id, slug, name, sort_order) VALUES ('cat1','unboxing','Unboxing',1)`).run();
  d.prepare(`INSERT INTO catalog_products (id, name) VALUES ('p1','Boulevard')`).run();
  d.prepare(`INSERT INTO catalog_skus (id, product_id, sku, color_name) VALUES ('s1','p1','JX4011-BLK','Black')`).run();

  const clip = d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, duration_sec, status, talent, category_id)
     VALUES (?, ?, ?, 'clips/raw/x.mp4', 3, 'ready', ?, ?)`,
  );
  clip.run("c1", "3_Sub_207.mp4", "k1", "missjademonet", "cat1");
  clip.run("c2", "3xSubx207.mp4", "k2", "Daria", null);
  clip.run("c3", "IMG_0157__01.mp4", "k3", "Shianne Bateman", null);
  clip.run("c4", "beach_day.mp4", "k4", "missjademonet", null);
  // c4 is the only clip tagged with the Boulevard product.
  d.prepare(`INSERT INTO marketing_video_clip_products (id, clip_id, sku_id) VALUES ('t1','c4','s1')`).run();
}

beforeEach(() => {
  resetTestDb();
  seed();
});

describe("clip search (real query)", () => {
  it("finds a clip by SKU — which used to be unsearchable", async () => {
    expect(await names("search=JX4011-BLK")).toEqual(["beach_day.mp4"]);
  });

  it("finds a clip by colourway", async () => {
    expect(await names("search=Black")).toEqual(["beach_day.mp4"]);
  });

  it("matches words across DIFFERENT columns", async () => {
    // "missjademonet" is the creator, "boulevard" the tagged product.
    // A single contiguous LIKE can only look in one column, so this
    // returned nothing before.
    expect(await names("search=missjademonet+boulevard")).toEqual(["beach_day.mp4"]);
  });

  it("narrows as you add words rather than broadening", async () => {
    expect((await names("search=missjademonet")).length).toBe(2);
    expect((await names("search=missjademonet+boulevard")).length).toBe(1);
  });

  it("treats underscores literally, not as wildcards", async () => {
    // Unescaped, "3_Sub_207" also matched "3xSubx207".
    expect(await names("search=3_Sub_207")).toEqual(["3_Sub_207.mp4"]);
  });

  it("searches the shot type", async () => {
    expect(await names("search=Unboxing")).toEqual(["3_Sub_207.mp4"]);
  });

  it("honours a quoted phrase", async () => {
    expect(await names('search="beach day"')).toEqual([]);
    expect(await names("search=beach_day")).toEqual(["beach_day.mp4"]);
  });

  it("ranks a filename hit above an incidental one", async () => {
    const d = getTestDb();
    d.prepare(
      `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, duration_sec, status)
       VALUES ('c5','boulevard_hero.mp4','k5','clips/raw/x.mp4',3,'ready')`,
    ).run();
    // c4 matches via its product tag; c5 matches by name and must lead
    // even though c4 exists and ordering is otherwise newest-first.
    expect((await names("search=boulevard"))[0]).toBe("boulevard_hero.mp4");
  });

  it("returns everything when the query is blank", async () => {
    expect((await names("search=")).length).toBe(4);
  });

  it("counts the filtered set, not the whole library", async () => {
    const res = await GET(req("search=missjademonet"));
    const d = await res.json();
    expect(d.total).toBe(2);
  });
});
