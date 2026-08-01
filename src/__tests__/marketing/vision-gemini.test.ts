/**
 * Gemini request shape + response handling.
 *
 * The live call can't be exercised without a key, so these lock down the
 * things that would silently break it or silently cost money: the request
 * body Gemini expects, the catalog-first ordering its implicit cache
 * depends on, and the usage split that prices cached vs fresh tokens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { geminiJsonCall, GEMINI_MATCH_SCHEMA } from "@/modules/marketing/lib/video/vision-gemini";
import { matchProductsFromSheets } from "@/modules/marketing/lib/video/frame-shape-vision";

const realFetch = global.fetch;
let lastRequest: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;

/** Stand in for Gemini, capturing what we'd have sent. */
function mockGemini(responseJson: unknown, usage?: Record<string, number>) {
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    lastRequest = {
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(responseJson) }] } }],
        usageMetadata: usage ?? { promptTokenCount: 1000, candidatesTokenCount: 50 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  lastRequest = null;
  process.env.GEMINI_API_KEY = "test-key";
  delete process.env.SKU_MATCH_DISABLED;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.GEMINI_API_KEY;
});

describe("geminiJsonCall", () => {
  it("posts to the model endpoint with the api-key header and JSON mode", async () => {
    mockGemini({ clearShot: true, matches: [] });
    await geminiJsonCall("gemini-2.5-flash-lite", "sys", [{ kind: "text", text: "hi" }], GEMINI_MATCH_SCHEMA);

    expect(lastRequest!.url).toContain("/models/gemini-2.5-flash-lite:generateContent");
    expect(lastRequest!.headers["x-goog-api-key"]).toBe("test-key");
    const cfg = lastRequest!.body.generationConfig as Record<string, unknown>;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.responseSchema).toBeTruthy();
    expect(cfg.temperature).toBe(0); // identification must be repeatable
  });

  it("sends images as inlineData parts in the given order", async () => {
    mockGemini({ clearShot: false, matches: [] });
    await geminiJsonCall(
      "gemini-2.5-flash-lite",
      "sys",
      [
        { kind: "text", text: "first" },
        { kind: "image", mime: "image/jpeg", base64: "AAA" },
      ],
      GEMINI_MATCH_SCHEMA,
    );
    const parts = (lastRequest!.body.contents as Array<{ parts: unknown[] }>)[0].parts as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ text: "first" });
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: "AAA" } });
  });

  it("splits cached tokens out of the prompt count so each is priced right", async () => {
    // promptTokenCount INCLUDES cached tokens; counting both would bill
    // the cached prefix twice.
    mockGemini({ clearShot: true, matches: [] }, {
      promptTokenCount: 32_000,
      cachedContentTokenCount: 30_000,
      candidatesTokenCount: 100,
    });
    const r = await geminiJsonCall("gemini-2.5-flash-lite", "s", [{ kind: "text", text: "x" }], GEMINI_MATCH_SCHEMA);
    expect(r.usage!.input_tokens).toBe(2_000);
    expect(r.usage!.cache_read_input_tokens).toBe(30_000);
    expect(r.usage!.cache_creation_input_tokens).toBe(0); // implicit cache — free
  });

  it("reports a non-JSON body as an error instead of throwing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
      text: async () => "",
    }) as unknown as Response) as unknown as typeof fetch;
    const r = await geminiJsonCall("gemini-2.5-flash-lite", "s", [{ kind: "text", text: "x" }], GEMINI_MATCH_SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not valid JSON/i);
  });

  it("surfaces an API error rather than throwing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => "rate limited",
    }) as unknown as Response) as unknown as typeof fetch;
    const r = await geminiJsonCall("gemini-2.5-flash-lite", "s", [{ kind: "text", text: "x" }], GEMINI_MATCH_SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("429");
  });

  it("refuses without a key instead of calling", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;
    const r = await geminiJsonCall("gemini-2.5-flash-lite", "s", [{ kind: "text", text: "x" }], GEMINI_MATCH_SCHEMA);
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("matchProductsFromSheets on Gemini", () => {
  const catalog = [
    { label: "#1 — Alpha (JX1)", base64: "a" },
    { label: "#2 — Beta (JX2)", base64: "b" },
  ];
  const crops = [{ base64: "crop", mime: "image/jpeg" }];

  it("puts the catalog FIRST — the implicit cache needs a stable prefix", async () => {
    mockGemini({ clearShot: true, matches: [{ number: 1, confidence: 90 }] });
    await matchProductsFromSheets(crops, catalog, {}, "gemini-2.5-flash-lite");

    const parts = (lastRequest!.body.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0].parts;
    expect(String(parts[0].text)).toContain("CATALOG");
    // ...and the varying target comes after every catalog entry.
    const targetAt = parts.findIndex((p) => String(p.text ?? "").includes("TARGET"));
    const lastCatalogAt = parts.findIndex((p) => String(p.text ?? "").includes("Beta"));
    expect(lastCatalogAt).toBeGreaterThan(0);
    expect(targetAt).toBeGreaterThan(lastCatalogAt);
  });

  it("drops hallucinated product numbers outside the catalog range", async () => {
    mockGemini({
      clearShot: true,
      matches: [
        { number: 1, confidence: 80 },
        { number: 99, confidence: 95 }, // doesn't exist — must be dropped
        { number: 0, confidence: 70 },
      ],
    });
    const r = await matchProductsFromSheets(crops, catalog, {}, "gemini-2.5-flash-lite");
    expect(r.ok).toBe(true);
    expect(r.matches.map((m) => m.index)).toEqual([1]);
  });

  it("only accepts a videoType from the offered list", async () => {
    mockGemini({ clearShot: true, matches: [{ number: 1, confidence: 60 }], videoType: "made_up_slug" });
    const r = await matchProductsFromSheets(crops, catalog, {
      fullFrame: { base64: "f", mime: "image/jpeg" },
      videoTypes: [{ slug: "on_model", name: "On model", description: null }],
    }, "gemini-2.5-flash-lite");
    expect(r.videoType).toBeNull();
  });

  it("makes no call at all when the kill switch is on", async () => {
    process.env.SKU_MATCH_DISABLED = "1";
    const spy = vi.fn();
    global.fetch = spy as unknown as typeof fetch;
    const r = await matchProductsFromSheets(crops, catalog, {}, "gemini-2.5-flash-lite");
    expect(r.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
