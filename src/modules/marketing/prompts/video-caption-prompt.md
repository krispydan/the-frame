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

This week's sales signals:
{{trendContext}}               ← e.g. "Honey Round: #1 by units this
                                  week, +43% WoW" (may be empty)

Active/upcoming marketing moments:
{{events}}                     ← array of {title, type, window, priority,
                                  description} (may be empty)

────────────────────────────────────────────────────────────
CAPTION RULES
────────────────────────────────────────────────────────────

- One caption used on BOTH platforms. Lead with the hook — the first
  6-8 words decide whether anyone taps "more".
- Ideal length ≤ 150 characters. Never exceed 220.
- Sound like a person, not a brand. No "Introducing…", no "Elevate
  your…", no exclamation-mark pileups.
- If a marketing moment (event) is active AND priority 1, angle the
  caption toward it. Priority 2 = mention only if natural. Priority 3
  = ignore.
- If a product is trending up, it's fine to say so in a human way
  ("everyone keeps buying the honey ones") — never quote raw stats.
- Do NOT stuff hashtags into the caption body.

HASHTAGS: 3-6, mixing 1-2 broad (#sunglasses), 2-3 niche/brand, and
1 moment tag when an event is active. Lowercase. No spam walls.

────────────────────────────────────────────────────────────
POSTING INSTRUCTIONS
────────────────────────────────────────────────────────────

Write the exact manual steps for the person posting:

- audio: If the video is silent, tell them to pick a CURRENT trending
  sound in the TikTok app and suggest the vibe (upbeat / chill /
  voiceover-friendly) based on the clip sequence. If original audio is
  kept on some clips, say which clip's audio matters and whether to
  layer a trending sound underneath at low volume.
- onScreenText: 0-3 short text overlays with timing, written to be
  typed in the TikTok/IG editor. Front-load the hook text in the first
  2 seconds. Empty array if the video speaks for itself.
- tagProducts: which products to tag / link-in-bio references.
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
    "audio": "string",
    "onScreenText": [{ "text": "string", "timing": "string", "placement": "string" }],
    "tagProducts": ["string"],
    "coverSuggestion": "string",
    "firstComment": "string (optional)"
  }
}
```
