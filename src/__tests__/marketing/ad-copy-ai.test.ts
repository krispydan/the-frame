/**
 * AI ad-copy generation with the model call mocked — verifies the
 * variants land in the pool with sequential codes and that junk model
 * output is filtered rather than stored.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetTestDb, getTestDb } from "../setup";

vi.mock("@/modules/marketing/lib/email-ai", () => ({
  callClaude: vi.fn(),
  extractPromptBody: (s: string) => s,
  fillTemplate: (s: string) => s,
}));

import { callClaude } from "@/modules/marketing/lib/email-ai";
import { generateAdCopy } from "@/modules/marketing/lib/ads/ad-copy";

beforeEach(() => resetTestDb());

describe("generateAdCopy", () => {
  it("stores usable variants under the next codes and skips junk", async () => {
    vi.mocked(callClaude).mockResolvedValueOnce({
      ok: true,
      output: {
        variants: [
          { primaryText: "Shades built for golden hour.", headline: "Golden hour ready", angle: "style" },
          { primaryText: "   ", headline: "junk — no primary text" },
          { primaryText: "Polarized. Under $40.", headline: "Why pay more", description: "Free shipping", angle: "price" },
        ],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const result = await generateAdCopy({ count: 3, productName: "Windsor" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created.map((c) => c.code)).toEqual(["C01", "C02"]);

    const rows = getTestDb().prepare(`SELECT code, primary_text, notes FROM marketing_ad_copy ORDER BY code`).all() as
      Array<{ code: string; primary_text: string; notes: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[1].primary_text).toBe("Polarized. Under $40.");
    expect(rows[1].notes).toContain("angle: price");
  });

  it("surfaces a model failure instead of inserting nothing silently", async () => {
    vi.mocked(callClaude).mockResolvedValueOnce({ ok: false, error: "rate limited" });
    const result = await generateAdCopy({});
    expect(result).toEqual({ ok: false, error: "rate limited" });
  });
});
