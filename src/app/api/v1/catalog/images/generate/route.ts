export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { skus, products, images, imageTypes } from "@/modules/catalog/schema";
import { eq } from "drizzle-orm";
import { buildProductDescription, detectStyleCategory, getModelDescription, type ProductContext } from "@/modules/catalog/lib/prompt-engine";
import { getCuratedAttrs } from "@/modules/catalog/lib/curated-attributes";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

const IMAGE_PROMPTS: Record<string, (desc: string, model?: string) => string> = {
  "front-on-white": (desc) =>
    `Professional product photo of ${desc} sunglasses by Jaxy, front-facing on a pure white background. Clean e-commerce style, studio lighting, no shadows, centered composition.`,
  angle: (desc) =>
    `Professional product photo of ${desc} sunglasses by Jaxy, shot at a 3/4 angle on a pure white background. Studio lighting, clean and minimal, e-commerce style.`,
  "side-angle": (desc) =>
    `Professional product photo of ${desc} sunglasses by Jaxy, side profile view on a pure white background. Show the temple arm detail. Studio lighting, clean.`,
  "on-model": (desc, model) =>
    `Lifestyle photo of ${model} wearing ${desc} sunglasses by Jaxy. Natural outdoor lighting, shallow depth of field, candid feel. Modern and stylish. The sunglasses should be clearly visible and the focus of the image.`,
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { skuId, imageType } = body;

  if (!skuId) {
    return NextResponse.json({ error: "skuId required" }, { status: 400 });
  }

  const validTypes = Object.keys(IMAGE_PROMPTS);
  const type = imageType || "front-on-white";
  if (!validTypes.includes(type)) {
    return NextResponse.json(
      { error: `Invalid imageType. Must be one of: ${validTypes.join(", ")}` },
      { status: 400 }
    );
  }

  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "GOOGLE_GEMINI_API_KEY not configured",
        message:
          "Image generation requires a Gemini API key. Set GOOGLE_GEMINI_API_KEY in your environment.",
      },
      { status: 503 }
    );
  }

  // Look up SKU + product
  const skuRow = await db
    .select()
    .from(skus)
    .where(eq(skus.id, skuId))
    .get();

  if (!skuRow) {
    return NextResponse.json({ error: "SKU not found" }, { status: 404 });
  }

  const product = await db
    .select()
    .from(products)
    .where(eq(products.id, skuRow.productId))
    .get();

  if (!product) {
    return NextResponse.json({ error: "Product not found for SKU" }, { status: 404 });
  }

  // Tags are the source of truth for category/shape/material/gender/lens.
  const curated = await getCuratedAttrs(product.id);

  // Build prompt
  const style = detectStyleCategory({
    frameShape: curated.frameShape,
    frameMaterial: curated.frameMaterial,
    gender: curated.gender,
    lensType: curated.lensType,
  });

  const desc = [
    product.name,
    skuRow.colorName,
    curated.frameShape,
    curated.frameMaterial,
    curated.category,
  ]
    .filter(Boolean)
    .join(" ");

  const modelDesc =
    type === "on-model" ? getModelDescription(product.id, 0) : undefined;
  const prompt = IMAGE_PROMPTS[type](desc, modelDesc);

  // Call Gemini
  let geminiRes: Response;
  try {
    geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: "Failed to reach Gemini API", detail: err.message },
      { status: 502 }
    );
  }

  if (!geminiRes.ok) {
    const errBody = await geminiRes.text().catch(() => "");
    return NextResponse.json(
      { error: "Gemini API error", status: geminiRes.status, detail: errBody },
      { status: 502 }
    );
  }

  const geminiData = await geminiRes.json();
  const parts = geminiData?.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((p: any) => p.inlineData);

  if (!imagePart?.inlineData?.data) {
    return NextResponse.json(
      { error: "No image returned from Gemini", response: geminiData },
      { status: 502 }
    );
  }

  // Save image to disk
  const imageBuffer = Buffer.from(imagePart.inlineData.data, "base64");
  const mimeType = imagePart.inlineData.mimeType || "image/png";
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const imageDir = join(process.cwd(), "data", "images", skuId);
  const fileName = `${type}.${ext}`;
  const filePath = join(imageDir, fileName);

  await mkdir(imageDir, { recursive: true });
  await writeFile(filePath, imageBuffer);

  // Find or resolve imageType id
  const imageTypeRow = await db
    .select()
    .from(imageTypes)
    .where(eq(imageTypes.slug, type))
    .get();

  // Upsert image record
  const imageId = crypto.randomUUID();
  const relativePath = `data/images/${skuId}/${fileName}`;

  // Check for existing record
  const existing = imageTypeRow
    ? await db
        .select()
        .from(images)
        .where(eq(images.skuId, skuId))
        .all()
        .then((rows) => rows.find((r) => r.imageTypeId === imageTypeRow.id))
    : undefined;

  if (existing) {
    await db
      .update(images)
      .set({
        filePath: relativePath,
        aiModelUsed: "gemini-2.5-flash-image",
        aiPrompt: prompt,
        status: "review",
      })
      .where(eq(images.id, existing.id));

    return NextResponse.json({
      id: existing.id,
      skuId,
      imageType: type,
      filePath: relativePath,
      url: `/api/v1/catalog/images/file/${skuId}/${fileName}`,
      prompt,
      model: "gemini-2.5-flash-image",
      updated: true,
    });
  }

  await db.insert(images).values({
    id: imageId,
    skuId,
    filePath: relativePath,
    imageTypeId: imageTypeRow?.id ?? null,
    aiModelUsed: "gemini-2.5-flash-image",
    aiPrompt: prompt,
    status: "review",
  });

  return NextResponse.json({
    id: imageId,
    skuId,
    imageType: type,
    filePath: relativePath,
    url: `/api/v1/catalog/images/file/${skuId}/${fileName}`,
    prompt,
    model: "gemini-2.5-flash-image",
    created: true,
  });
}
