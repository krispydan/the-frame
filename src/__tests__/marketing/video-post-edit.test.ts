/**
 * Video post detail editing — the mini clip editor's PATCH path:
 * replacing clip_ids resets the render, recomputes hash/audio, queues a
 * re-render job, and guards posted posts / unknown clips.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { PATCH } from "@/app/api/v1/marketing/videos/posts/[id]/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function req(body: unknown) {
  return new Request("http://test/api/v1/marketing/videos/posts/p1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function seed() {
  const d = getTestDb();
  const clip = d.prepare(
    `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, duration_sec, status) VALUES (?, ?, ?, 'clips/raw/x.mp4', ?, ?)`,
  );
  clip.run("c1", "one.mp4", "ck1", 3.5, "ready");
  clip.run("c2", "two.mp4", "ck2", 4.0, "ready");
  clip.run("c3", "three.mp4", "ck3", 2.5, "ready");
  clip.run("c4", "four.mp4", "ck4", 3.0, "uploaded"); // not ready
  d.prepare(
    `INSERT INTO marketing_video_posts (id, permutation_hash, clip_ids, audible_clip_ids, audio_treatment, status, file_path, poster_path, caption)
     VALUES ('p1', 'hash-original', '["c1","c2"]', '["c1"]', 'partial', 'ready', 'renders/2026-07/p1.mp4', 'renders/2026-07/p1.jpg', 'Hand-written caption')`,
  ).run();
}

beforeEach(() => {
  resetTestDb();
  seed();
});

describe("PATCH clipIds (mini clip editor)", () => {
  it("replaces the sequence, resets the render, and queues a re-render", async () => {
    const res = await PATCH(req({ clipIds: ["c2", "c3", "c1"] }), ctx("p1"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.rerenderQueued).toBe(true);

    const row = getTestDb().prepare(`SELECT * FROM marketing_video_posts WHERE id = 'p1'`).get() as Record<string, unknown>;
    expect(JSON.parse(String(row.clip_ids))).toEqual(["c2", "c3", "c1"]);
    expect(row.status).toBe("queued");
    expect(row.file_path).toBeNull();
    expect(row.poster_path).toBeNull();
    expect(row.permutation_hash).not.toBe("hash-original");
    // audible c1 survived the edit → still partial
    expect(JSON.parse(String(row.audible_clip_ids))).toEqual(["c1"]);
    expect(row.audio_treatment).toBe("partial");
    // duration re-estimated from the new sequence (4.0 + 2.5 + 3.5)
    expect(row.duration_sec).toBeCloseTo(10.0, 1);
    // caption preserved (re-render must not clobber the operator's words)
    expect(row.caption).toBe("Hand-written caption");

    const job = getTestDb().prepare(`SELECT * FROM jobs WHERE type = 'marketing.video.render-post'`).get() as Record<string, unknown>;
    expect(job).toBeTruthy();
    expect(JSON.parse(String(job.input))).toMatchObject({ postId: "p1", skipCopy: true });
  });

  it("drops removed clips from the audible set (audio goes silent)", async () => {
    const res = await PATCH(req({ clipIds: ["c2", "c3"] }), ctx("p1"));
    expect(res.status).toBe(200);
    const row = getTestDb().prepare(`SELECT * FROM marketing_video_posts WHERE id = 'p1'`).get() as Record<string, unknown>;
    expect(JSON.parse(String(row.audible_clip_ids))).toEqual([]);
    expect(row.audio_treatment).toBe("silent");
  });

  it("rejects unknown and not-ready clips", async () => {
    expect((await PATCH(req({ clipIds: ["c1", "nope"] }), ctx("p1"))).status).toBe(400);
    expect((await PATCH(req({ clipIds: ["c1", "c4"] }), ctx("p1"))).status).toBe(400);
  });

  it("rejects editing a posted video and empty sequences", async () => {
    getTestDb().prepare(`UPDATE marketing_video_posts SET status = 'posted' WHERE id = 'p1'`).run();
    expect((await PATCH(req({ clipIds: ["c1"] }), ctx("p1"))).status).toBe(400);
    getTestDb().prepare(`UPDATE marketing_video_posts SET status = 'ready' WHERE id = 'p1'`).run();
    expect((await PATCH(req({ clipIds: [] }), ctx("p1"))).status).toBe(400);
  });

  it("409s when the exact sequence already exists on another post", async () => {
    // Create a sibling whose hash matches what p1's edit would produce.
    const first = await PATCH(req({ clipIds: ["c3"] }), ctx("p1"));
    expect(first.status).toBe(200);
    const hash = (getTestDb().prepare(`SELECT permutation_hash AS h FROM marketing_video_posts WHERE id = 'p1'`).get() as { h: string }).h;
    getTestDb()
      .prepare(
        `INSERT INTO marketing_video_posts (id, permutation_hash, clip_ids, status) VALUES ('p2', 'other-hash', '["c1"]', 'ready')`,
      )
      .run();
    // Editing p2 to the same single-clip sequence collides with p1's hash.
    getTestDb().prepare(`UPDATE marketing_video_posts SET permutation_hash = ? WHERE id = 'p1'`).run(hash);
    const res = await PATCH(req({ clipIds: ["c3"] }), ctx("p2"));
    expect(res.status).toBe(409);
  });

  it("PATCH instructions saves the posting instructions object", async () => {
    const res = await PATCH(
      req({ instructions: { audio: "use trending sound", onScreenText: [{ text: "New drop", timing: "0-2s", placement: "top" }] } }),
      ctx("p1"),
    );
    expect(res.status).toBe(200);
    const row = getTestDb().prepare(`SELECT instructions FROM marketing_video_posts WHERE id = 'p1'`).get() as { instructions: string };
    expect(JSON.parse(row.instructions).onScreenText[0].text).toBe("New drop");
  });
});
