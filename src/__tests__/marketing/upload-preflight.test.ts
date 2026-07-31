/**
 * Preflight verdicts — the rules that decide whether a re-dropped file
 * uploads, repairs, or is skipped.
 *
 * The dangerous direction is a WRONG SKIP: silently not ingesting real
 * footage. So the cases that matter most are the ones where a row exists
 * but the upload didn't actually succeed.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../setup";
import {
  preflightFiles,
  repairUploads,
  adoptOrphans,
  buildUploadHealthReport,
} from "@/modules/marketing/lib/video/upload-preflight";

let root: string;

/** Put real bytes on the fake volume at a clip/source raw path. */
function putFile(rel: string) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.from("bytes"));
}
function removeFile(rel: string) {
  rmSync(path.join(root, rel), { force: true });
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "preflight-"));
  process.env.VIDEOS_PATH = root;
});

function seedClip(o: {
  name: string; size: number; status: string; checksum: string; withFile?: boolean;
}) {
  const rawPath = `clips/raw/${o.checksum}.mp4`;
  getTestDb()
    .prepare(
      `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, size_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(`c-${o.checksum}`, o.name, o.checksum, rawPath, o.size, o.status);
  if (o.withFile !== false) putFile(rawPath);
  else removeFile(rawPath);
  return `c-${o.checksum}`;
}

function seedSource(o: {
  name: string; size: number; status: string; checksum: string;
  clipCount?: number; rawDeleted?: number; withFile?: boolean;
}) {
  const rawPath = `sources/${o.checksum}.mp4`;
  getTestDb()
    .prepare(
      `INSERT INTO marketing_video_sources
         (id, file_name, checksum, raw_path, size_bytes, status, clip_count, raw_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(`s-${o.checksum}`, o.name, o.checksum, rawPath, o.size, o.status, o.clipCount ?? 0, o.rawDeleted ?? 0);
  if (o.withFile !== false) putFile(rawPath);
  else removeFile(rawPath);
  return `s-${o.checksum}`;
}

describe("preflightFiles", () => {
  beforeEach(() => resetTestDb());

  it("uploads a file it has never seen", async () => {
    const { results, summary } = await preflightFiles([{ fileName: "IMG_9001.MOV", sizeBytes: 5_000_000 }]);
    expect(results[0].verdict).toBe("upload");
    expect(results[0].kind).toBeNull();
    expect(summary.upload).toBe(1);
  });

  it("skips a clip that is already in the library", async () => {
    seedClip({ name: "IMG_9001.MOV", size: 5_000_000, status: "ready", checksum: "a".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "IMG_9001.MOV", sizeBytes: 5_000_000 }]);
    expect(results[0].verdict).toBe("skip");
    expect(results[0].kind).toBe("clip");
  });

  it("skips a source that already produced clips", async () => {
    seedSource({ name: "shoot.mp4", size: 90_000_000, status: "done", clipCount: 12, checksum: "b".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "shoot.mp4", sizeBytes: 90_000_000 }]);
    expect(results[0].verdict).toBe("skip");
    expect(results[0].reason).toMatch(/12 clips/);
  });

  it("does NOT skip a failed clip — that's the one being re-uploaded to fix", async () => {
    seedClip({ name: "bad.mp4", size: 1234, status: "failed", checksum: "c".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "bad.mp4", sizeBytes: 1234 }]);
    expect(results[0].verdict).not.toBe("skip");
  });

  it("repairs (not re-uploads) a failed clip whose bytes are still stored", async () => {
    seedClip({ name: "bad.mp4", size: 1234, status: "failed", checksum: "d".repeat(16), withFile: true });
    const { results, summary } = await preflightFiles([{ fileName: "bad.mp4", sizeBytes: 1234 }]);
    expect(results[0].verdict).toBe("repair");
    expect(results[0].id).toBe("c-" + "d".repeat(16));
    expect(summary.repair).toBe(1);
  });

  it("re-uploads a failed clip whose bytes are gone", async () => {
    seedClip({ name: "gone.mp4", size: 99, status: "failed", checksum: "e".repeat(16), withFile: false });
    const { results } = await preflightFiles([{ fileName: "gone.mp4", sizeBytes: 99 }]);
    expect(results[0].verdict).toBe("upload");
    expect(results[0].reason).toMatch(/missing from storage/i);
  });

  it("repairs a source stuck mid-split when the footage survived", async () => {
    seedSource({ name: "stuck.mp4", size: 500, status: "splitting", checksum: "f".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "stuck.mp4", sizeBytes: 500 }]);
    expect(results[0].verdict).toBe("repair");
  });

  it("re-uploads a source that finished with zero clips and lost its footage", async () => {
    seedSource({
      name: "empty.mp4", size: 500, status: "done", clipCount: 0,
      rawDeleted: 1, withFile: false, checksum: "1".repeat(16),
    });
    const { results } = await preflightFiles([{ fileName: "empty.mp4", sizeBytes: 500 }]);
    expect(results[0].verdict).toBe("upload");
    expect(results[0].reason).toMatch(/no clips/i);
  });

  it("treats an archived clip as done — a re-upload must not resurrect it", async () => {
    seedClip({ name: "junk.mp4", size: 42, status: "archived", checksum: "2".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "junk.mp4", sizeBytes: 42 }]);
    expect(results[0].verdict).toBe("skip");
  });

  it("uploads when the name matches but the size doesn't", async () => {
    seedClip({ name: "IMG_9001.MOV", size: 5_000_000, status: "ready", checksum: "3".repeat(16) });
    const { results } = await preflightFiles([{ fileName: "IMG_9001.MOV", sizeBytes: 5_000_001 }]);
    expect(results[0].verdict).toBe("upload");
  });

  it("uploads when the row has no recorded size (old rows can't be matched)", async () => {
    getTestDb()
      .prepare(
        `INSERT INTO marketing_video_clips (id, file_name, checksum, raw_path, size_bytes, status)
         VALUES ('old','legacy.mp4','4444444444444444','clips/raw/4444444444444444.mp4', NULL, 'ready')`,
      )
      .run();
    const { results } = await preflightFiles([{ fileName: "legacy.mp4", sizeBytes: 700 }]);
    expect(results[0].verdict).toBe("upload");
  });

  it("preserves input order across a mixed batch", async () => {
    seedClip({ name: "have.mp4", size: 10, status: "ready", checksum: "5".repeat(16) });
    const { results, summary } = await preflightFiles([
      { fileName: "new-1.mp4", sizeBytes: 11 },
      { fileName: "have.mp4", sizeBytes: 10 },
      { fileName: "new-2.mp4", sizeBytes: 12 },
    ]);
    expect(results.map((r) => r.fileName)).toEqual(["new-1.mp4", "have.mp4", "new-2.mp4"]);
    expect(results.map((r) => r.verdict)).toEqual(["upload", "skip", "upload"]);
    expect(summary).toEqual({ total: 3, skip: 1, repair: 0, upload: 2 });
  });
});

describe("repairUploads", () => {
  beforeEach(() => resetTestDb());

  it("re-queues a failed clip and resets it to uploaded", async () => {
    const id = seedClip({ name: "x.mp4", size: 1, status: "failed", checksum: "6".repeat(16) });
    const r = await repairUploads([{ kind: "clip", id }]);
    expect(r.requeued).toBe(1);
    const row = getTestDb().prepare(`SELECT status FROM marketing_video_clips WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe("uploaded");
  });

  it("resets a source off 'done' so the split job doesn't short-circuit", async () => {
    // splitSource() early-returns on status='done' — a source that
    // "finished" with zero clips would otherwise never re-run.
    const id = seedSource({ name: "y.mp4", size: 1, status: "done", clipCount: 0, checksum: "7".repeat(16) });
    const r = await repairUploads([{ kind: "source", id }]);
    expect(r.requeued).toBe(1);
    const row = getTestDb().prepare(`SELECT status FROM marketing_video_sources WHERE id = ?`).get(id) as { status: string };
    expect(row.status).toBe("uploaded");
  });

  it("skips (never claims to fix) a row whose bytes are gone", async () => {
    const id = seedClip({ name: "z.mp4", size: 1, status: "failed", checksum: "8".repeat(16), withFile: false });
    const r = await repairUploads([{ kind: "clip", id }]);
    expect(r.requeued).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("reports an unknown id instead of throwing", async () => {
    const r = await repairUploads([{ kind: "clip", id: "nope" }]);
    expect(r.errors[0]).toMatch(/no such clip/);
  });
});

describe("orphan recovery", () => {
  beforeEach(() => resetTestDb());

  it("finds stored files with no DB row and adopts them", async () => {
    const checksum = "9".repeat(16);
    putFile(`clips/raw/${checksum}.mp4`);

    const report = await buildUploadHealthReport();
    const orphan = report.orphans.find((o) => o.path === `clips/raw/${checksum}.mp4`);
    expect(orphan).toBeDefined();

    const r = await adoptOrphans([`clips/raw/${checksum}.mp4`]);
    expect(r.adopted).toBe(1);
    const row = getTestDb()
      .prepare(`SELECT status, notes FROM marketing_video_clips WHERE checksum = ?`)
      .get(checksum) as { status: string; notes: string };
    expect(row.status).toBe("uploaded");
    expect(row.notes).toMatch(/needs tagging/i);
  });

  it("does not report a file that already has a row", async () => {
    const checksum = "a1a1a1a1a1a1a1a1";
    seedClip({ name: "known.mp4", size: 5, status: "ready", checksum });
    const report = await buildUploadHealthReport();
    expect(report.orphans.some((o) => o.path.includes(checksum))).toBe(false);
  });

  it("ignores a path that isn't a content-addressed raw object", async () => {
    const r = await adoptOrphans(["clips/normalized/whatever_v1.mp4"]);
    expect(r.adopted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("won't adopt the same bytes twice", async () => {
    const checksum = "b2b2b2b2b2b2b2b2";
    putFile(`clips/raw/${checksum}.mp4`);
    expect((await adoptOrphans([`clips/raw/${checksum}.mp4`])).adopted).toBe(1);
    expect((await adoptOrphans([`clips/raw/${checksum}.mp4`])).adopted).toBe(0);
  });
});

describe("buildUploadHealthReport", () => {
  beforeEach(() => resetTestDb());

  it("separates what can be fixed in place from what needs re-uploading", async () => {
    seedClip({ name: "fixable.mp4", size: 1, status: "failed", checksum: "c3c3c3c3c3c3c3c3", withFile: true });
    seedClip({ name: "lost.mp4", size: 2, status: "failed", checksum: "d4d4d4d4d4d4d4d4", withFile: false });
    seedClip({ name: "fine.mp4", size: 3, status: "ready", checksum: "e5e5e5e5e5e5e5e5" });

    const report = await buildUploadHealthReport();
    expect(report.clips.failed).toBe(2);
    expect(report.clips.ready).toBe(1);
    expect(report.broken.find((b) => b.fileName === "fixable.mp4")?.repairable).toBe(true);
    expect(report.broken.find((b) => b.fileName === "lost.mp4")?.repairable).toBe(false);
    expect(report.broken.some((b) => b.fileName === "fine.mp4")).toBe(false);
  });

  it("counts a source that finished with no clips as broken", async () => {
    seedSource({ name: "nothing.mp4", size: 1, status: "done", clipCount: 0, checksum: "f6f6f6f6f6f6f6f6" });
    const report = await buildUploadHealthReport();
    expect(report.sources.emptyDone).toBe(1);
    expect(report.broken.some((b) => b.fileName === "nothing.mp4")).toBe(true);
  });
});
