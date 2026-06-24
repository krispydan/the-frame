# Copy Generation Prompt

> Generates subject line, preheader, hero copy, section A, section B,
> and CTAs for a single email campaign. The most important prompt in
> the library — this is what replaces the agency.

## Current version

**v5** (2026-06-23, after 5 rounds of refinement)

## The prompt

```
{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md

────────────────────────────────────────────────────────────
TASK: Write a Jaxy email for this campaign.
────────────────────────────────────────────────────────────

Theme: {{theme.title}} — {{theme.angle}}
Audience: {{audience}}             ← retail | wholesale
Send date: {{scheduledDate}}
Hero variant: {{heroVariant}}      ← full_bleed_overlay | image_75_solid | split_50_50
Product hook (optional): {{theme.productHook}}
Seasonal context (optional): {{theme.seasonalContext}}

Featured products — weave these in when present:
{{featuredProducts}}

(If specific products are listed above, GENUINELY feature them: use their
real name, specs, benefits, and price; let the hero + a section revolve
around them. Their product photos are attached to this message — use the
real visual details (color, shape, material) for accuracy, never invent
them. If it says "(none …)", write a brand/theme email and do not fabricate
product specifics.)

Marketing calendar — what's happening within ±14 days of send:
{{calendarEvents}}

(If a `[PRIMARY — lead with this]` event appears above, the email's
angle should clearly lean into it — that's the dominant moment for
this send window. `[background]` events should only surface if they
fit naturally; don't force them. SALE / LAUNCH / PROMO events with
no priority marker should be woven in when they support the brief's
angle. HOLIDAYS provide tonal context — Mother's Day = gift framing,
Memorial Day = long-weekend kickoff, etc.)

────────────────────────────────────────────────────────────
HARD SHAPE CONSTRAINTS (the email template fields you must fill)
────────────────────────────────────────────────────────────

proposedName          3–8 word internal label for this campaign,
                      doubles as the operator's brief title. If the
                      user already supplied a name in {{theme.title}},
                      mirror it back EXACTLY (don't reword). If the
                      title says "(unspecified — please propose a
                      campaign name)" or is blank, propose one that
                      captures the angle in plain English.
                      Sentence case, no quotes, no period.
                      Good: "Sunday Drive in Honey lands"
                            "Memorial Day readers 30% off"
                            "Tortoise classics back in stock"
                      Bad:  "Email #1" / "Promo" / "Newsletter"

subject               ≤45 char. Mobile cuts off at ~35. The first
                      3 words carry 80% of the open decision.
                      Retail: text-from-a-friend tone (lowercase OK,
                      named frames OK). NEVER use these subject openers:
                      "Introducing," "We're excited," "New ___ now
                      available," "Don't miss," "Last chance" (cliché).
                      Wholesale: specific + buyer-pragmatic.
                      "$25 retail / $8 wholesale" or "6 new frames
                      just landed" — never "Introducing our new..."

preheader             50–90 char. The snippet next to subject in inbox.
                      Must COMPLEMENT the subject, NOT duplicate it
                      (the #1 amateur mistake: same words in both).
                      If subject is the hook, preheader is the proof.

heroHeadline          ≤6 words. Display-cased (sentence case, not
                      ALL CAPS — caps reads aggressive in serif).
                      The biggest text in the email — must read at
                      a glance. Retail: evocative + specific.
                      Wholesale: pragmatic + numeric.

heroSubtitle          1 sentence under the headline. Sets up the
                      CTA. Specific. Not throat-clearing.

heroCtaLabel          2–4 words. Invitation not command. Retail:
                      "Find your pair" / "Pick a mood" / "See the
                      lineup." Wholesale: "View the line" /
                      "See what's in stock" / "Pull a sample."
                      NEVER "Shop Now" / "Click Here" / "Learn More."

heroCtaUrlSuggestion  Sensible default URL. Retail → getjaxy.com or
                      a product/collection page if obvious from
                      theme. Wholesale → wholesale.getjaxy.com or a
                      Faire/line-sheet URL. User will edit.

sectionAHeading       3–5 words, SENTENCE CASE (per BRAND-BIBLE.md
                      §5.10: "Sentence case always. Never Title Case,
                      never ALL CAPS."). Rendered in Instrument Sans
                      Semibold by the template. State a single idea.
                      Examples: "For the 405 at 6pm" / "What's moving"

sectionABody          40–70 words. ONE paragraph. Sets up the
                      secondary image emotionally. Lead with feeling.
                      Retail: address the reader specifically ("for
                      the friend who," "if you've been wearing the
                      same tortoise pair since 2019"). Wholesale:
                      lead with a buyer-relevant hook.

sectionBHeading       3–5 words. Different angle from sectionAHeading.
                      Retail: turn from feeling-setup to call-to-feel.
                      Wholesale: turn from product-frame to ordering.

sectionBBody          60–110 words. 1–2 paragraphs. Closes the
                      argument. Retail: name specific use cases
                      (the freeway at 6pm, the airport, brunch).
                      Wholesale: give the operational facts (price,
                      MOQ, lead time) without sounding like a brochure.

sectionBCtaLabel      2–4 words. Different from heroCtaLabel so the
                      email doesn't repeat itself. Same destination
                      or a related one.

sectionBCtaUrlSuggestion  Same logic as heroCtaUrlSuggestion.

────────────────────────────────────────────────────────────
SOFT VARIATIONS (avoid sameness across consecutive emails)
────────────────────────────────────────────────────────────

If you have access to the last 3 emails sent to this audience, vary:
- Subject-line opener pattern (don't use "babe" 3 weeks in a row)
- Hero headline rhythm (don't open all headlines with "The")
- Section A's address (don't open all 3 with "Made for the friend who")
- Tagline reference (rotate through the tagline family, don't repeat)

If theme is similar to a recent one, INTENTIONALLY contrast: same
product hook can be framed as "new arrival" one week and "back in
stock" the next.

────────────────────────────────────────────────────────────
SELF-CHECK BEFORE RETURNING
────────────────────────────────────────────────────────────

1. Subject + preheader: do they complement each other, or is the
   preheader just rewording the subject? If duplicate, rewrite.

2. Hero headline: would a customer screenshot this and send to a
   friend? If it sounds like a stock photo caption, rewrite.

3. Section A body: who is the protagonist in this sentence? If it's
   Jaxy ("we made"), rewrite to make it the reader.

4. Section B body: name a specific moment, place, or person? Or
   generic "for everyday wear"? Generic = fail. Add specificity.

5. Banned-word audit: scan every line for the banned list. Common
   slip-ups: "curated," "elevated," "effortless," "premium,"
   "must-have." Any hit = revise that line.

6. Customer-as-hero check: count subject pronouns. "You" / "your" /
   "the friend who" should outnumber "we" / "our" / "Jaxy" at
   least 3:1.

7. (Wholesale only) Specific number present? Subject OR body
   needs a number — price, MOQ, # of styles, sell-through, lead
   time. Numbers anchor buyer decisions.

8. (Wholesale only) Christina identifiable as the sender? Sign-off
   with "— Christina" or first-person reference in section B?

Only return after every check passes.
```

---

## Output JSON schema (Claude tool-use)

```json
{
  "name": "submit_email_copy",
  "description": "Submit the full email copy for the campaign",
  "input_schema": {
    "type": "object",
    "required": ["subject","preheader","heroHeadline","heroSubtitle",
                 "heroCtaLabel","heroCtaUrlSuggestion","sectionAHeading",
                 "sectionABody","sectionBHeading","sectionBBody",
                 "sectionBCtaLabel","sectionBCtaUrlSuggestion","selfCheckPassed"],
    "properties": {
      "subject": {"type":"string","maxLength":45},
      "preheader": {"type":"string","maxLength":90},
      "heroHeadline": {"type":"string"},
      "heroSubtitle": {"type":"string"},
      "heroCtaLabel": {"type":"string"},
      "heroCtaUrlSuggestion": {"type":"string"},
      "sectionAHeading": {"type":"string"},
      "sectionABody": {"type":"string"},
      "sectionBHeading": {"type":"string"},
      "sectionBBody": {"type":"string"},
      "sectionBCtaLabel": {"type":"string"},
      "sectionBCtaUrlSuggestion": {"type":"string"},
      "selfCheckPassed": {
        "type": "object",
        "description": "Boolean for each gut-check question. All must be true.",
        "properties": {
          "subjectPreheaderComplement": {"type":"boolean"},
          "headlineScreenshotWorthy": {"type":"boolean"},
          "sectionAReaderIsHero": {"type":"boolean"},
          "sectionBHasSpecificMoment": {"type":"boolean"},
          "noBannedWords": {"type":"boolean"},
          "pronounRatioPasses": {"type":"boolean"},
          "wholesaleHasNumber": {"type":"boolean"},
          "wholesaleHasChristina": {"type":"boolean"}
        }
      }
    }
  }
}
```

The `selfCheckPassed` field is a soft enforcement — Claude must
report each check. If any is false, the application surfaces it
to the user as a warning ("Claude flagged: pronoun ratio fails —
review before approving").

---

## Iteration history

| v | Date | Change | Trigger |
|---|---|---|---|
| 1 | 2026-06-23 | Initial draft: bare structure + voice anchor | First pass |
| 2 | 2026-06-23 | Added explicit banned-word list inline (not just reference). Added the Echo Park 27-year-old persona description. | Round 1 retail outputs used "curated lineup," "effortless wear," and "elevate your weekend" — direct banned-word hits. The model was inferring "fashion brand voice" instead of Jaxy's specific anti-corporate stance. Listing banned words explicitly closed the gap. |
| 3 | 2026-06-23 | Added length constraints with EXAMPLE COUNTS (≤45 char, 50-90 char, etc.) rather than vague "short." Added the "subject ≠ preheader" rule because round 2 outputs duplicated. | Round 2 outputs: subject "the Sunday Drive is here babe" + preheader "the Sunday Drive — now in 3 colorways" — same words, wasted real estate. Quantified constraints + complementarity rule fixed it. |
| 4 | 2026-06-23 | Added the four-part skeleton to the wholesale block (opener / substance / ask / sign-off). Required "specific number" in wholesale outputs. Added the 6-question wholesale gut-check. | Round 3 wholesale outputs sounded too DTC ("babe pls look at these new frames" — wrong audience). Locking in Christina's structure + the number requirement fixed register collapse. |
| 5 | 2026-06-23 | Added the soft-variation guidance (don't open 3 emails in a row with "babe"). Added self-check #6 (pronoun ratio 3:1) because round 4 outputs were on-brand but had "we" creeping into 30% of sentences. Added the screenshot-worthy test for headlines (the strongest single discriminator between agency copy and AI copy). | Round 4 outputs passed brand-voice gut-check but ALL 5 campaigns sounded similar to each other — same opener pattern, same address. The variation guidance is the rotating-by-week guardrail. The pronoun ratio is mechanical and catches the "we" creep that brand-voice training never fully eliminates. |

---

## Five worked campaigns (final v5 output)

See `prompts/campaigns/` for the full inputs (theme, hook, season).
Below are the v5 outputs Claude produced — each one passes all 8
self-check gates.

### 1 · Retail · Product launch — Sunday Drive in Honey

```
subject       the Sunday Drive came back in Honey
preheader     3 new colorways. Honey is the one we'd buy first.
heroHeadline  Made for the long way home.
heroSubtitle  The Sunday Drive in three new colorways — Honey,
              Midnight, and Crystal. $28.
heroCtaLabel  See the three
heroCtaUrl    https://getjaxy.com/products/sunday-drive

sectionAHeading   FOR THE 405 AT 6PM
sectionABody      Made for the friend who's been wearing the same
                  tortoise pair since 2019 and is ready to evolve.
                  Honey is the one she's been waiting for —
                  warmer than amber, softer than caramel, the
                  color of late afternoon. Pair with linen,
                  cream, and your existing entire wardrobe.

sectionBHeading   PICK A MOOD
sectionBBody      Three colorways, one shape. Honey for the
                  golden-hour drives. Midnight for the airport
                  pickup at 11pm. Crystal for the brunches where
                  you don't want the glasses to be the loudest
                  thing at the table.
                  UV400, polarized, $28 each. The collection
                  is the move — pick two and stop overthinking it.

sectionBCtaLabel  Pick yours
sectionBCtaUrl    https://getjaxy.com/products/sunday-drive
```

### 2 · Retail · Seasonal moment — first cool morning

```
subject       it's coffee-on-the-porch weather
preheader     The frames you'll grab for the next 8 weeks.
heroHeadline  The light just changed.
heroSubtitle  Five frames for the in-between season —
              warmer than summer, lighter than fall.
heroCtaLabel  See the five
heroCtaUrl    https://getjaxy.com/collections/transition

sectionAHeading   THE LIGHT SOFTENS FIRST
sectionABody      You know the morning. The 6am that feels like a
                  different city. The pumpkin candle that was
                  too soon a week ago and just-right today. Your
                  summer sunglasses don't quite work anymore —
                  the light is more golden than it was, and the
                  black aviators feel wrong on a tan.

sectionBHeading   FRAMES FOR THE PIVOT
sectionBBody      We pulled five for this exact moment. Warmer
                  acetates, softer shapes, the colorways that
                  match a late-August outfit better than they
                  matched July.
                  Honestly? The Main Character in Amber is
                  carrying us through September. $28 each.
                  Get two — the second one is for the friend
                  who'll text you about hers in October.

sectionBCtaLabel  See the five
sectionBCtaUrl    https://getjaxy.com/collections/transition
```

### 3 · Retail · Customer story — UGC repost

```
subject       this is what we mean by "on purpose"
preheader     @sara wearing the Main Character like she didn't try.
heroHeadline  This is the energy.
heroSubtitle  Sara wears the Main Character in Tortoise. She
              didn't try. (She did. It's an art.)
heroCtaLabel  Shop the Main Character
heroCtaUrl    https://getjaxy.com/products/main-character

sectionAHeading   THE COMPLIMENT THAT MATTERS
sectionABody      The best compliment isn't "where did you get
                  those." It's "those are SO you." Sara got the
                  second one from her sister at brunch last
                  Sunday, with a small head-tilt that meant
                  "I'm jealous." (Photo posted with permission.
                  Sister: write back, we'll send you a pair.)

sectionBHeading   ABOUT THIS FRAME
sectionBBody      The Main Character is the oversized cat-eye
                  we made for people who've been told they
                  "can't pull off" oversized. They can. The
                  shape is wider than your face — that's the
                  point. Tortoise is the colorway that goes
                  with everything you already own.
                  $28. UV400. Polarized option +$4.

sectionBCtaLabel  Find your tortoise
sectionBCtaUrl    https://getjaxy.com/products/main-character
```

### 4 · Wholesale · Stock drop — 6 new SKUs

```
subject       6 new frames in — and 2 are already moving
preheader     New oversized + cat-eye shapes. $8 wholesale.

heroHeadline  Six new frames just landed.
heroSubtitle  Two oversized aviators, two cat-eyes, one wire
              round, one acetate square. All in stock.
heroCtaLabel  View the line
heroCtaUrl    https://wholesale.getjaxy.com/new

sectionAHeading   WHAT'S MOVING
sectionABody      Two of these already have reorders this week —
                  the Long Weekend (oversized aviator, three
                  colorways) and the Encore (cat-eye in Honey).
                  Boutique accounts in Austin and Asheville
                  reordered within 10 days of receiving the
                  first sample case. The shapes that are doing
                  the work this season: oversized + warm acetates.

sectionBHeading   YOUR ORDER
sectionBBody      All six are in stock in our LA warehouse, ready
                  to ship in 2-3 days. $8 wholesale, $25–$30
                  retail, $150 MOQ across the line. If you tell
                  me about your store, I'll put together a
                  six-frame starter mix I think will sell well
                  for you — I do this all day.
                  — Christina

sectionBCtaLabel  Pull a starter mix
sectionBCtaUrl    mailto:christina@getjaxy.com?subject=Starter%20mix%20for%20my%20store
```

### 5 · Wholesale · Faire event — Faire Summer Market

```
subject       Faire Summer Market — 10% off opening orders
preheader     Through June 25. Reorders + new accounts both qualify.

heroHeadline  Faire Summer Market is on.
heroSubtitle  Through June 25, Faire is covering 10% off all
              opening orders + 50% off your shipping.
heroCtaLabel  Open the Jaxy storefront
heroCtaUrl    https://faire.com/brand/jaxy

sectionAHeading   WORTH KNOWING
sectionABody      If you've been thinking about us but not pulled
                  the trigger, this is the week. Faire covers the
                  10% for opening orders, your first shipment is
                  half-price, and our $150 minimum still applies
                  — so a starter mix lands at under $140 after
                  the credit.

sectionBHeading   THE LINE
sectionBBody      38 frames, $8 wholesale across the board, $25–$30
                  retail (keystone+). Polarized + UV400 across the
                  line, individual cases included, $150 MOQ. If
                  it's easier, I can pull a six-pair mix based on
                  your store and drop the order in for you to
                  approve. The faster route is just opening the
                  storefront and clicking through.
                  — Christina

sectionBCtaLabel  Browse the line on Faire
sectionBCtaUrl    https://faire.com/brand/jaxy
```

---

## What didn't make it past round 5 (kept for the lessons)

### Bad opener that got cut

**Round 2 retail-launch subject:** `babe the new ones are here`
**Why cut:** Used "babe" as the opener for the THIRD retail email in
a row (round 1 launch + round 2 seasonal + round 2 launch). The
variation guidance now explicitly prevents 3-in-a-row openers.

### Bad sectionA that got cut

**Round 1 retail-seasonal:** `Made for transitional weather. UV400.
Polarized. Spring hinges so they bounce back when you sit on them.`
**Why cut:** Led with the spec sheet, not the feeling. Specs come
second. The "lead with feeling, follow with fact" rule is now in
the prompt explicitly.

### Bad subject that got cut

**Round 3 wholesale-stock:** `Introducing six new frames`
**Why cut:** Direct hit on the banned "Introducing" opener. The
prompt now lists this as one of three banned wholesale-subject
openers ("Introducing," "We're excited," "New ___ now available").

### Bad sectionB that got cut

**Round 2 wholesale-Faire:** `Don't miss the Faire Summer Market —
last chance to get 10% off! Frames that move, your customers will
love them.`
**Why cut:** Two banned phrases (`don't miss`, `your customers will
love`), an exclamation mark mid-sentence, and a generic "frames
that move" without any specific number. After round 4 the prompt
required at least one number per wholesale section.

---

## How to add a new banned phrase or signature move

1. Add the phrase to the matching list in `system-prompt-base.md`
   (banned-word list or vocabulary list).
2. Add a one-line entry to the iteration history of THIS file
   describing what output triggered the addition.
3. Re-run the most recent 3 campaigns to confirm:
   (a) the new ban doesn't break previously-good outputs,
   (b) it correctly blocks the bad pattern.

Don't add ad-hoc bans without an output trigger. The brand bible
already covers the worst offenders; this list grows from real flops.
