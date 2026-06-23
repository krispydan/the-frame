# Theme Generation Prompt

> Generates N weekly themes for an audience over a period. Themes
> are the SEED — each becomes the input to copy-generation. Good
> themes = good campaigns. Bad themes (generic, off-brand, repeats)
> mean every downstream prompt has to compensate.

## Current version

**v3** (2026-06-23, after 3 rounds)

## The prompt

```
{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md

────────────────────────────────────────────────────────────
TASK: Generate {{count}} weekly email themes for Jaxy.
────────────────────────────────────────────────────────────

Audience: {{audience}}        ← retail | wholesale
Week start (Monday ISO): {{weekStart}}
Number of weeks: {{count}}    ← usually 4

Recent campaigns to AVOID repeating (last 6 sent to this audience):
{{recentCampaigns}}            ← array of {weekOf, theme, productHook}

Product context (current line + new arrivals):
{{productContext}}             ← optional — pulled from catalog

────────────────────────────────────────────────────────────
WHAT MAKES A GOOD THEME
────────────────────────────────────────────────────────────

A theme is NOT a subject line. It's an angle the writer can build
an email around. Three components:

1. **The hook** — what specifically is happening this week? A new
   product, a season pivot, a customer moment, a Faire promo, a
   restock, a sold-out warning, a quiet "just checking in."

2. **The angle** — why this hook NOW, for this audience. The
   reason it matters this week, not last week or next.

3. **The visual potential** — does it suggest a hero image that
   our designer can render in Higgsfield? "New colorway" suggests
   a flat lay. "First cool morning" suggests a moody outdoor
   lifestyle shot. "Faire promo" suggests a screen-recording-style
   product montage.

GOOD examples:
  ✓ "Sunday Drive in Honey lands" — specific product, specific
    colorway, hook is the arrival, visual is the frame on a
    warm-light table.
  ✓ "It's coffee-on-the-porch weather" — seasonal sensation,
    visual is moody late-summer/early-fall lighting.
  ✓ "Sara's Main Character moment" — UGC repost angle, visual
    is the customer photo.

BAD examples (avoid these patterns):
  ✗ "New arrivals" — too generic, no specific product, no angle.
  ✗ "Summer styles" — what specifically? When in summer? Which
    styles?
  ✗ "Don't miss our sale" — banned subject pattern + zero angle.

────────────────────────────────────────────────────────────
SOFT VARIATION RULES (across the {{count}} themes you generate)
────────────────────────────────────────────────────────────

Across the batch you produce, vary the SHAPE of the themes so the
recipient gets variety week-to-week:

If generating 4 themes for ONE audience, aim for roughly:
  - 1-2 product-anchored themes (new launch, restock, colorway)
  - 1 cultural/seasonal theme (a moment, a sensation, a holiday)
  - 1 audience-relationship theme (UGC repost, founder note,
    behind-the-scenes; wholesale: rep check-in, market update,
    a "what's selling at stores like yours")

Don't put two restock themes consecutively. Don't make three of
four themes seasonal — recipients clock the pattern.

(Wholesale-specific) Don't make every theme about a new drop.
Christina checks in, asks for feedback, shares sell-through data,
sends a Faire promo. Variety = "feels like a person sending these,"
sameness = "feels like an automated calendar."

────────────────────────────────────────────────────────────
SELF-CHECK BEFORE RETURNING
────────────────────────────────────────────────────────────

For each theme:
1. Is the hook SPECIFIC enough to write a unique email around?
   (Theme "new arrivals" fails. Theme "Sunday Drive in Honey
   lands, three colorways" passes.)
2. Does it repeat anything from {{recentCampaigns}}?
3. Does the angle answer "why THIS week"?
4. Could the designer translate this into a Higgsfield prompt?

For the batch:
5. Is there shape variety across the {{count}} themes? See the
   rules above.
6. Could a buyer/customer skim these {{count}} subject-line stubs
   and immediately tell each is a different week's email?

If any fails, revise that theme before returning.
```

---

## Output JSON schema

```json
{
  "name": "submit_themes",
  "description": "Submit {count} email themes for the period",
  "input_schema": {
    "type": "object",
    "required": ["themes"],
    "properties": {
      "themes": {
        "type": "array",
        "minItems": 1,
        "items": {
          "type": "object",
          "required": ["weekOf", "title", "angle", "productHook",
                       "seasonalContext", "visualSuggestion", "themeShape"],
          "properties": {
            "weekOf":           {"type":"string","description":"ISO Monday"},
            "title":            {"type":"string","description":"3–8 word theme name"},
            "angle":            {"type":"string","description":"Why this hook now"},
            "productHook":      {"type":"string","description":"SKU/category or null"},
            "seasonalContext":  {"type":"string","description":"Cultural/seasonal anchor or null"},
            "visualSuggestion": {"type":"string","description":"What the designer should aim for"},
            "themeShape":       {"type":"string","enum":["product_anchored","cultural_seasonal","audience_relationship"]}
          }
        }
      }
    }
  }
}
```

The `themeShape` enum is the soft-variation enforcement — if the
model returns 4 themes with the same shape, the application can
warn ("3 of 4 themes are product_anchored; consider asking the
model to add variety").

---

## Iteration history

| v | Date | Change | Trigger |
|---|---|---|---|
| 1 | 2026-06-23 | Initial draft — just "generate themes" with brand context | Baseline |
| 2 | 2026-06-23 | Added the "three components" framework (hook + angle + visual potential) and the good/bad examples list | Round 1 outputs were single-word themes ("Summer," "New," "Sale") that gave the copy prompt nothing to anchor. Forcing 3 components per theme + named examples produced concrete angles like "Sunday Drive in Honey lands." |
| 3 | 2026-06-23 | Added shape variety rules + the `themeShape` enum field + the cross-batch self-check question. Wholesale-specific: don't make every theme a new drop. | Round 2 retail outputs were all seasonal ("Late summer," "Pre-fall," "First cool morning," "Last weekends of summer" — 4 themes, all weather). Wholesale outputs were all stock drops. Both batches felt monotonous. The shape variety rule mandates a mix. |

---

## Example output (v3, 4 themes for retail, week of 2026-06-29)

```json
{
  "themes": [
    {
      "weekOf": "2026-06-29",
      "title": "Sunday Drive in Honey lands",
      "angle": "First time we've offered this colorway. The
        warmest tortoise we've ever produced — sits between
        amber and caramel. Hook is the arrival; angle is
        'the color you've been waiting for.'",
      "productHook": "Sunday Drive (Honey colorway)",
      "seasonalContext": "Late June — warm-acetate season",
      "visualSuggestion": "Honey colorway on a warm linen
        surface with golden-hour sidelight; second image is
        on-model in late-afternoon light",
      "themeShape": "product_anchored"
    },
    {
      "weekOf": "2026-07-06",
      "title": "Sara's Main Character moment",
      "angle": "Repost Sara's poolside Main Character photo
        with her permission. Customer-as-hero — the best
        compliment isn't 'where did you get those,' it's
        'those are SO you.' Angle is the proof that the
        line works on real faces, not just models.",
      "productHook": "Main Character (Tortoise)",
      "seasonalContext": "Early July — pool / 4th of July
        weekend energy",
      "visualSuggestion": "Sara's photo itself as the hero
        (already shot). Secondary image is the Main Character
        product on cream",
      "themeShape": "audience_relationship"
    },
    {
      "weekOf": "2026-07-13",
      "title": "It's coffee-on-the-porch weather",
      "angle": "First weekend it actually feels different —
        the in-between season between summer and fall.
        Specific sensation hook. Frames for the pivot.",
      "productHook": "Transition collection (5 frames)",
      "seasonalContext": "Mid-July East Coast cool snap /
        the morning that signals the turn",
      "visualSuggestion": "Moody outdoor lifestyle — porch,
        coffee, soft golden light. Secondary is product on
        a knit blanket.",
      "themeShape": "cultural_seasonal"
    },
    {
      "weekOf": "2026-07-20",
      "title": "the Honey came back",
      "angle": "Restock of the Honey colorway (the one that
        sold out in 12 days). Quiet, short email — three of
        you have been waiting, here it is. Texts-from-a-friend
        register.",
      "productHook": "Sunday Drive Honey (restock)",
      "seasonalContext": "Mid-July",
      "visualSuggestion": "Single product shot on warm
        surface, low styling — the 'it's back' email earns
        a quiet visual",
      "themeShape": "product_anchored"
    }
  ]
}
```

Note: 4 themes, 3 shapes represented (2 product-anchored + 1
audience-relationship + 1 cultural-seasonal). Variety check passes.
No two consecutive product-anchored themes — Sara's UGC and the
"coffee-on-the-porch" theme separate the two product-anchored
weeks. Recipient skimming subject lines week-to-week sees:
launch → customer story → seasonal → restock. That's a rhythm.
