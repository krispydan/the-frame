import { describe, it, expect } from "vitest";
import { parsePackSize, unitsFor, unitSkuOf, isPackSku } from "@/modules/finance/lib/pack-size";

describe("pack-size normalization", () => {
  describe("parsePackSize", () => {
    it("reads 12-pack and 4-pack suffixes", () => {
      expect(parsePackSize("JX1001-BLK-12PK")).toBe(12);
      expect(parsePackSize("JX1001-BLK-4PK")).toBe(4);
    });
    it("is case-insensitive", () => {
      expect(parsePackSize("JX1001-BLK-12pk")).toBe(12);
    });
    it("returns 1 for bare unit SKUs", () => {
      expect(parsePackSize("JX1001-BLK")).toBe(1);
      expect(parsePackSize("JX2003-GRY")).toBe(1);
    });
    it("returns 1 for null/empty/garbage", () => {
      expect(parsePackSize(null)).toBe(1);
      expect(parsePackSize(undefined)).toBe(1);
      expect(parsePackSize("")).toBe(1);
      expect(parsePackSize("JX1001-PK")).toBe(1); // no number
    });
    it("does not match a mid-string PK", () => {
      expect(parsePackSize("JX-12PK-BLK")).toBe(1); // suffix only
    });
  });

  describe("unitsFor", () => {
    it("multiplies pack qty into units", () => {
      expect(unitsFor("JX1001-BLK-12PK", 100)).toBe(1200);
      expect(unitsFor("JX1001-BLK-4PK", 50)).toBe(200);
    });
    it("passes through unit SKUs unchanged", () => {
      expect(unitsFor("JX1001-BLK", 96)).toBe(96);
    });
  });

  describe("unitSkuOf", () => {
    it("strips the pack suffix", () => {
      expect(unitSkuOf("JX1001-BLK-12PK")).toBe("JX1001-BLK");
      expect(unitSkuOf("JX1001-BLK-4PK")).toBe("JX1001-BLK");
    });
    it("leaves bare SKUs unchanged", () => {
      expect(unitSkuOf("JX1001-BLK")).toBe("JX1001-BLK");
    });
    it("handles null", () => {
      expect(unitSkuOf(null)).toBeNull();
    });
  });

  describe("isPackSku", () => {
    it("flags packs only", () => {
      expect(isPackSku("JX1001-BLK-12PK")).toBe(true);
      expect(isPackSku("JX1001-BLK")).toBe(false);
    });
  });

  describe("the 12x accounting invariant", () => {
    it("layer qty = packs × packSize; per-unit cost = lineTotal ÷ units", () => {
      // PO line: 100 packs of -12PK at line landed total $2892
      const packs = 100;
      const sku = "JX1001-BLK-12PK";
      const lineLandedTotal = 2892;
      const units = unitsFor(sku, packs);
      expect(units).toBe(1200);
      const perUnit = lineLandedTotal / units;
      expect(perUnit).toBeCloseTo(2.41, 2);
      // The wrong (÷packs) answer would be 28.92 — 12× too high.
      expect(lineLandedTotal / packs).toBeCloseTo(28.92, 2);
    });
  });
});
