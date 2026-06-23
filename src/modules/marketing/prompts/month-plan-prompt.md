# Monthly campaign planner prompt — v1 (2026-06-23)

Purpose: given an audience, a date range, and the marketing
calendar for that window, propose **a unique brief per email
slot** that the operator can then accept (or refine) into
real campaigns.

This is upstream of `copy-generation-prompt.md` (v5). That prompt
takes a single brief and writes the email. THIS prompt produces
the briefs.

Inputs the AI sees (filled by the planner before dispatch):
- `audience` — retail | wholesale
- `startDate` / `endDate` — the planning window (ISO YYYY-MM-DD)
- `cadence` — "Mon + Thu" (retail) or "Tue + Fri" (wholesale)
- `slots[]` — array of `{date, slotInWeek, layoutProfile,
   imageStyle, subjectAngle}` from the strategy engine. Length =
   2 × number-of-weeks-in-window
- `calendarEvents` — pre-formatted block of holidays / sales /
   launches / promos in this window

Output: a single tool call with `briefs[]` matching `slots[]`
1:1 in order (so we can zip them).

────────────────────────────────────────────────────────────
TASK: Plan the email calendar.
────────────────────────────────────────────────────────────

Window: {{startDate}} → {{endDate}}
Audience: {{audience}}
Cadence: {{cadence}}
Slots to plan: {{slotCount}}

Marketing calendar — what's happening in this window:
{{calendarEvents}}

Slots (from the strategy engine — each row has its layout +
image-style + subject-angle pre-assigned for variety):
{{slotsTable}}

────────────────────────────────────────────────────────────
HARD CONSTRAINTS
────────────────────────────────────────────────────────────

1. **One brief per slot, in the same order as `slots[]`.**
   The number of returned briefs MUST equal {{slotCount}}.

2. **Lean into PRIMARY calendar events.** If a calendar event
   marked `[PRIMARY — lead with this]` falls within ±5 days of
   a slot's date, that slot's brief MUST orient around it.
   Don't fight the calendar.

3. **No two slots share the same brief angle.** Even if they
   anchor to the same event (e.g. a 3-day BFCM window with 2
   slots inside it), each slot's brief approaches from a
   different angle. Examples for the same Memorial Day weekend:
     Slot A: "30% off + the long-weekend road-trip framing"
     Slot B: "Last-chance reminder, but lead with the customer
              story — 'pulled these in at the cabin'"
   Don't repeat.

4. **Match the assigned slot dimensions.** Each slot has a
   layoutProfile (editorial / product-catalog / split / UGC),
   imageStyle (product flat-lay / on-model lifestyle / detail
   macro / paired 2-up), and subjectAngle (product-focused /
   lifestyle-sensation / curiosity-hook / social-proof /
   practical-value). The brief should flow naturally to those
   dimensions — don't propose a "story-led narrative" brief for
   a slot with `subjectAngle = practical-value`.

5. **Audience voice.**
   - Retail: customer-as-self. Brief speaks to "your day," "your
     moment," "your colorway." Casual, text-from-a-friend tone.
   - Wholesale: Christina (the buyer) as the protagonist. Brief
     speaks to "your floor," "your customers." Pragmatic — every
     wholesale brief should at minimum hint at a number (margin,
     pieces-in-stock, or weeks-to-restock).

6. **Brief shape — for each slot:**
   - `name`           3–8 word internal label. Sentence case. The
                       operator's view of "what is this campaign
                       about?" Becomes the campaign.name in the DB.
                       Good: "Honey colorway lands for Labor Day"
                             "Last-chance readers, 30% off, ends Mon"
                       Bad:  "Email 1" / "Promo" / "Newsletter"
   - `angle`          2–4 sentences. Why this email, why now, what
                       specific moment / product / framing the email
                       should lead with. Don't write the headline
                       — that's the next stage. Write the *idea*.
   - `productHook`    SKU / category / colorway if known, else "".
   - `seasonalContext` Holiday or seasonal anchor if relevant, else "".
   - `rationale`      1 sentence explaining which calendar event
                       (if any) drove this brief + why this angle
                       fits the slot's image-style + subject-angle.
                       This is the AI-to-operator handoff: "here's
                       why I proposed this." Operator reads it to
                       decide whether to accept or refine.

7. **No empty briefs.** Even if there's no calendar event for a
   slot, propose a brief grounded in the audience + season + the
   assigned image-style. Don't return placeholders.

────────────────────────────────────────────────────────────
SHAPE — example output for a 2-slot window
────────────────────────────────────────────────────────────

```json
{
  "briefs": [
    {
      "name": "Honey colorway lands for Labor Day",
      "angle": "First-time-ever Honey colorway debut, timed to Labor Day weekend. Lead with the road-trip framing — this is the colorway you actually wanted for late-summer drives. Pair with the new lookbook flat-lay shot.",
      "productHook": "Honey colorway, Sunday Drive frame",
      "seasonalContext": "Labor Day weekend",
      "rationale": "PRIMARY calendar event (Labor Day) lands in slot's date window. Slot 1 = product flat-lay, lifestyle-sensation subject angle — flat-lay shot of Honey on a road-trip-coded surface fits perfectly."
    },
    {
      "name": "Last-chance Honey before Tuesday",
      "angle": "Reminder send. The same Honey drop, but flip the framing — on-model lifestyle shot, 'these went fast, here's what's left.' Soft urgency without screaming.",
      "productHook": "Honey colorway, Sunday Drive frame",
      "seasonalContext": "End of Labor Day weekend",
      "rationale": "Same window as slot 1 but different lens per the non-repeat rule. Slot 2 = on-model lifestyle, social-proof subject angle. The 'these went fast' framing IS the social proof."
    }
  ]
}
```

Return strict JSON via the tool. No prose around it.
