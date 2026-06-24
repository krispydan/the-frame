/**
 * Tests for the pure featured-products helpers: the JSON id column
 * parse/serialize and the planner's auto-assign distribution.
 */
import { describe, it, expect } from "vitest";
import {
  parseFeaturedIds,
  serializeFeaturedIds,
  assignFeaturedProductIds,
} from "@/modules/marketing/lib/featured-products";

describe("featured-products — parse / serialize", () => {
  it("round-trips a clean array", () => {
    expect(parseFeaturedIds(serializeFeaturedIds(["a", "b"]))).toEqual(["a", "b"]);
  });
  it("empty / null serialize to null (clean NULL, not '[]')", () => {
    expect(serializeFeaturedIds([])).toBeNull();
    expect(serializeFeaturedIds(null)).toBeNull();
  });
  it("parse tolerates junk", () => {
    expect(parseFeaturedIds(null)).toEqual([]);
    expect(parseFeaturedIds("not json")).toEqual([]);
    expect(parseFeaturedIds('{"not":"array"}')).toEqual([]);
    expect(parseFeaturedIds('["a", 3, "", "b"]')).toEqual(["a", "b"]); // drops non-strings/empties
  });
});

describe("featured-products — planner auto-assign", () => {
  it("assigns one cycling product to each product-anchored proposal, null otherwise", () => {
    const hooks = ["Honey colorway", "", null, "Slate restock", "Clear frame"];
    const out = assignFeaturedProductIds(hooks, ["a", "b"]);
    // anchored indices 0,3,4 → cycle a,b,a ; non-anchored 1,2 → null
    expect(out).toEqual([
      JSON.stringify(["a"]),
      null,
      null,
      JSON.stringify(["b"]),
      JSON.stringify(["a"]),
    ]);
  });

  it("empty pool → every slot null (no products to assign)", () => {
    expect(assignFeaturedProductIds(["x", "y"], [])).toEqual([null, null]);
  });

  it("no anchored proposals → every slot null even with a pool", () => {
    expect(assignFeaturedProductIds(["", null, "  "], ["a", "b"])).toEqual([null, null, null]);
  });
});
