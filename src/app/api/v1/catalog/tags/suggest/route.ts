export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, tags } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { detectStyleCategory } from "@/modules/catalog/lib/prompt-engine";

/**
 * AI Tag Suggestion — rule-based fallback when no AI API key available.
 * Analyzes product attributes to suggest relevant tags.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { productId } = body;

  if (!productId) {
    return NextResponse.json({ error: "productId required" }, { status: 400 });
  }

  const product = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (product.length === 0) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const p = product[0];
  const existingTags = await db.select().from(tags).where(eq(tags.productId, productId));
  const existingNames = new Set(existingTags.map((t) => t.tagName?.toLowerCase()));

  const suggestions: { tagName: string; dimension: string }[] = [];

  const addIfNew = (name: string, dimension: string) => {
    if (!existingNames.has(name.toLowerCase())) {
      suggestions.push({ tagName: name, dimension });
    }
  };

  // Frame shape
  if (p.frameShape) addIfNew(p.frameShape, "frame_shape");

  // Material
  if (p.frameMaterial) addIfNew(p.frameMaterial, "material");

  // Category-based
  if (p.category === "sunglasses") {
    addIfNew("UV protection", "feature");
    addIfNew("outdoor", "occasion");
  }

  // Gender
  if (p.gender) addIfNew(p.gender, "gender");

  // Style detection
  const style = detectStyleCategory({
    frameShape: p.frameShape,
    frameMaterial: p.frameMaterial,
    gender: p.gender,
    lensType: null,
  });
  addIfNew(style, "style");

  // Common suggestions based on style
  const styleSuggestions: Record<string, string[]> = {
    retro: ["vintage", "classic", "timeless"],
    sporty: ["active", "athletic", "outdoor"],
    professional: ["business", "office", "formal"],
    fashion: ["trendy", "statement", "bold"],
    casual: ["everyday", "versatile", "comfortable"],
  };

  for (const tag of styleSuggestions[style] || []) {
    addIfNew(tag, "style");
  }

  // Face shape recommendations
  const faceShapes: Record<string, string[]> = {
    round: ["oval face", "square face"],
    square: ["round face", "oval face"],
    aviator: ["oval face", "heart face"],
    "cat-eye": ["round face", "heart face"],
    oval: ["any face shape"],
  };

  const shapeKey = p.frameShape?.toLowerCase() || "";
  for (const [key, faces] of Object.entries(faceShapes)) {
    if (shapeKey.includes(key)) {
      for (const face of faces) addIfNew(face, "face_shape");
    }
  }

  return NextResponse.json({ suggestions });
}
