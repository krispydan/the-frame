/**
 * Tests for the AI document store — the living, editable prompts.
 * The shared in-memory test DB has no marketing_ai_documents table;
 * the store creates + seeds it lazily from the real .md files, so these
 * exercise the true seed → read → edit → reset path.
 */
import { describe, it, expect } from "vitest";
import {
  listDocs,
  getDoc,
  getDocContent,
  updateDoc,
  resetDoc,
  fileDefault,
  AI_DOCS,
} from "@/modules/marketing/lib/prompt-store";

describe("prompt-store", () => {
  it("registers + lists every doc, seeded from the files", () => {
    const docs = listDocs();
    expect(docs.length).toBe(AI_DOCS.length);
    expect(docs.find((d) => d.slug === "copy-generation-prompt")).toBeTruthy();
    expect(docs.find((d) => d.slug === "brand-bible")?.category).toBe("brand");
  });

  it("getDocContent returns the file default before any edit", () => {
    const def = fileDefault("system-prompt-base");
    expect(def.length).toBeGreaterThan(0);
    expect(getDocContent("system-prompt-base")).toBe(def);
  });

  it("edit → live content + isEdited; reset → back to the file default", () => {
    const slug = "theme-generation-prompt";
    const def = fileDefault(slug);

    expect(updateDoc(slug, "EDITED PROMPT CONTENT")).toBe(true);
    expect(getDocContent(slug)).toBe("EDITED PROMPT CONTENT");
    const edited = getDoc(slug)!;
    expect(edited.isEdited).toBe(true);
    expect(edited.defaultContent).toBe(def);

    expect(resetDoc(slug)).toBe(true);
    expect(getDocContent(slug)).toBe(def);
    expect(getDoc(slug)!.isEdited).toBe(false);
  });

  it("unknown slug → null / false (no crash)", () => {
    expect(getDoc("does-not-exist")).toBeNull();
    expect(updateDoc("does-not-exist", "x")).toBe(false);
    expect(resetDoc("does-not-exist")).toBe(false);
  });
});
