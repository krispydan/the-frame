# Video Caption + Posting Instructions Prompt

> Writes the caption, hashtags, and manual posting checklist for one
> generated TikTok/Instagram video (Video Remix Studio). The video is
> already rendered — this prompt turns "a sequence of clips + business
> context" into everything the person posting needs: what to paste,
> which audio move to make, what on-screen text to type, what to tag.

## Current version

**v1** (2026-07-07, initial)

## The prompt

```
{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md

────────────────────────────────────────────────────────────
TASK: Write the caption + posting instructions for one short
vertical video (TikTok + Instagram Reels).
────────────────────────────────────────────────────────────

Scheduled for: {{scheduledFor}}
Video style: {{recipeName}} — {{recipeDescription}}
Total duration: {{durationSec}}s
Audio state: {{audioState}}   ← "silent" (trending audio will be added
                                in the TikTok app), "partial" (some
                                clips keep original audio), or "full"

The clip sequence (in order):
{{clipSequence}}               ← array of {position, category, durationSec,
                                  products: [{name, color, sku}]}

Featured products (the video's focus):
{{focusProducts}}              ← array of {name, color, sku, price, url}

ALL products visible in the video (tag every one for TikTok Shop):
{{productsInVideo}}            ← array of {name, color, sku}

This week's sales signals:
{{trendContext}}               ← e.g. "Honey Round: #1 by units this
                                  week, +43% WoW" (may be empty)

Active/upcoming marketing moments:
{{events}}                     ← array of {title, type, window, priority,
                                  description} (may be empty)

Music:
{{trendingSounds}}             ← the team picks tracks by hand, so never
                                  name a specific song or artist

────────────────────────────────────────────────────────────
CAPTION RULES
────────────────────────────────────────────────────────────

- One caption used on BOTH platforms. Lead with the hook — the first
  6-8 words decide whether anyone taps "more". The caption's opening
  should echo the `hook` (below), not contradict it.
- Ideal length ≤ 150 characters. Never exceed 220.
- Sound like a person, not a brand. No "Introducing…", no "Elevate
  your…", no exclamation-mark pileups.
- If a marketing moment (event) is active AND priority 1, angle the
  caption toward it. Priority 2 = mention only if natural. Priority 3
  = ignore.
- If a product is trending up, it's fine to say so in a human way
  ("everyone keeps buying the honey ones") — never quote raw stats.
- PRODUCT ACCURACY (important): only ever name/reference a product that
  appears in "Featured products" or "ALL products visible in the video".
  Every product-bearing clip in this video features a focus product; the
  rest are product-free b-roll. If a specific frame IS featured, center
  the caption on THAT pair by name/vibe. NEVER reference a pair of glasses
  that isn't in those lists — the clips won't show it and the caption will
  contradict the video.
- Do NOT stuff hashtags into the caption body.

HASHTAGS: 3-6, mixing 1-2 broad (#sunglasses), 2-3 niche/brand, and
1 moment tag when an event is active. Lowercase. No spam walls.

────────────────────────────────────────────────────────────
POSTING INSTRUCTIONS
────────────────────────────────────────────────────────────

Write the exact manual steps for the person posting:

- hook: The scroll-stopping first line, delivered in the first 0–2
  seconds — this is the single biggest driver of whether the video gets
  distributed. Write it in ONE of the trending HOOK FORMULAS (see the
  VIDEO STRATEGY section above), adapted to the AUDIENCE and chosen
  PILLAR — rotate formulas across videos, don't reuse the same one.
  Specific beats broad. Keep it ≤ ~60 characters so it fits on screen.
  It will be BURNED onto the video as on-screen text, so it must stand
  alone without the caption.
- pillar: name the content pillar this video sits in (from the pillars
  list). Pick the one the clips actually support.
- scriptBeats: optional 3-beat spine [hook, value, payoff/CTA] — the
  retention arc. Use it to inform the on-screen text below.
- audio: NEVER name a specific song, artist or sound. Whether a track is
  cleared for commercial use is a decision only a person can make, and
  naming one invites someone to use music we have no licence for.
  Describe the VIBE to look for instead — tempo, energy, and whether it
  needs to be voiceover-friendly (e.g. "upbeat, punchy, something with a
  drop around 2s"). If original audio is kept on some clips, say which
  clip's audio matters and whether to layer music under it at low volume.
- onScreenText: 0-3 short text overlays with timing, written to be
  typed in the TikTok/IG editor. Front-load the hook text in the first
  2 seconds. Empty array if the video speaks for itself.
- tagProducts: list EVERY product from "ALL products visible in the
  video" (name + color) so the poster tags each one in TikTok Shop.
  These are the shoppable product tags, not just link-in-bio — if a
  product appears on screen, it should be taggable. Empty only when no
  products are tagged on the clips.
- coverSuggestion: which moment makes the best cover frame.
- firstComment: optional — a first comment that adds context or a CTA
  (link in bio, sizing note). Omit if it would add nothing.

Self-check before submitting:
1. Would a stranger stop scrolling for this caption?
2. Zero banned words / salesy clichés?
3. Hashtags 3-6, no duplicates of the caption text?
4. Instructions executable by someone who did NOT make the video?
```

## Output schema

Forced tool call `submit_video_copy`:

```json
{
  "caption": "string",
  "hashtags": ["string"],
  "postingInstructions": {
    "hook": "string — scroll-stopping first line, ≤60 chars, burned on-screen",
    "pillar": "string — the content pillar this video sits in",
    "scriptBeats": ["hook", "value", "payoff/CTA (optional, max 3)"],
    "audio": "string",
    "onScreenText": [{ "text": "string", "timing": "string", "placement": "string" }],
    "tagProducts": ["string"],
    "coverSuggestion": "string",
    "firstComment": "string (optional)"
  }
}
```
