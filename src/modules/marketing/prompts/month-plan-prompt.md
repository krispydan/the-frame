# Monthly campaign planner prompt — v3 (2026-07-07)

<!-- v3: STRUCTURAL FIX — the entire working prompt now lives in the FIRST
     triple-backtick block below, because email-ai's extractPromptBody()
     takes the first fenced block as the prompt. v1/v2 had the JSON example
     as the first fence, so the model received ONLY the example (never the
     task, constraints, dates, or calendar) and parroted "Honey colorway
     lands for Labor Day" briefs no matter the window. Examples are now
     INDENTED (not fenced) inside the prompt block.
     Carries the v2 content rules: anchor to events ONLY inside the window,
     never a distant holiday, ≤2 slots per anchor, evergreen mix when the
     calendar is empty. -->

Purpose: given an audience, a date range, and the marketing calendar for
that window, propose **a unique brief per email slot** that the operator
accepts (or refines) into real campaigns. Upstream of
`copy-generation-prompt.md` (v5) — that prompt writes one email from one
brief; THIS prompt produces the briefs.

Inputs (filled by the planner before dispatch): `audience`, `startDate`,
`endDate`, `cadence`, `slots[]` (each with layoutProfile / imageStyle /
subjectAngle from the strategy engine), `calendarEvents` (pre-formatted
block; `(none)` when the window has no events).

Output: a single `submit_month_plan` tool call with `briefs[]` matching
`slots[]` 1:1 in order.

```
TASK: Plan the email calendar.

Window: {{startDate}} → {{endDate}}
Audience: {{audience}}
Cadence: {{cadence}}
Slots to plan: {{slotCount}}

Marketing calendar — what's happening in this window:
{{calendarEvents}}

Slots (from the strategy engine — each row has its layout, image-style and
subject-angle pre-assigned for variety):
{{slotsTable}}

────────────────────────────────────────────────────────────
HARD CONSTRAINTS
────────────────────────────────────────────────────────────

1. ONE BRIEF PER SLOT, in the same order as the slots table. The number of
   returned briefs MUST equal {{slotCount}}. Each brief's idea must make
   sense ON ITS SLOT'S DATE — read each slot's date before writing.

2. ANCHOR TO CALENDAR EVENTS ONLY WHEN THEY'RE IN THE WINDOW — never reach
   for a distant one.
   - If an event marked [PRIMARY — lead with this] falls within ±5 days of
     a slot's date, that slot's brief MUST orient around it.
   - NEVER anchor a slot to an event OUTSIDE {{startDate}} → {{endDate}}.
     A holiday weeks past the window (e.g. Labor Day when the window ends
     mid-August, or Black Friday in a July plan) is NOT this month's story.
     Do not mention it at all.
   - Cap: at most 2 slots may share the same holiday/seasonal anchor. If
     one event dominates the window, the remaining slots still get their
     own distinct, non-holiday ideas.

3. EMPTY OR SPARSE CALENDAR → EVERGREEN AND DIVERSE. If calendarEvents is
   "(none)" — or has far fewer events than slots — do NOT invent a holiday.
   Plan the un-anchored slots as a varied evergreen mix driven by:
   - the ACTUAL season of each slot's date (mid-July = peak summer;
     late August = back-to-school / early-fall preview)
   - product/colorway rotation: new arrivals, best-sellers, restocks,
     a hero style per slot
   - audience needs — wholesale: floor sets, margin, weeks-to-restock,
     don't-run-dry; retail: the colorway/moment for right now
   A no-event month should read as {{slotCount}} genuinely DIFFERENT
   campaigns, not {{slotCount}} takes on one theme.

4. NO TWO SLOTS SHARE THE SAME BRIEF ANGLE. Even two slots anchored to the
   same event must approach it from different angles (e.g. slot A: the
   offer + long-weekend framing; slot B: last-chance reminder led by a
   customer story). Don't repeat.

5. MATCH THE ASSIGNED SLOT DIMENSIONS. Each slot has a layoutProfile
   (editorial / product-catalog / split / UGC), imageStyle (product
   flat-lay / on-model lifestyle / detail macro / paired 2-up) and
   subjectAngle (product-focused / lifestyle-sensation / curiosity-hook /
   social-proof / practical-value). The brief should flow naturally to
   those dimensions — don't propose a story-led narrative for a slot with
   subjectAngle = practical-value.

6. AUDIENCE VOICE.
   - retail: customer-as-self — "your day," "your moment," "your
     colorway." Casual, text-from-a-friend tone.
   - wholesale: Christina (the buyer) is the protagonist — "your floor,"
     "your customers." Pragmatic: every wholesale brief should at minimum
     hint at a number (margin, pieces-in-stock, or weeks-to-restock).

7. BRIEF SHAPE — for each slot:
   - name: 3–8 word internal label, sentence case. The operator's view of
     "what is this campaign about?" Good: "Sunset colorway hits the floor",
     "Summer best-sellers, restock before August", "Last-chance readers,
     30% off, ends Mon". Bad: "Email 1" / "Promo" / "Newsletter".
   - angle: 2–4 sentences. Why this email, why NOW (on this slot's date),
     what specific moment / product / framing to lead with. Write the
     idea, not the headline.
   - productHook: SKU / category / colorway if known, else "".
   - seasonalContext: holiday or seasonal anchor if relevant, else "".
   - rationale: 1 sentence — which calendar event (if any) drove this
     brief and why the angle fits the slot's image-style + subject-angle.
     This is the AI-to-operator handoff.

8. NO EMPTY BRIEFS, NO FILLER-BY-HOLIDAY. Every slot gets a real, specific
   brief grounded in the audience + the actual season of its date + a
   concrete product angle. "No calendar event" is a reason to lead with
   product and season — never a reason to fall back on the nearest
   (or a distant) holiday.

────────────────────────────────────────────────────────────
WORKED EXAMPLES (illustrative shape only — do NOT copy their content;
your briefs must come from THIS window's dates, calendar and slots)
────────────────────────────────────────────────────────────

EXAMPLE A — a PRIMARY event IS in the window (2 slots near Labor Day,
window ends after it):

    briefs[0] = {
      "name": "Honey colorway lands for Labor Day",
      "angle": "First-ever Honey colorway debut, timed to Labor Day weekend. Lead with the road-trip framing — the colorway you actually wanted for late-summer drives. Pair with the new lookbook flat-lay shot.",
      "productHook": "Honey colorway, Sunday Drive frame",
      "seasonalContext": "Labor Day weekend",
      "rationale": "PRIMARY event (Labor Day) is inside this slot's window. Flat-lay + lifestyle-sensation slot — road-trip-coded flat-lay fits."
    }
    briefs[1] = {
      "name": "Last-chance Honey before Tuesday",
      "angle": "Reminder send: same Honey drop, flipped framing — on-model shot, 'these went fast, here's what's left.' Soft urgency without screaming.",
      "productHook": "Honey colorway, Sunday Drive frame",
      "seasonalContext": "End of Labor Day weekend",
      "rationale": "Same event as slot 1 but a different lens per the non-repeat rule; on-model + social-proof slot — 'went fast' IS the social proof."
    }

EXAMPLE B — EMPTY calendar (calendarEvents = "(none)"), 2 wholesale slots
in mid-July. Note: no shared anchor, no holiday — one restock play, one
new-arrival play:

    briefs[0] = {
      "name": "Summer best-sellers, restock before August",
      "angle": "Peak-summer reorder nudge. Lead with the 3 fastest movers on Christina's floor this season and the weeks-to-restock math before the August rush. No holiday — the pragmatic 'don't run dry on your winners' moment.",
      "productHook": "Top-3 summer SKUs",
      "seasonalContext": "Mid-summer sell-through",
      "rationale": "No calendar event — driven by the actual season (peak-summer sell-through) + wholesale practical-value angle; product-catalog layout shows the best-sellers with restock numbers."
    }
    briefs[1] = {
      "name": "Sunset colorway hits the floor",
      "angle": "New colorway arrival framed for the buyer: a fresh SKU to refresh the set mid-season, strong margin, limited first run. The easy add that makes the shelf feel new without a big reorder.",
      "productHook": "Sunset colorway, 4 styles",
      "seasonalContext": "Late-summer refresh",
      "rationale": "No event — product-rotation driven and distinct from slot 1's restock play; split layout + product-focused angle fits a single hero colorway with the margin hook."
    }

Return the briefs via the submit_month_plan tool. No prose.
```

## Output schema

Enforced by the `submit_month_plan` tool in `email-ai.ts` (`planMonth`):
`briefs[]` of exactly `slotCount` objects — `name`, `angle`, `rationale`
required; `productHook`, `seasonalContext` optional strings.
