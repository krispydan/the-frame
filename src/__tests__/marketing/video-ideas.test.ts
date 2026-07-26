/**
 * Idea Bank persistence — list + status transitions (the AI generation
 * call itself needs a key, so it's exercised separately). Verifies the
 * lazy table create, listing, status filter, and used/dismissed updates.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";
import { listIdeas, setIdeaStatus } from "@/modules/marketing/lib/video/video-ideas";

function seedIdea(id: string, status = "new") {
  getTestDb()
    .prepare(
      `INSERT INTO marketing_video_ideas (id, angle, pillar, hook, concept, status)
       VALUES (?, ?, 'Myth / Hot Take', 'Stop paying $150 for sunglasses', 'A punchy myth-bust.', ?)`,
    )
    .run(id, `Angle ${id}`, status);
}

describe("Idea Bank persistence", () => {
  beforeEach(() => {
    resetTestDb();
    listIdeas(); // lazily creates the table
    getTestDb().exec("DELETE FROM marketing_video_ideas"); // not in the reset set
  });

  it("lists ideas and filters by status", () => {
    seedIdea("a", "new");
    seedIdea("b", "used");
    expect(listIdeas().length).toBe(2);
    expect(listIdeas("new").map((i) => i.id)).toEqual(["a"]);
    expect(listIdeas("new")[0].hook).toContain("Stop paying");
  });

  it("marks an idea used / dismissed", () => {
    seedIdea("a", "new");
    expect(setIdeaStatus("a", "used")).toBe(true);
    expect(listIdeas("new")).toHaveLength(0);
    expect(listIdeas("used").map((i) => i.id)).toEqual(["a"]);
    expect(setIdeaStatus("missing", "used")).toBe(false);
  });
});
