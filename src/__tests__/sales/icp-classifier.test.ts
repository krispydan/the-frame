import { describe, it, expect } from "vitest";

function classifyICP(name: string, type: string): { tier: string; score: number } {
  const text = `${name} ${type}`.toLowerCase();
  if (["boutique", "gift shop", "optical", "eyewear", "sunglass", "resort"].some(k => text.includes(k))) return { tier: "A", score: 90 };
  if (["specialty", "bookstore", "museum", "pharmacy", "spa", "salon"].some(k => text.includes(k))) return { tier: "B", score: 70 };
  if (["retail", "general store", "department", "clothing"].some(k => text.includes(k))) return { tier: "C", score: 50 };
  if (["convenience", "gas station", "liquor", "smoke"].some(k => text.includes(k))) return { tier: "D", score: 30 };
  if (["auto parts", "laundromat", "plumbing", "dentist"].some(k => text.includes(k))) return { tier: "F", score: 10 };
  return { tier: "C", score: 50 };
}

describe("ICP Classifier", () => {
  it("classifies boutiques as Tier A", () => { expect(classifyICP("Sunset Boutique", "boutique").tier).toBe("A"); });
  it("classifies gift shops as Tier A", () => { expect(classifyICP("Main St Gift Shop", "gift shop").tier).toBe("A"); });
  it("classifies optical stores as Tier A", () => { expect(classifyICP("Clear Vision Optical", "optical").tier).toBe("A"); });
  it("classifies bookstores as Tier B", () => { expect(classifyICP("Corner Bookstore", "bookstore").tier).toBe("B"); });
  it("classifies pharmacies as Tier B", () => { expect(classifyICP("Walgreens Pharmacy", "pharmacy").tier).toBe("B"); });
  it("classifies general retail as Tier C", () => { expect(classifyICP("Joe's General Store", "general store").tier).toBe("C"); });
  it("classifies convenience stores as Tier D", () => { expect(classifyICP("Quick Stop Convenience", "convenience").tier).toBe("D"); });
  it("classifies auto parts as Tier F", () => { expect(classifyICP("AutoZone Auto Parts", "auto parts").tier).toBe("F"); });
  it("scores Tier A between 80-100", () => { const r = classifyICP("Beach Boutique", "boutique"); expect(r.score).toBeGreaterThanOrEqual(80); });
  it("scores Tier F between 0-19", () => { const r = classifyICP("Joe's Laundromat", "laundromat"); expect(r.score).toBeLessThan(20); });
});
