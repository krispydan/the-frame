export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { products, tags, copyVersions } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { COPY_PROMPTS, detectStyleCategory } from "@/modules/catalog/lib/prompt-engine";

/**
 * AI Copy Generation
 * Uses Claude/OpenAI when API key available, falls back to template-based generation.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { productId, field, model } = body;

  if (!productId || !field) {
    return NextResponse.json({ error: "productId and field required" }, { status: 400 });
  }

  const product = await db.select().from(products).where(eq(products.id, productId)).limit(1);
  if (product.length === 0) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }

  const p = product[0];
  const productTags = await db.select().from(tags).where(eq(tags.productId, productId));
  const tagNames = productTags.map((t) => t.tagName).filter(Boolean).join(", ");

  const details = [
    p.category && `Category: ${p.category}`,
    p.frameShape && `Shape: ${p.frameShape}`,
    p.frameMaterial && `Material: ${p.frameMaterial}`,
    p.gender && `Gender: ${p.gender}`,
    tagNames && `Tags: ${tagNames}`,
  ].filter(Boolean).join(". ");

  const name = p.name || p.skuPrefix || "Product";

  // Try AI generation
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  let content: string;

  if (anthropicKey || openaiKey) {
    // Get the appropriate prompt
    let prompt: string;
    switch (field) {
      case "description": prompt = COPY_PROMPTS.description(name, details); break;
      case "short_description": prompt = COPY_PROMPTS.shortDescription(name, details); break;
      case "bullet_points": prompt = COPY_PROMPTS.bulletPoints(name, details); break;
      case "name": prompt = COPY_PROMPTS.productName(details); break;
      default: return NextResponse.json({ error: "Invalid field" }, { status: 400 });
    }

    try {
      if (anthropicKey) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: model || "claude-sonnet-4-20250514",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await res.json();
        content = data.content?.[0]?.text || "Generation failed";
      } else {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: model || "gpt-4o",
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await res.json();
        content = data.choices?.[0]?.message?.content || "Generation failed";
      }
    } catch (e) {
      content = `[AI generation failed: ${e}]`;
    }
  } else {
    // Template-based fallback
    const style = detectStyleCategory({ frameShape: p.frameShape, frameMaterial: p.frameMaterial, gender: p.gender });
    switch (field) {
      case "description":
        content = `Introducing the ${name} by Jaxy — ${style} ${p.category || "sunglasses"} crafted with ${p.frameMaterial || "premium materials"} in a ${p.frameShape || "classic"} silhouette. ${tagNames ? `Featuring ${tagNames}.` : ""} Perfect for those who appreciate both style and quality.`;
        break;
      case "short_description":
        content = `${name} ${p.frameShape || ""} ${p.category || "sunglasses"} by Jaxy. ${style} style with premium construction.`.trim();
        break;
      case "bullet_points":
        content = JSON.stringify([
          `${p.frameShape || "Classic"} frame design`,
          `${p.frameMaterial || "Premium"} construction`,
          "UV400 protection lenses",
          "Includes protective case",
          `${p.gender ? `Designed for ${p.gender}` : "Unisex fit"}`,
        ]);
        break;
      case "name":
        content = JSON.stringify([name, `${name} ${style}`, `Jaxy ${p.frameShape || "Classic"}`]);
        break;
      default:
        content = "";
    }
  }

  // Save version
  const versionId = crypto.randomUUID();
  await db.insert(copyVersions).values({
    id: versionId,
    productId,
    fieldName: field as any,
    content,
    aiModel: anthropicKey ? "claude" : openaiKey ? "gpt-4o" : "template",
  });

  return NextResponse.json({ content, model: anthropicKey ? "claude" : openaiKey ? "gpt-4o" : "template" });
}
