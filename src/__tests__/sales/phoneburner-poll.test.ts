/**
 * Tests for the PhoneBurner safety-net poll cursor.
 *
 * The bug this guards: the poll used MAX(called_at) as its `since`
 * cursor, so a stale/future/odd `high` could stick the cursor and
 * silently starve the poll — letting a webhook gap (yesterday's calls
 * never ingested) go uncaught and the digest read 0.
 */
import { describe, it, expect } from "vitest";
import { computePollSince } from "@/modules/sales/lib/phoneburner-sync";

const NOW = Date.UTC(2026, 5, 24, 15, 0, 0); // 2026-06-24T15:00:00Z
const FLOOR = "2026-06-24T14:00:00.000Z"; // now - 60min

describe("computePollSince — un-stickable safety-net cursor", () => {
  it("empty table → looks back the full window", () => {
    expect(computePollSince(60, null, NOW)).toBe(FLOOR);
  });

  it("recent cursor (newer than the window) → still uses the window, doesn't chase ahead", () => {
    expect(computePollSince(60, "2026-06-24T14:50:00.000Z", NOW)).toBe(FLOOR);
  });

  it("future/odd cursor → window floor, never stuck in the future", () => {
    expect(computePollSince(60, "2026-06-24T16:30:00.000Z", NOW)).toBe(FLOOR);
    // A garbage cursor that sorts after the floor also can't stick it.
    expect(computePollSince(60, "9999-99-99", NOW)).toBe(FLOOR);
  });

  it("stale cursor (poll was down) → backfills the gap from the last ingested call", () => {
    const high = "2026-06-24T12:00:00.000Z"; // 3h ago, older than the 1h window
    expect(computePollSince(60, high, NOW)).toBe(high);
  });
});
