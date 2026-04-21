/**
 * Seed data for AI image generation: personas, prompt templates, variable preset pools,
 * and new image types. Idempotently applied on startup via seedImageGenData().
 *
 * Editable at runtime via the admin UI / MCP tools — this file is only the initial bootstrap.
 * After seed runs once, edits made in the DB will NOT be overwritten; only new rows are added.
 *
 * Template variables use {{VAR}} placeholders resolved by prompt-builder.ts.
 * Available variables: SHOT_TYPE, LIGHTING, ENVIRONMENT, ACTION, AGE_RANGE, ASPECT_RATIO,
 *                      ATTENTION_MOMENT (UGC only).
 */

export type SeedPersona = {
  slug: string;
  name: string;
  description: string;
  ageRange: string;
  moodKeywords: string;
  kind: "lifestyle" | "studio" | "ugc";
  sortOrder: number;
};

export type SeedImageType = {
  slug: string;
  label: string;
  aspectRatio: string;
  minWidth: number;
  minHeight: number;
  platform?: string;
  description?: string;
  sortOrder: number;
  /** Used by the distribution algorithm to group types into generation slots. */
  kind: "product" | "lifestyle" | "studio" | "ugc";
};

export type SeedTemplate = {
  personaSlug: string;
  /** If set, template targets exactly this image type. If null, applies to any image-type of `kind`. */
  imageTypeSlug: string | null;
  kind: "lifestyle" | "studio" | "ugc";
  slug: string;
  name: string;
  orderIndex: number;
  requiredVars: string[];
  templateText: string;
};

export type SeedVariablePreset = {
  imageTypeSlug: string | null;
  personaSlug: string | null;
  varName: string;
  values: string[];
};

// ───────────────────────────── PERSONAS ─────────────────────────────
export const SEED_PERSONAS: SeedPersona[] = [
  {
    slug: "elevated-classic",
    name: "Elevated Classic / Everyday Basics",
    description:
      "Polished, approachable, effortless 30-50. Responds to clarity, realistic usage, trust-building imagery. Clean, calm, refined, non-distracting.",
    ageRange: "30-50",
    moodKeywords: "clean, calm, refined, trustworthy, non-distracting, structured, minimal",
    kind: "lifestyle",
    sortOrder: 1,
  },
  {
    slug: "trendsetters",
    name: "Trendsetters / Fashion Enthusiasts",
    description:
      "Fashion-forward, slightly rebellious, expressive. Candid, editorial, airy, non-stock, unposed. 20-35.",
    ageRange: "22-35",
    moodKeywords: "organic, imperfect, authentic, fashion-forward, rebellious, expressive, airy",
    kind: "lifestyle",
    sortOrder: 2,
  },
  {
    slug: "modern-vintage",
    name: "Modern Vintage / Creative Muse",
    description:
      "Nostalgic, artistic, intimate. Poetic, layered, film-like. Muted tones, natural fabrics. 25-40.",
    ageRange: "25-40",
    moodKeywords: "nostalgic, artistic, intimate, imperfect, poetic, cinematic, tactile",
    kind: "lifestyle",
    sortOrder: 3,
  },
  {
    slug: "studio",
    name: "Studio",
    description:
      "Controlled, premium product imagery for PDP hero and flatlay shots. Neutral surfaces, minimal props.",
    ageRange: "n/a",
    moodKeywords: "premium, clean, controlled, minimal, luxurious",
    kind: "studio",
    sortOrder: 4,
  },
  {
    slug: "ugc",
    name: "UGC / Social Native",
    description:
      "High-conversion selfie/mirror/POV content for ads. Handheld, imperfect, phone-camera feel. 22-35.",
    ageRange: "22-35",
    moodKeywords: "authentic, spontaneous, social-native, unpolished, relatable",
    kind: "ugc",
    sortOrder: 5,
  },
];

// ──────────────────────────── IMAGE TYPES ────────────────────────────
export const SEED_IMAGE_TYPES: SeedImageType[] = [
  {
    slug: "lifestyle-outdoor",
    label: "Lifestyle — Outdoor",
    aspectRatio: "4:5",
    minWidth: 1080,
    minHeight: 1350,
    platform: "all",
    description: "Candid outdoor lifestyle",
    sortOrder: 10,
    kind: "lifestyle",
  },
  {
    slug: "lifestyle-indoor",
    label: "Lifestyle — Indoor",
    aspectRatio: "4:5",
    minWidth: 1080,
    minHeight: 1350,
    platform: "all",
    description: "Indoor lifestyle — cafes, homes, offices",
    sortOrder: 11,
    kind: "lifestyle",
  },
  {
    slug: "lifestyle-fashion",
    label: "Lifestyle — Fashion",
    aspectRatio: "4:5",
    minWidth: 1080,
    minHeight: 1350,
    platform: "all",
    description: "Editorial fashion-forward lifestyle",
    sortOrder: 12,
    kind: "lifestyle",
  },
  {
    slug: "studio-marble",
    label: "Studio — Marble",
    aspectRatio: "1:1",
    minWidth: 2048,
    minHeight: 2048,
    platform: "all",
    description: "Premium product shot on marble surface",
    sortOrder: 20,
    kind: "studio",
  },
  {
    slug: "studio-flatlay",
    label: "Studio — Flatlay",
    aspectRatio: "1:1",
    minWidth: 2048,
    minHeight: 2048,
    platform: "all",
    description: "Top-down flatlay with styled props",
    sortOrder: 21,
    kind: "studio",
  },
  {
    slug: "ugc",
    label: "UGC Ad",
    aspectRatio: "9:16",
    minWidth: 1080,
    minHeight: 1920,
    platform: "all",
    description: "Handheld selfie/mirror/POV, 9:16 vertical",
    sortOrder: 30,
    kind: "ugc",
  },
];

// ──────────────────────── LIFESTYLE TEMPLATES ────────────────────────
// 5 templates per lifestyle persona, image-type-agnostic (kind="lifestyle").
// Variable pools scoped per image-type give each slot its own environment/action flavor.

const LIFESTYLE_REQUIRED_VARS = ["SHOT_TYPE", "LIGHTING", "ENVIRONMENT", "ACTION", "AGE_RANGE", "ASPECT_RATIO"];

// ── Elevated Classic ──
const EC_TEMPLATES: Omit<SeedTemplate, "personaSlug" | "kind">[] = [
  {
    imageTypeSlug: null,
    slug: "everyday-confidence",
    name: "Everyday Confidence",
    orderIndex: 0,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} of a subject aged {{AGE_RANGE}} in {{ENVIRONMENT}}, captured in a natural everyday moment — {{ACTION}}.
The subject appears confident, calm, and put-together without looking overly styled. Their look is minimal, clean, and timeless.
Lighting is {{LIGHTING}}, soft and even, with natural tones and balanced contrast.
The mood is refined and practical — clean, trustworthy, and relatable. The image feels real and functional, not overly artistic or experimental.
Composition is structured and minimal, with clear subject focus and no visual clutter.
Shot on a 50mm or 85mm lens, with natural depth of field and sharp product visibility.
The sunglasses (exact product as shown in the reference images) are clearly visible and integrated into everyday use.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided — same frame shape, color, materials, proportions, branding. Do NOT modify them.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "work-to-weekend",
    name: "Work to Weekend",
    orderIndex: 1,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} of a subject aged {{AGE_RANGE}} transitioning through an everyday setting in {{ENVIRONMENT}}, such as moving between work and casual life.
The subject is engaged in a simple, natural action — {{ACTION}}.
Their styling is versatile and neutral — suitable for both professional and casual contexts.
Lighting is {{LIGHTING}}, clean and natural, emphasizing clarity and realism.
The mood is practical, polished, and effortless — showcasing how the product fits seamlessly into different parts of daily life.
Composition is balanced and uncluttered, with a premium but approachable feel.
Shot on a 50mm lens, with moderate depth of field.
The sunglasses (exact product as shown in the reference images) are a functional and stylish everyday element.
CRITICAL: No alterations to the sunglasses.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "product-detail",
    name: "Product Detail (Quality Focus)",
    orderIndex: 2,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A close-up {{SHOT_TYPE}} highlighting the sunglasses (exact product as shown in the reference images) in a real-life context within {{ENVIRONMENT}}.
The focus is on material quality and construction — lenses, frame, hinges, and finish.
Subtle interaction: {{ACTION}}.
Lighting is {{LIGHTING}}, soft but precise, enhancing textures, reflections, and clarity.
The mood is clean, premium, and informative — emphasizing quality and durability without looking overly commercial.
Composition is minimal and controlled, with sharp focus on the product.
Shot on an 85mm lens, with shallow depth of field and high clarity.
CRITICAL: The sunglasses must remain EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "clean-lifestyle-product",
    name: "Clean Lifestyle Product",
    orderIndex: 3,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} lifestyle scene in {{ENVIRONMENT}}, where the sunglasses (exact product as shown in the reference images) are integrated naturally into a clean, everyday setting.
The scene includes subtle contextual elements (e.g. table, bag, personal items) but remains minimal and uncluttered.
The subject is {{ACTION}}.
Lighting is {{LIGHTING}}, soft and even, with neutral tones and a premium feel.
The mood is calm, structured, and refined — focused on usability and everyday appeal.
Composition emphasizes balance, symmetry, and clarity, avoiding visual noise.
Shot on a 50mm lens with a natural depth of field.
The sunglasses are the clear hero of the frame.
CRITICAL: No changes to product design, color, or details.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "universal-unisex",
    name: "Universal / Unisex Appeal",
    orderIndex: 4,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} featuring a subject aged {{AGE_RANGE}} in {{ENVIRONMENT}}, showcasing a universal, inclusive style.
The subject is styled in neutral, timeless outfits that work across different lifestyles.
They are captured in a natural moment — {{ACTION}} — without forced posing.
Lighting is {{LIGHTING}}, clean and natural, emphasizing skin tones and product clarity.
The mood is inclusive, modern, and effortless — focusing on versatility and everyday wearability.
Composition is simple and balanced, with a premium yet approachable feel.
Shot on a 50mm lens, with controlled depth of field.
The sunglasses (exact product as shown in the reference images) are worn naturally.
CRITICAL: Do NOT modify the sunglasses.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
];

// ── Trendsetters ──
const TS_TEMPLATES: Omit<SeedTemplate, "personaSlug" | "kind">[] = [
  {
    imageTypeSlug: null,
    slug: "core-social-energy",
    name: "Core Jaxy Social Energy",
    orderIndex: 0,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A candid {{SHOT_TYPE}} of a group of stylish individuals aged {{AGE_RANGE}} in {{ENVIRONMENT}}. The moment feels completely unposed — they are mid-conversation, laughing, reacting, or sharing something casually, as if the camera captured them without interrupting.
The styling is effortless but intentional — minimal outfits, slightly undone details, natural textures. No one is trying too hard, but everyone looks naturally cool.
Lighting is {{LIGHTING}}, soft and warm, creating subtle highlights and gentle contrast. Skin tones feel real, not over-retouched.
Action anchor: {{ACTION}}.
The mood is organic, imperfect, and authentic — avoiding any stock-photo feel. Strong fashion-forward presence — slightly rebellious, expressive, confident.
Composition is airy with negative space, not overcrowded, allowing breathing room around subjects. Depth feels natural with soft background falloff.
All subjects are wearing the sunglasses (exact product as shown in the reference images), integrated naturally into the moment.
Shot on a 50mm lens, shallow depth of field.
CRITICAL: Do NOT modify the sunglasses in any way. Keep exact shape, color, proportions, and branding.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "solo-not-trying-hero",
    name: 'Solo "Not Trying" Hero',
    orderIndex: 1,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} of a single subject aged {{AGE_RANGE}} in {{ENVIRONMENT}}. The subject is captured mid-action — {{ACTION}} — creating a natural, unaware-of-the-camera feeling.
The attitude is effortless and confident. Styling is simple but sharp — slightly imperfect, not overly polished, with a strong sense of individuality.
Lighting is {{LIGHTING}}, soft and natural with a subtle glow, enhancing textures without looking artificial.
The image feels like a real moment, not staged — organic, relaxed, but undeniably fashionable.
Composition is clean and airy, with intentional negative space and strong visual balance. The subject is not perfectly centered, adding a more editorial, dynamic feel.
Shot on an 85mm lens, shallow depth of field.
The sunglasses (exact product as shown in the reference images) are clearly visible and integrated naturally.
CRITICAL: The sunglasses must remain EXACTLY as provided. No changes allowed.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "micro-moment-detail",
    name: "Micro Moment / Detail Lifestyle",
    orderIndex: 2,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A close-up {{SHOT_TYPE}} capturing a subtle, real-life moment between the subject and the environment in {{ENVIRONMENT}}.
The focus is on texture and interaction — skin, fabric, light, and movement. The subject (aged {{AGE_RANGE}}) is engaged in a natural action such as {{ACTION}}.
The framing feels intimate and slightly imperfect, like a moment caught in between poses.
Lighting is {{LIGHTING}}, soft and directional, enhancing depth and realism without looking staged.
The mood is organic, tactile, and grounded, while still feeling premium and fashion-oriented.
Composition is tight but breathable, with shallow depth of field and natural focus falloff.
The sunglasses (exact product as shown in the reference images) are sharp, visible, and unchanged.
CRITICAL: No modifications to product shape, color, or branding.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "disruptive-summer-editorial",
    name: "Disruptive Summer Editorial",
    orderIndex: 3,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} capturing an unconventional, fashion-forward summer moment in {{ENVIRONMENT}}.
The subject, aged {{AGE_RANGE}}, is doing something slightly unexpected or visually interesting — {{ACTION}} — creating a scene that feels spontaneous but visually striking.
The styling is minimal yet expressive, with personality and attitude coming through naturally.
Lighting is {{LIGHTING}}, adding warmth and subtle contrast, possibly with light flares, reflections, or glow.
The image feels like a real moment elevated into an editorial — imperfect, expressive, slightly chaotic but controlled.
It should NOT feel like a traditional commercial or stock image — fresh, modern, and a bit rebellious.
Composition is dynamic but still balanced, with negative space and intentional framing.
Shot on a 50mm or 85mm lens, shallow depth of field.
The sunglasses (exact product as shown in the reference images) are a key styling element.
CRITICAL: Do not alter the sunglasses under any circumstance.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "airy-product-lifestyle",
    name: "Airy Product Lifestyle (No Stock Feel)",
    orderIndex: 4,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} lifestyle product scene in {{ENVIRONMENT}}, where the sunglasses (exact product as shown in the reference images) are naturally placed or integrated into a real-life context.
The environment feels lived-in and slightly imperfect — subtle details like texture, objects, or signs of human presence.
Optional subtle interaction: {{ACTION}}, but the moment feels effortless and not staged.
Lighting is {{LIGHTING}}, soft and natural, creating a warm, premium atmosphere.
The mood is calm, airy, and organic, but still clearly fashion-oriented — clean yet not sterile.
Composition emphasizes negative space and balance, allowing the product to breathe while still feeling part of a real moment.
Shot on a 50mm lens, shallow depth of field.
The sunglasses remain the hero and must be preserved exactly.
CRITICAL: No changes to product design, color, proportions, or details.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
];

// ── Modern Vintage ──
const MV_TEMPLATES: Omit<SeedTemplate, "personaSlug" | "kind">[] = [
  {
    imageTypeSlug: null,
    slug: "quiet-moment-artistic-presence",
    name: "Quiet Moment / Artistic Presence",
    orderIndex: 0,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} of a subject aged {{AGE_RANGE}} in {{ENVIRONMENT}}, captured in a quiet, introspective moment. The subject is not engaging directly with the camera — instead, they are immersed in a subtle action such as {{ACTION}}.
The styling is timeless and understated, with a slightly vintage-inspired aesthetic — natural fabrics, muted tones, and soft textures.
Lighting is {{LIGHTING}}, diffused and gentle, creating soft shadows and a calm atmosphere.
The mood is nostalgic and artistic, with a sense of stillness and authenticity. The image feels like a memory rather than a staged photograph.
Composition is slightly asymmetrical and layered, with natural imperfections and depth.
Shot on a 50mm lens with shallow depth of field and a subtle film-like softness.
The sunglasses (exact product as shown in the reference images) are integrated naturally into the scene.
CRITICAL: Do NOT modify the sunglasses in any way.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "textured-lifestyle-sensory",
    name: "Textured Lifestyle (Sensory / Tactile)",
    orderIndex: 1,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A close-up {{SHOT_TYPE}} focusing on texture, material, and subtle interaction in {{ENVIRONMENT}}.
The subject (aged {{AGE_RANGE}}) is partially visible or softly framed, engaged in a natural action such as {{ACTION}}.
The image emphasizes tactile details — skin, fabric, surfaces, light, and shadow.
Lighting is {{LIGHTING}}, soft and directional, enhancing depth and texture without harsh contrast.
The mood is intimate, imperfect, and grounded, with a quiet artistic sensibility.
Composition is layered and organic, allowing elements to overlap naturally without feeling overly composed.
Shot on a 35mm or 50mm lens with shallow depth of field and subtle grain or softness.
The sunglasses (exact product as shown in the reference images) remain sharp and unchanged.
CRITICAL: No modifications to the product.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "creative-muse",
    name: "Creative Muse (Editorial But Soft)",
    orderIndex: 2,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} of a creative, expressive subject aged {{AGE_RANGE}} in {{ENVIRONMENT}}.
The subject has a strong yet quiet presence — not overly posed, but naturally expressive. Their posture and gaze feel intuitive and slightly unconventional.
Styling blends vintage influence with modern minimalism — unique textures, layered pieces, and subtle individuality.
Action: {{ACTION}}.
Lighting is {{LIGHTING}}, soft and cinematic, possibly with gentle shadows or window light creating depth.
The mood is artistic, poetic, and slightly nostalgic, avoiding any commercial or stock-like feeling.
Composition is intentional but not rigid — slightly off-center, with breathing room and visual rhythm.
Shot on a 50mm lens, shallow depth of field, with a soft film-like aesthetic.
The sunglasses (exact product as shown in the reference images) are a natural extension of the subject's identity.
CRITICAL: The sunglasses must remain EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "still-life-human-trace",
    name: "Still Life + Human Trace",
    orderIndex: 3,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} lifestyle still-life scene in {{ENVIRONMENT}}, where the sunglasses (exact product as shown in the reference images) are placed within a textured, real-world setting.
The scene includes subtle signs of human presence, suggesting a lived-in moment. Surfaces may include natural materials such as wood, linen, paper, or worn textures.
Optional human trace: {{ACTION}}.
Lighting is {{LIGHTING}}, soft and diffused, creating gentle gradients and shadows.
The mood is calm, nostalgic, and intimate, with an artistic sensibility.
Composition is layered and slightly imperfect, avoiding symmetry and overly polished arrangements.
Shot on a 50mm lens with shallow depth of field and a soft cinematic feel.
The sunglasses remain the hero and must be preserved exactly.
CRITICAL: No changes to product design, color, or details.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: null,
    slug: "memory-like-summer",
    name: "Memory-like Summer (Vintage Feel)",
    orderIndex: 4,
    requiredVars: LIFESTYLE_REQUIRED_VARS,
    templateText: `
A {{SHOT_TYPE}} capturing a soft, memory-like summer moment in {{ENVIRONMENT}}.
The subject, aged {{AGE_RANGE}}, is engaged in a slow, natural action — {{ACTION}}.
The scene feels slightly faded or timeless, like a captured memory rather than a staged image.
Lighting is {{LIGHTING}}, warm and diffused, possibly with gentle haze or glow.
The mood is nostalgic, emotional, and understated, with a strong sense of atmosphere.
Composition is airy but layered, allowing depth and subtle imperfection.
Shot on a 35mm or 50mm lens, shallow depth of field, with a soft film-like texture.
The sunglasses (exact product as shown in the reference images) are present but integrated naturally into the story.
CRITICAL: Do not modify the sunglasses.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
];

// ── Studio ──
const STUDIO_MARBLE_TEMPLATE = `
A {{SHOT_TYPE}} premium studio product photo of the sunglasses (exact product as shown in the reference images), resting on {{ENVIRONMENT}}.
The sunglasses are {{ACTION}}.
Lighting is {{LIGHTING}}, emphasizing the material quality of both the frames and the surface.
Composition is minimal and premium, with the sunglasses as the clear hero. Subtle, controlled shadows. No humans in frame. No branding or logos other than what is already visible on the provided product.
Shot on an 85mm macro-capable lens, sharp focus on the sunglasses, subtle depth of field on the background.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided — same frame shape, color, lenses, hinges, branding, and proportions.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim();

const STUDIO_FLATLAY_TEMPLATE = `
A {{SHOT_TYPE}} flatlay composition of the sunglasses (exact product as shown in the reference images), {{ENVIRONMENT}}.
The sunglasses are {{ACTION}}.
Lighting is {{LIGHTING}}, soft and even, with subtle shadows anchoring the sunglasses to the surface.
Styling is minimal, premium, and editorial — sunglasses are the clear hero; any props are secondary and do not compete for attention.
Color palette is restrained, muted, and tasteful. No humans. No extraneous logos or text.
Shot from directly above (or very close to it) with a macro-capable lens.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided — same frame shape, color, lenses, hinges, branding, and proportions.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim();

// ── UGC — 5 templates under ugc persona ──
const UGC_TEMPLATES: Omit<SeedTemplate, "personaSlug" | "kind">[] = [
  {
    imageTypeSlug: "ugc",
    slug: "pov-just-got-these",
    name: "POV — You Just Got These",
    orderIndex: 0,
    requiredVars: ["AGE_RANGE", "ENVIRONMENT", "LIGHTING", "ASPECT_RATIO", "ATTENTION_MOMENT"],
    templateText: `
A handheld front-camera selfie video-style frame of a person aged {{AGE_RANGE}} wearing the sunglasses (exact product as shown in the reference images), filmed in {{ENVIRONMENT}}.
The first frame captures an attention-grabbing moment — {{ATTENTION_MOMENT}}.
The movement feels immediate and unplanned, like a real social media post.
Lighting is {{LIGHTING}}, natural and slightly uneven, with real highlights and shadows.
Framing is imperfect and dynamic — slight motion blur, subtle camera shake, casual cropping.
The subject's expression is genuine — a mix of curiosity, confidence, or subtle excitement.
The overall feel is spontaneous, relatable, and highly social-native.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided — same frame shape, color, branding, reflections, and proportions.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: "ugc",
    slug: "car-selfie",
    name: "Car Selfie — High Conversion Classic",
    orderIndex: 1,
    requiredVars: ["AGE_RANGE", "LIGHTING", "ASPECT_RATIO"],
    templateText: `
A front-camera selfie of a person aged {{AGE_RANGE}} sitting in a car, wearing the sunglasses (exact product as shown in the reference images).
The subject is holding the phone casually, capturing themselves mid-moment — slightly adjusting the glasses or reacting naturally.
Lighting is {{LIGHTING}} — natural sunlight entering through the window creates realistic highlights and shadows across the face and lenses.
The framing is slightly off-center, with visible parts of the car interior.
The image feels completely unpolished and real — like a quick photo taken before driving.
Small imperfections (slight blur, uneven exposure) are intentional.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: "ugc",
    slug: "mirror-check",
    name: "Mirror Check — Outfit Validation",
    orderIndex: 2,
    requiredVars: ["AGE_RANGE", "ENVIRONMENT", "LIGHTING", "ASPECT_RATIO"],
    templateText: `
A mirror selfie of a person aged {{AGE_RANGE}} wearing the sunglasses (exact product as shown in the reference images) in {{ENVIRONMENT}}.
The subject is casually checking their outfit, holding the phone naturally, partially covering their face.
The moment feels like a quick "fit check" — not staged or carefully composed.
Lighting is {{LIGHTING}}, slightly inconsistent and realistic.
The mirror may include subtle imperfections (smudges, reflections, uneven clarity).
Framing is imperfect and slightly cropped, reinforcing authenticity.
The overall mood is casual, confident, and relatable.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: "ugc",
    slug: "close-up-real-skin",
    name: "Close-up Real Skin — Trust Builder",
    orderIndex: 3,
    requiredVars: ["AGE_RANGE", "LIGHTING", "ASPECT_RATIO"],
    templateText: `
A very close-up front-camera selfie focusing on the sunglasses (exact product as shown in the reference images) and upper face of a person aged {{AGE_RANGE}}.
The camera is held very close, creating a slightly distorted perspective typical of smartphones.
Skin texture is visible — no heavy retouching, maintaining realism.
Lighting is {{LIGHTING}}, natural and slightly uneven.
The subject subtly moves or adjusts the sunglasses, creating a real-time interaction feel.
Reflections on the lenses feel natural and consistent with the environment.
The image feels intimate, raw, and trustworthy.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
  {
    imageTypeSlug: "ugc",
    slug: "friend-capture",
    name: "Friend Capture — Scroll Stopper",
    orderIndex: 4,
    requiredVars: ["AGE_RANGE", "ENVIRONMENT", "LIGHTING", "ASPECT_RATIO"],
    templateText: `
A casual, handheld photo taken by a friend of a person aged {{AGE_RANGE}} wearing the sunglasses (exact product as shown in the reference images) in {{ENVIRONMENT}}.
The subject is mid-action — laughing, turning, walking, or reacting — not posing for the camera.
The framing is imperfect and slightly chaotic, as if captured spontaneously.
Lighting is {{LIGHTING}}, natural and unpolished.
There may be slight motion blur or softness, enhancing realism.
The moment feels alive, social, and unfiltered — like a real post shared between friends.
CRITICAL: The sunglasses must be reproduced EXACTLY as provided.
Aspect ratio: {{ASPECT_RATIO}}.
`.trim(),
  },
];

// Assemble
export const SEED_TEMPLATES: SeedTemplate[] = [
  ...EC_TEMPLATES.map((t) => ({ ...t, personaSlug: "elevated-classic", kind: "lifestyle" as const })),
  ...TS_TEMPLATES.map((t) => ({ ...t, personaSlug: "trendsetters", kind: "lifestyle" as const })),
  ...MV_TEMPLATES.map((t) => ({ ...t, personaSlug: "modern-vintage", kind: "lifestyle" as const })),
  {
    personaSlug: "studio",
    imageTypeSlug: "studio-marble",
    kind: "studio",
    slug: "premium-marble",
    name: "Premium Marble",
    orderIndex: 0,
    requiredVars: ["SHOT_TYPE", "LIGHTING", "ENVIRONMENT", "ACTION", "ASPECT_RATIO"],
    templateText: STUDIO_MARBLE_TEMPLATE,
  },
  {
    personaSlug: "studio",
    imageTypeSlug: "studio-flatlay",
    kind: "studio",
    slug: "premium-flatlay",
    name: "Premium Flatlay",
    orderIndex: 0,
    requiredVars: ["SHOT_TYPE", "LIGHTING", "ENVIRONMENT", "ACTION", "ASPECT_RATIO"],
    templateText: STUDIO_FLATLAY_TEMPLATE,
  },
  ...UGC_TEMPLATES.map((t) => ({ ...t, personaSlug: "ugc", kind: "ugc" as const })),
];

// ─────────────────────────── VARIABLE PRESETS ───────────────────────────
export const SEED_VARIABLE_PRESETS: SeedVariablePreset[] = [
  // ── Lifestyle-outdoor ──
  {
    imageTypeSlug: "lifestyle-outdoor",
    personaSlug: null,
    varName: "SHOT_TYPE",
    values: ["medium shot", "full body shot", "close-up portrait", "candid mid-action shot"],
  },
  {
    imageTypeSlug: "lifestyle-outdoor",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "soft golden hour sunlight",
      "bright diffused daylight",
      "late afternoon warm light",
      "overcast daylight with soft shadows",
      "backlit glow with subtle lens flare",
    ],
  },
  {
    imageTypeSlug: "lifestyle-outdoor",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "a quiet european cobblestone street",
      "a coastal cliff path overlooking the ocean",
      "a rooftop terrace of an urban building",
      "a sunlit park with tall trees",
      "a pedestrian bridge at golden hour",
      "a coastal boardwalk",
      "an outdoor cafe terrace",
      "a botanical garden path",
      "a desert road at sunset",
      "a mediterranean seaside town",
      "a city plaza with a fountain",
      "a beach at low tide",
    ],
  },
  {
    imageTypeSlug: "lifestyle-outdoor",
    personaSlug: null,
    varName: "ACTION",
    values: [
      "walking casually while glancing to the side",
      "pausing mid-step to look out at the view",
      "adjusting a jacket while walking",
      "holding a coffee and glancing away",
      "leaning against a low wall",
      "carrying a leather bag across the shoulder",
      "sitting on a bench with one arm draped",
      "mid-conversation gesture caught in motion",
    ],
  },

  // ── Lifestyle-indoor ──
  {
    imageTypeSlug: "lifestyle-indoor",
    personaSlug: null,
    varName: "SHOT_TYPE",
    values: ["medium shot", "close-up portrait", "3/4 seated shot", "candid product-focused shot"],
  },
  {
    imageTypeSlug: "lifestyle-indoor",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "soft window light from the side",
      "warm lamp light with cool daylight mix",
      "bright diffused natural daylight",
      "golden hour light filtering through curtains",
      "low-contrast interior lighting",
    ],
  },
  {
    imageTypeSlug: "lifestyle-indoor",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "a minimalist white-walled apartment with linen curtains",
      "a sunlit kitchen with a marble counter",
      "a modern co-working space with large windows",
      "a quiet corner of a specialty coffee shop",
      "an open-plan loft with concrete floors",
      "a library reading room with wooden shelves",
      "a designer boutique hotel lobby",
      "a home office with plants and books",
      "a restaurant bar lit by pendant lights",
      "an art gallery with neutral walls",
    ],
  },
  {
    imageTypeSlug: "lifestyle-indoor",
    personaSlug: null,
    varName: "ACTION",
    values: [
      "sitting at a table reviewing notes",
      "leaning against a counter mid-conversation",
      "stepping into frame holding a book",
      "setting down a cup of coffee",
      "adjusting a laptop screen while looking over the glasses",
      "pausing near a window",
      "hand lightly touching the frame",
    ],
  },

  // ── Lifestyle-fashion ──
  {
    imageTypeSlug: "lifestyle-fashion",
    personaSlug: null,
    varName: "SHOT_TYPE",
    values: [
      "editorial medium shot",
      "cinematic close-up",
      "full body editorial pose",
      "candid fashion moment",
      "asymmetric editorial framing",
    ],
  },
  {
    imageTypeSlug: "lifestyle-fashion",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "dramatic side light with strong shadow",
      "soft cinematic window light",
      "warm tungsten lamp with cool daylight",
      "golden hour backlight with rim glow",
      "moody low-contrast studio light",
      "natural daylight with subtle haze",
    ],
  },
  {
    imageTypeSlug: "lifestyle-fashion",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "a concrete architectural stairwell",
      "a gallery hallway with a monochrome backdrop",
      "a rooftop with the skyline behind",
      "a modern lobby with reflective surfaces",
      "a minimalist showroom with white walls",
      "an industrial warehouse with large windows",
      "a hotel corridor with textured walls",
      "a backstage dressing area with mirrors",
      "a fashion atelier with fabric rolls",
      "a subway platform with directional lighting",
    ],
  },
  {
    imageTypeSlug: "lifestyle-fashion",
    personaSlug: null,
    varName: "ACTION",
    values: [
      "turning mid-walk with hair in motion",
      "leaning against a wall with arms crossed",
      "standing with weight shifted to one side",
      "looking off-camera with a direct gaze",
      "adjusting a jacket lapel",
      "walking diagonally through the frame",
      "seated on a minimal bench with a direct expression",
    ],
  },

  // ── Studio-marble ──
  {
    imageTypeSlug: "studio-marble",
    personaSlug: null,
    varName: "SHOT_TYPE",
    values: [
      "45-degree hero",
      "top-down product",
      "macro detail",
      "3/4 dynamic angle",
    ],
  },
  {
    imageTypeSlug: "studio-marble",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "soft diffused studio light with gentle reflection",
      "directional key light with subtle fill",
      "window light with soft shadow fall-off",
      "soft overhead light with controlled highlights",
    ],
  },
  {
    imageTypeSlug: "studio-marble",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "polished white carrara marble with subtle grey veining",
      "honed grey marble with delicate veining",
      "cream travertine with natural pitting",
      "black marble with fine gold veining",
      "soft pink onyx marble with warm undertones",
    ],
  },
  {
    imageTypeSlug: "studio-marble",
    personaSlug: null,
    varName: "ACTION",
    values: [
      "resting gently at a slight angle",
      "placed open with one temple lifted",
      "leaning against a small prop shadow",
      "positioned centered with lens catching light",
    ],
  },

  // ── Studio-flatlay ──
  {
    imageTypeSlug: "studio-flatlay",
    personaSlug: null,
    varName: "SHOT_TYPE",
    values: ["top-down flatlay", "slightly angled overhead shot", "close-crop flatlay"],
  },
  {
    imageTypeSlug: "studio-flatlay",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "soft even overhead daylight",
      "directional diffused light from one side",
      "bright diffused softbox light",
      "natural window light from above",
    ],
  },
  {
    imageTypeSlug: "studio-flatlay",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "on a neutral beige linen fabric with a small notebook and pen nearby",
      "on light oak wood with a sprig of olive branch",
      "on crisp white paper with a small ceramic dish",
      "on textured sand-tone plaster with seashells",
      "on a folded cream wool blanket",
      "on a matte black tray with a small gold clip",
      "on a pastel terrazzo surface",
    ],
  },
  {
    imageTypeSlug: "studio-flatlay",
    personaSlug: null,
    varName: "ACTION",
    values: [
      "placed open with temples symmetrical",
      "at a subtle angle with one lens catching light",
      "slightly overlapping a small prop",
      "centered with open space around",
    ],
  },

  // ── UGC ──
  {
    imageTypeSlug: "ugc",
    personaSlug: null,
    varName: "AGE_RANGE",
    values: ["22-28", "25-32", "28-35", "30-38"],
  },
  {
    imageTypeSlug: "ugc",
    personaSlug: null,
    varName: "ENVIRONMENT",
    values: [
      "the driver's seat of a car with the window down",
      "a bathroom mirror with soft indoor light",
      "a bedroom mirror with natural window light",
      "an urban sidewalk in the afternoon",
      "the hallway mirror of an apartment",
      "a rideshare back seat with afternoon light",
      "a hotel room mirror",
      "a parking garage interior",
      "a convenience store aisle",
      "an elevator with bright overhead light",
      "a cafe window seat",
      "an outdoor patio with sun glare",
    ],
  },
  {
    imageTypeSlug: "ugc",
    personaSlug: null,
    varName: "LIGHTING",
    values: [
      "natural window light, slightly uneven",
      "golden hour sunlight through glass",
      "overhead fluorescent with cool tint",
      "mixed daylight and interior lamp",
      "bright overcast daylight",
      "car-interior daylight with warm reflections",
      "evening ambient light",
    ],
  },
  {
    imageTypeSlug: "ugc",
    personaSlug: null,
    varName: "ATTENTION_MOMENT",
    values: [
      "the phone tilts up quickly revealing the glasses",
      "the subject pulls the glasses down briefly then back up",
      "a sudden head tilt with a small smile",
      "the subject leans into the camera with a surprised grin",
      "a slight shoulder shrug while showing the frames",
    ],
  },

  // ── Age range pools per persona (used for lifestyle slots) ──
  {
    imageTypeSlug: null,
    personaSlug: "elevated-classic",
    varName: "AGE_RANGE",
    values: ["30-38", "32-40", "35-45", "40-50"],
  },
  {
    imageTypeSlug: null,
    personaSlug: "trendsetters",
    varName: "AGE_RANGE",
    values: ["22-28", "24-30", "26-32", "28-35"],
  },
  {
    imageTypeSlug: null,
    personaSlug: "modern-vintage",
    varName: "AGE_RANGE",
    values: ["25-32", "28-35", "30-38", "33-40"],
  },
];
