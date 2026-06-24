/**
 * Integration test for the featured-products → AI wiring.
 *
 * No API key needed: we stub global fetch to (a) capture the exact
 * request body email-ai sends to Anthropic and (b) return a canned
 * tool_use response. This verifies the FEATURE'S CORE PROMISE — that
 * a campaign's products + photos actually reach the model — without
 * judging the model's output (which needs a live key).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateCopy, generateImagePrompts, reviseBrief } from "@/modules/marketing/lib/email-ai";

const PRODUCT_BLOCK =
  "1. Honey Reader ($28.00 retail)\n" +
  "   Warm amber tortoise reading glasses.\n" +
  "   Specs: frame shape: round · Lens 51mm · Bridge 22mm · Temple 145mm\n" +
  "   Image: https://theframe.getjaxy.com/api/images/marketing/honey.jpg";

const IMG = "https://theframe.getjaxy.com/api/images/marketing/honey.jpg";

function stubAnthropic(toolName: string, input: Record<string, unknown>) {
  const fetchMock = vi.fn((..._args: unknown[]): Promise<unknown> =>
    Promise.resolve({
      ok: true,
      json: async () => ({
        content: [{ type: "tool_use", id: "t", name: toolName, input }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      text: async () => "",
    }),
  );
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function bodyOfCall(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const call = fetchMock.mock.calls[callIndex] as unknown[];
  return JSON.parse((call[1] as { body: string }).body);
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("generateCopy — featured products reach the model", () => {
  it("sends the product block as text + each photo as a vision block", async () => {
    const fetchMock = stubAnthropic("submit_email_copy", { subject: "ok" });
    const res = await generateCopy({
      audience: "retail",
      scheduledDate: "2026-06-25",
      heroVariant: "full_bleed_overlay",
      themeTitle: "Honey returns",
      themeAngle: "Warm fall colorway",
      featuredProductsText: PRODUCT_BLOCK,
      productImages: [{ url: IMG }],
    });
    expect(res.ok).toBe(true);

    const body = bodyOfCall(fetchMock, 0);
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);

    const text = content.find((c: { type: string }) => c.type === "text").text as string;
    expect(text).toContain("Honey Reader");
    expect(text).toContain("$28.00 retail");
    expect(text).toContain("Lens 51mm");

    const imgs = content.filter((c: { type: string }) => c.type === "image");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].source).toEqual({ type: "url", url: IMG });

    // System prompt + forced tool still intact.
    expect(typeof body.system).toBe("string");
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_email_copy" });
  });

  it("no products → plain string content, no image blocks, '(none' marker in prompt", async () => {
    const fetchMock = stubAnthropic("submit_email_copy", { subject: "ok" });
    await generateCopy({
      audience: "retail",
      scheduledDate: "2026-06-25",
      heroVariant: "full_bleed_overlay",
      themeTitle: "Brand email",
      themeAngle: "no product",
    });
    const body = bodyOfCall(fetchMock, 0);
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("(none");
  });

  it("retries text-only when the image request fails (a bad photo can't sink the copy)", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => {
      n++;
      if (n === 1) {
        // First (image-bearing) attempt fails with an image-shaped 400.
        return { ok: false, status: 400, text: async () => "messages.0.content: invalid image source url", json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({ content: [{ type: "tool_use", id: "t", name: "submit_email_copy", input: { subject: "ok" } }], usage: { input_tokens: 1, output_tokens: 1 } }),
        text: async () => "",
      };
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const res = await generateCopy({
      audience: "retail",
      scheduledDate: "2026-06-25",
      heroVariant: "full_bleed_overlay",
      themeTitle: "T",
      themeAngle: "a",
      featuredProductsText: PRODUCT_BLOCK,
      productImages: [{ url: IMG }],
    });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The retry dropped the images → plain-string content.
    const retryBody = bodyOfCall(fetchMock, 1);
    expect(typeof retryBody.messages[0].content).toBe("string");
  });

  it("product text but NO image → text injected, content stays a plain string", async () => {
    const fetchMock = stubAnthropic("submit_email_copy", { subject: "ok" });
    await generateCopy({
      audience: "retail",
      scheduledDate: "2026-06-25",
      heroVariant: "full_bleed_overlay",
      themeTitle: "T",
      themeAngle: "a",
      featuredProductsText: "1. No-photo Reader ($26.00 retail)",
      productImages: [],
    });
    const body = bodyOfCall(fetchMock, 0);
    expect(typeof body.messages[0].content).toBe("string");
    expect(body.messages[0].content).toContain("No-photo Reader");
  });
});

describe("reviseBrief — applies natural-language operator feedback", () => {
  it("sends the current brief + feedback + calendar context, returns the revised brief", async () => {
    const fetchMock = stubAnthropic("submit_revised_brief", {
      name: "Honey, warmer", angle: "Lean into the drop", rationale: "dropped urgency, added Labor Day",
    });
    const res = await reviseBrief({
      audience: "retail",
      scheduledDate: "2026-09-04",
      slotContext: "slot 1 · layout=full_bleed · subject-angle=warmth",
      calendarEvents: "[PRIMARY — lead with this] Labor Day sale",
      current: { name: "Honey returns", angle: "urgency-led push", productHook: "Honey", seasonalContext: null },
      feedback: "less urgency, more warmth; tie it to Labor Day",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.output.name).toBe("Honey, warmer");

    const body = bodyOfCall(fetchMock, 0);
    // Brief revision is text-only (no images).
    expect(typeof body.messages[0].content).toBe("string");
    const content = body.messages[0].content as string;
    expect(content).toContain("less urgency, more warmth"); // the feedback
    expect(content).toContain("Honey returns");             // the current brief
    expect(content).toContain("Labor Day");                 // calendar context
    expect(body.tool_choice).toEqual({ type: "tool", name: "submit_revised_brief" });
  });
});

describe("generateImagePrompts — featured products reach the model", () => {
  it("sends the product block + photo so briefs depict the real frame", async () => {
    const fetchMock = stubAnthropic("submit_image_prompts", {
      hero: { prompt: "p", alt: "a", recommendedScrim: "dark", dimensions: "1200x900", notes: "n" },
      secondary: { prompts: ["p"], alts: ["a"], dimensions: "1200x800", notes: "n" },
    });
    const res = await generateImagePrompts({
      audience: "retail",
      heroVariant: "full_bleed_overlay",
      secondaryImageVariant: "full_bleed",
      themeTitle: "Honey returns",
      themeAngle: "Warm fall colorway",
      featuredProductsText: PRODUCT_BLOCK,
      productImages: [{ url: IMG }],
    });
    expect(res.ok).toBe(true);

    const body = bodyOfCall(fetchMock, 0);
    const content = body.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const text = content.find((c: { type: string }) => c.type === "text").text as string;
    expect(text).toContain("Honey Reader");
    const imgs = content.filter((c: { type: string }) => c.type === "image");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].source.url).toBe(IMG);
  });
});
