export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";

/**
 * AI Image Generation Stub
 * Ported from ~/jaxy-catalog-tool/src/lib/image-generation/
 * Requires GOOGLE_GEMINI_API_KEY for actual generation.
 * Currently returns a stub response.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { skuId, imageType, prompt } = body;

  if (!skuId) {
    return NextResponse.json({ error: "skuId required" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      error: "GOOGLE_GEMINI_API_KEY not configured",
      stub: true,
      message: "Image generation requires a Gemini API key. Set GOOGLE_GEMINI_API_KEY in your environment.",
      config: {
        model: "gemini-2.5-flash-image",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent",
        supportedTypes: ["angle", "front-on-white", "side-angle", "on-model"],
        promptEngine: "See /modules/catalog/lib/prompt-engine.ts for prompt templates",
      },
    }, { status: 503 });
  }

  // TODO: Implement actual Gemini Pro image generation
  // Port logic from ~/jaxy-catalog-tool/src/lib/image-generation/gemini.ts
  return NextResponse.json({
    error: "Generation not yet implemented — API key present, implementation pending",
    stub: true,
  }, { status: 501 });
}
