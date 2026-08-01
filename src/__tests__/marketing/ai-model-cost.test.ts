/**
 * Model selection, provider routing, and — above all — pricing.
 *
 * A bulk run billed ~$100 while logging single-digit dollars, because the
 * cost function was pinned to Haiku's rates whatever model ran. These
 * tests exist so that can't silently come back.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  skuMatchModel,
  skuMatchDisabled,
  skuMatchMaxUsd,
  modelPricing,
  isCheapVisionModel,
  visionProvider,
  DEFAULT_SKU_MATCH_MODEL,
} from "@/modules/marketing/lib/ai-model";

const ENV_KEYS = [
  "MARKETING_SKU_MATCH_MODEL",
  "ANTHROPIC_VISION_MODEL",
  "SKU_MATCH_DISABLED",
  "SKU_MATCH_MAX_USD",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("model selection", () => {
  it("defaults to the cheap Gemini tier", () => {
    expect(skuMatchModel()).toBe(DEFAULT_SKU_MATCH_MODEL);
    expect(DEFAULT_SKU_MATCH_MODEL).toMatch(/^gemini/);
    expect(isCheapVisionModel(DEFAULT_SKU_MATCH_MODEL)).toBe(true);
  });

  it("lets an env var override it (how the expensive run happened)", () => {
    process.env.MARKETING_SKU_MATCH_MODEL = "claude-opus-4-1-20250805";
    expect(skuMatchModel()).toBe("claude-opus-4-1-20250805");
    expect(isCheapVisionModel("claude-opus-4-1-20250805")).toBe(false);
  });

  it("routes model ids to the right API", () => {
    expect(visionProvider("gemini-2.5-flash-lite")).toBe("gemini");
    expect(visionProvider("gemini-3.1-flash-lite")).toBe("gemini");
    expect(visionProvider("claude-haiku-4-5-20251001")).toBe("anthropic");
    expect(visionProvider("claude-opus-4-1-20250805")).toBe("anthropic");
  });
});

describe("pricing", () => {
  it("prices each model at its own rate, not one hardcoded tier", () => {
    expect(modelPricing("gemini-2.5-flash-lite").inPerM).toBe(0.1);
    expect(modelPricing("claude-haiku-4-5-20251001").inPerM).toBe(1);
    expect(modelPricing("claude-sonnet-5").inPerM).toBe(3);
    expect(modelPricing("claude-opus-4-1-20250805").inPerM).toBe(15);
  });

  it("does not let flash-lite fall through to plain flash's rate", () => {
    // Both match /^gemini-2\.5-flash/ — order in the table decides, and
    // getting it wrong would overstate lite by 3x.
    expect(modelPricing("gemini-2.5-flash-lite").inPerM).toBe(0.1);
    expect(modelPricing("gemini-2.5-flash").inPerM).toBe(0.3);
  });

  it("prices an UNKNOWN model at the top tier — never under-report again", () => {
    const p = modelPricing("some-model-nobody-added-yet");
    expect(p.inPerM).toBe(15);
    expect(p.cheap).toBe(false);
  });

  it("Gemini cache writes are free; Anthropic's are not", () => {
    expect(modelPricing("gemini-2.5-flash-lite").cacheWriteMult).toBe(0);
    expect(modelPricing("claude-haiku-4-5-20251001").cacheWriteMult).toBe(1.25);
  });

  it("the new default is dramatically cheaper than what ran", () => {
    // The actual workload: ~10,700 input + 600 output tokens per clip.
    const cost = (model: string) => {
      const p = modelPricing(model);
      return (10_700 * p.inPerM + 600 * p.outPerM) / 1_000_000;
    };
    const opus = cost("claude-opus-4-1-20250805");
    const gemini = cost(DEFAULT_SKU_MATCH_MODEL);
    expect(gemini).toBeLessThan(opus / 50);
    // Sanity: a 900-clip library should cost cents, not hundreds.
    expect(gemini * 900).toBeLessThan(2);
    expect(opus * 900).toBeGreaterThan(100);
  });
});

describe("spend guards", () => {
  it("is off by default and switches on with the env flag", () => {
    expect(skuMatchDisabled()).toBe(false);
    for (const v of ["1", "true", "yes"]) {
      process.env.SKU_MATCH_DISABLED = v;
      expect(skuMatchDisabled()).toBe(true);
    }
    process.env.SKU_MATCH_DISABLED = "0";
    expect(skuMatchDisabled()).toBe(false);
  });

  it("caps a run at $5 unless told otherwise", () => {
    expect(skuMatchMaxUsd()).toBe(5);
    process.env.SKU_MATCH_MAX_USD = "25";
    expect(skuMatchMaxUsd()).toBe(25);
  });

  it("ignores a nonsense cap rather than disabling the cap", () => {
    for (const bad of ["", "abc", "-5", "0"]) {
      process.env.SKU_MATCH_MAX_USD = bad;
      expect(skuMatchMaxUsd()).toBe(5);
    }
  });
});
