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

TikTok trending sounds RIGHT NOW (synced from TikTok's charts):
{{trendingSounds}}             ← array of {id, title, author, chart:
                                  "breakout"|"popular", rank, trend,
                                  durationSec} (may be empty)

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

- audio: If the video is silent AND trendingSounds is non-empty, pick
  the 2-3 sounds that best fit this video's pacing and vibe and return
  their ids in suggestedSoundIds (best fit first). Prefer "breakout"
  chart and trend "up"/"new" — riding a sound on its way up beats one
  already saturated. In the audio text, name your top pick naturally
  ("Use 'song title' by author — it's breaking out right now").
  If trendingSounds is empty, describe the vibe to look for instead
  (upbeat / chill / voiceover-friendly) and leave suggestedSoundIds [].
  If original audio is kept on some clips, say which clip's audio
  matters and whether to layer a trending sound underneath at low
  volume; suggestedSoundIds may still carry one low-volume option.
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
    "audio": "string",
    "suggestedSoundIds": ["id from trendingSounds, max 3, best first"],
    "onScreenText": [{ "text": "string", "timing": "string", "placement": "string" }],
    "tagProducts": ["string"],
    "coverSuggestion": "string",
    "firstComment": "string (optional)"
  }
}
```
