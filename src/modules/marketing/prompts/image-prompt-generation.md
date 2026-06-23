# Image Prompt Generation

> Generates Higgsfield-ready briefs for the hero + secondary images,
> given the chosen template variants. Designer uses the briefs in
> Higgsfield's web UI; we never call Higgsfield's API.

## Current version

**v3** (2026-06-23, after 3 rounds)

## The prompt

```
{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md

────────────────────────────────────────────────────────────
TASK: Write Higgsfield image briefs for this email.
────────────────────────────────────────────────────────────

Theme: {{theme.title}} — {{theme.angle}}
Hero copy: {{heroHeadline}} / {{heroSubtitle}}
Audience: {{audience}}

Selected variants:
  hero:      {{heroVariant}}            ← drives composition + safe zones
  secondary: {{secondaryImageVariant}}  ← drives count + crop

────────────────────────────────────────────────────────────
JAXY PHOTOGRAPHY AESTHETIC (lock these into every prompt)
────────────────────────────────────────────────────────────

Style: 1970s California — sun-drenched, warm, nostalgic, film-like.

Color grade: Kodak Portra / Fujifilm aesthetic. Warm saturation,
slightly faded highlights, gold/amber cast. NEVER cool, clinical,
blue-tinted, or stark-white.

Subjects + settings (rotate):
  - Vintage cars (50s-70s era) + palm trees + blue skies
  - PCH, canyons, Hollywood Hills, beach towns
  - Warm architectural tones (concrete, stucco, terracotta)
  - Golden-hour OR bright midday sun (no overcast)

Models (when present):
  - Diverse, authentic, natural beauty
  - Confident but approachable — NOT high-fashion, NOT plastic
  - Real-life settings — NOT studio-sterile
  - Eyewear is the hero of every frame featuring a model

Product photography:
  - Warm neutral surfaces: linen, concrete, sand, wood
  - Natural light, soft shadows
  - Props reinforce retro-California (no glossy gradient backdrops)

ANTI-aesthetic (NEVER produce):
  - Cold or blue lighting
  - Stark white studio backgrounds
  - Over-retouched plastic skin
  - Formal / corporate poses
  - Cluttered backgrounds that compete with the eyewear

────────────────────────────────────────────────────────────
VARIANT-SPECIFIC COMPOSITION SPECS
────────────────────────────────────────────────────────────

For HERO variant:

If heroVariant == "full_bleed_overlay":
  Dimensions: 1200 × 900 px (4:3)
  CRITICAL: top 30% (top 270px) must be visually CALM —
  pale sky, soft blur, light cream wall, water surface.
  HTML overlay text + CTA goes here. Subject of the image
  fills the bottom 70%. Recommend a scrim (dark/light/none)
  based on the calm-zone brightness.

If heroVariant == "image_75_solid":
  Dimensions: 900 × 900 px (1:1)
  Centered subject with breathing room for cream/ivory
  gutters on left + right when placed in template. Subject
  is the main draw; no overlay text on the image itself.

If heroVariant == "split_50_50":
  Dimensions: 600 × 900 px (2:3 portrait)
  Subject fills the LEFT side; right edge can fade to
  blurred bokeh OR a calm tone for HTML text overlay on
  the right half of the email block.

For SECONDARY variant:

If secondaryImageVariant == "full_bleed":
  Dimensions: 1200 × 800 px (3:2)
  Full-bleed in the email. Can be moodier than the hero —
  this is the second beat of the email's visual rhythm.

If secondaryImageVariant == "centered_75":
  Dimensions: 900 × 800 px
  Sits centered with cream gutters. Use for product flat-
  lays where you want the eye to settle.

If secondaryImageVariant == "grid_2up":
  Two images. Each: 580 × 580 px (1:1).
  Designer renders TWO. Pair them — e.g. two colorways of
  the same frame, or one product shot + one lifestyle.

────────────────────────────────────────────────────────────
SCRIM RECOMMENDATION (full_bleed_overlay only)
────────────────────────────────────────────────────────────

Recommend based on the calm zone's expected brightness:
  - bright sky / cream wall / sand → recommendedScrim: "dark"
    (dark gradient over light area = white HTML text reads)
  - dusk / forest / dark stucco → recommendedScrim: "light"
    (light gradient over dark area = dark olive HTML text reads)
  - already mid-tone or you want max image impact → "none"
    (rely on text-shadow + outline for legibility)

For other hero variants, scrim is N/A — return `null`.

────────────────────────────────────────────────────────────
SELF-CHECK BEFORE RETURNING
────────────────────────────────────────────────────────────

For each prompt:
1. Does the prompt explicitly name the lighting? ("golden
   hour," "midday California sun," "late-afternoon film
   light") — never just "natural light."
2. Does it specify the surface/setting? (linen / concrete /
   palm tree / canyon) — never just "background."
3. Does it call out the safe zone for the chosen variant?
   (top 30% calm for full_bleed_overlay, etc.)
4. Are the dimensions correct for the variant?
5. Does the alt text describe what a screen-reader user would
   need to know (not just keyword soup)?
6. Does the prompt AVOID the anti-aesthetic words above?
   (No "studio," "white background," "blue lighting," etc.)

If any fails, revise.
```

---

## Output JSON schema

```json
{
  "name": "submit_image_prompts",
  "description": "Submit Higgsfield briefs for hero + secondary",
  "input_schema": {
    "type": "object",
    "required": ["hero", "secondary"],
    "properties": {
      "hero": {
        "type": "object",
        "required": ["prompt","alt","recommendedScrim","dimensions","notes"],
        "properties": {
          "prompt":            {"type":"string","description":"Full Higgsfield prompt"},
          "alt":               {"type":"string","description":"Alt text for the image"},
          "recommendedScrim":  {"type":["string","null"],"enum":["dark","light","none",null]},
          "dimensions":        {"type":"string","description":"e.g. 1200x900"},
          "notes":             {"type":"string","description":"Designer notes — safe zone, mood, etc."}
        }
      },
      "secondary": {
        "type": "object",
        "required": ["prompts","alts","dimensions","notes"],
        "properties": {
          "prompts":     {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":2,
                          "description":"Array — length 1 normally, 2 for grid_2up"},
          "alts":        {"type":"array","items":{"type":"string"},"minItems":1,"maxItems":2},
          "dimensions":  {"type":"string"},
          "notes":       {"type":"string"}
        }
      }
    }
  }
}
```

---

## Iteration history

| v | Date | Change | Trigger |
|---|---|---|---|
| 1 | 2026-06-23 | Initial — describe the photography aesthetic + ask for prompts | Baseline |
| 2 | 2026-06-23 | Added variant-specific dimensions + the "top 30% calm" rule for full_bleed_overlay | Round 1 prompts produced beautiful images that had the subject filling the whole frame — designer's renders looked great but the HTML text overlay had nothing to sit on, killed legibility. Explicit safe-zone instructions fixed it. |
| 3 | 2026-06-23 | Added the anti-aesthetic list + the alt-text requirement + lighting-must-be-named self-check. Added the scrim recommendation logic. | Round 2 prompts said "natural light" generically — Higgsfield rendered overcast neutral scenes. Forcing explicit lighting language ("golden hour California sun," "late-afternoon film light") produced the warm look. Scrim recommendation prevents the user from having to eyeball the image to pick scrim. |

---

## Example output (v3)

Input: heroVariant=full_bleed_overlay, secondaryImageVariant=full_bleed.
Theme: Sunday Drive in Honey lands. Hero copy: "Made for the long way home."

```json
{
  "hero": {
    "prompt": "A pair of warm honey-tortoise sunglasses laid on
      a pale cream linen tablecloth. Late-afternoon golden-hour
      California sunlight casting a soft long shadow from
      upper-left. Top third of the image is the linen and a
      hint of out-of-focus terracotta wall — calm, warm, low
      detail (HTML headline + subtitle + CTA will overlay this
      area). Bottom two-thirds: the sunglasses, slightly
      off-center, with a sprig of dried lavender and a brass
      key fob as warm props. Shot on Portra 400, warm
      saturation, slight film grain, no cool tones. 1200×900.",
    "alt": "Honey-tortoise Sunday Drive sunglasses on a cream
      linen tablecloth in golden-hour light",
    "recommendedScrim": "dark",
    "dimensions": "1200x900",
    "notes": "Safe zone: top 270px must be the linen + wall
      (calm, low contrast) — HTML headline overlays here. Dark
      scrim recommended because the calm zone is bright cream;
      white text needs a soft dark gradient to read."
  },
  "secondary": {
    "prompts": [
      "Same Honey-tortoise Sunday Drive sunglasses, this time
       on a model in a soft beige linen blazer, mid-laugh,
       PCH highway visible behind her, golden hour, shot from
       slightly below to feature the eyewear. Shoulders + face
       only — frames are the hero. Kodak Portra 400 grade,
       warm faded highlights, slight grain. 1200×800."
    ],
    "alts": [
      "Woman in beige linen smiling in honey-tortoise Sunday
       Drive sunglasses, Pacific Coast Highway behind her at
       golden hour"
    ],
    "dimensions": "1200x800",
    "notes": "Secondary should turn from product-as-still-life
      (hero) to product-on-model (this) — second beat of the
      visual story. Model should look like she's mid-life, not
      posing for a campaign."
  }
}
```
