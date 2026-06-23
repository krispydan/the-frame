import { describe, it, expect } from "vitest";
import {
  STATUS_ORDER,
  gateFor,
  nextStatus,
  prevStatus,
  statusIndex,
  type GateCampaign,
} from "@/modules/marketing/lib/workflow";

const ready: GateCampaign = {
  status: "preview_ready",
  subject: "x",
  heroHeadline: "x",
  sectionABody: "x",
  sectionBBody: "x",
  heroImagePrompt: "brief",
  secondaryImagePrompt: "brief",
  heroImagePath: "email/x/hero.jpg",
  secondaryImagePath: "email/x/s.jpg",
  secondaryImageVariant: "full_bleed",
};

describe("workflow gates", () => {
  it("orders the 10 stages", () => {
    expect(STATUS_ORDER).toHaveLength(10);
    expect(statusIndex("idea")).toBeLessThan(statusIndex("sent"));
  });

  it("blocks copy_review until copy is complete", () => {
    expect(gateFor("copy_review", { status: "idea" }).length).toBeGreaterThan(0);
    expect(gateFor("copy_review", ready)).toHaveLength(0);
  });

  it("blocks image_pending without image prompts", () => {
    const noPrompts = { ...ready, status: "copy_review", heroImagePrompt: null };
    expect(gateFor("image_pending", noPrompts).length).toBeGreaterThan(0);
  });

  it("blocks image_review until all images uploaded", () => {
    const noImages = { ...ready, status: "image_pending", heroImagePath: null };
    expect(gateFor("image_review", noImages).length).toBeGreaterThan(0);
    expect(gateFor("image_review", ready)).toHaveLength(0);
  });

  it("requires the 2nd grid image for grid_2up", () => {
    const grid: GateCampaign = { ...ready, secondaryImageVariant: "grid_2up", secondaryImagePath2: null };
    expect(gateFor("image_review", grid).length).toBeGreaterThan(0);
  });

  it("blocks export until preview-ready", () => {
    expect(gateFor("exported", { status: "idea" }).length).toBeGreaterThan(0);
    expect(gateFor("exported", ready)).toHaveLength(0);
  });

  it("computes next/prev", () => {
    expect(nextStatus("idea")).toBe("themed");
    expect(prevStatus("themed")).toBe("idea");
    expect(nextStatus("analyzed")).toBeNull();
    expect(prevStatus("idea")).toBeNull();
  });
});
