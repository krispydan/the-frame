# Marketing Email — UX Review & Flow Plan

**Date:** 2026-06-24
**Scope:** The whole feature as a *journey*, not page-by-page correctness. Question asked: does it "make sense and flow well" for the operator who runs it daily? Method: audited all 7 surfaces — marketing hub, email dashboard, planner, the email month calendar, the events calendar, the campaign editor, the designer queue — tracing the real path from "I need this week's emails" to "exported, ready to send."

---

## 0. Verdict

The machine is strong; the **map is confusing**. Every capability exists, but a first-time (or returning-after-two-weeks) operator can't tell *where to start, which path to take, where they are, or what to do next*. The friction is almost entirely **information architecture + wayfinding**, not missing features. Five fixes close most of the gap.

The single worst offenders:
1. **The dashboard header is a wall of five equal buttons** with no hierarchy — two of which ("Events calendar", "Month view") are near-synonyms that hide two *completely different* calendars.
2. **There's no sense of pipeline.** A campaign moves brief → copy → images → designer → schedule, but no screen shows that journey or says "you're here, do this next." The editor is a flat stack of cards and buttons.
3. **The designer handoff is a dead-end loop** — a designer who finishes uploading can't advance the campaign; they have to leave the queue, open the editor, and hand-change a status dropdown.

---

## 1. Navigation & information architecture

### 1.1 🔴 Header overload + no hierarchy (dashboard)
`/marketing/email` puts five outline-ish buttons in a row: **Events calendar · Month view · Plan the month · Designer queue · New campaign**. They're visually equal, so nothing signals "start here." They also mix three different *kinds* of action: **create** (Plan the month, New campaign), **view** (Month view, Events calendar), and **hand off** (Designer queue).

**Fix:** group and rank them. Lead with the primary creation path (**Plan the month** = the recommended, AI-aware, batch way to start; **New campaign** = the manual single). Demote the two calendars + designer queue into a quieter "views & tools" cluster. Give the creation actions visual primacy.

### 1.2 🔴 Two calendars, near-identical labels
- `/marketing/email/calendar` — the **send schedule** (your campaigns laid out by date). Label today: "Month view."
- `/marketing/calendar` — the **events & holidays** reference the AI reads (±14 days). Label today: "Events calendar."

Both say "calendar"; neither label says what it *is*. A user can't predict which one they'll get.

**Fix:** rename to say the *content*: **"Send schedule"** (the campaign month grid) and **"Events & holidays"** (the AI context). Add a one-line subtitle to each page stating its job and how it relates to the other, and cross-link them so they're discoverable from each other, not only from the dashboard.

### 1.3 🟡 Inconsistent back-navigation
Sub-pages disagree on how to go home: the planner and events calendar say **"← Email assistant"**, the send-schedule calendar says **"Dashboard."** Same destination (`/marketing/email`), three phrasings.

**Fix:** one consistent affordance — **"← Email assistant"** — on every sub-page, top-left, so "home" is always in the same place with the same words.

---

## 2. Stage / flow guidance ("where am I, what's next")

### 2.1 🔴 No visible pipeline
The lifecycle (`draft → copywriting → photography → design_review → scheduled → sent`) drives the dashboard pipeline card, the calendar dots, and the designer-queue gating — but **inside a campaign there's no map of it.** The editor is a header full of buttons over a stack of cards; nothing says "you've written copy, now generate image prompts," or "images are in, mark it ready."

**Fix:** add a compact **pipeline stepper** to the top of the editor — Brief → Copy → Images → Designer → Schedule — that highlights the current stage and shows a single **"Next: …"** hint tied to the campaign's real state (e.g., no copy yet → "Next: Generate copy"; copy present, no image prompts → "Next: Generate image prompts"). Turns a pile of controls into a guided sequence.

### 2.2 🟡 Two creation paths, no guidance
"New campaign" (manual single) and "Plan the month" (AI batch) both create drafts, but nothing tells the operator which to use. The powerful path (planner) is one click further away and easy to miss.

**Fix:** make **Plan the month** the visually primary create action with a one-line "the AI plans a month of briefs for you" descriptor, and frame **New campaign** as the manual escape hatch. (Covered by 1.1's regrouping.)

### 2.3 🟢 After batch-create, the dashboard doesn't focus the new drafts
"Open dashboard" dumps the user into the full unfiltered list. Minor, noted — a deep link to a drafts-filtered view would be nicer but isn't load-bearing.

---

## 3. Designer handoff loop

### 3.1 🔴 The designer can't advance the campaign from the queue
A designer uploads every image, the row flips to "All uploaded" — and then **nothing.** To actually move the campaign to `design_review` they must leave the queue, open the editor, and change a dropdown. The handoff has no finish line in the place the handoff happens.

**Fix:** when all required images are uploaded, surface a **"Mark ready for review"** action right on the queue row that advances the status (`photography → design_review`) in place, and reflect it immediately. Close the loop where the work happens.

### 3.2 🟡 Rows look static — no expand affordance
The whole row is clickable to expand, but there's no chevron or hover cue, so the briefs/upload zones read as hidden.

**Fix:** add a chevron that rotates on expand + a hover state.

### 3.3 🟡 Status badge conflates two ideas
The collapsed badge shows *either* "All uploaded" *or* the raw lifecycle status — mixing "are the images in?" with "what stage is this?" A `design_review` row with a missing image still reads "design_review."

**Fix:** show upload-completeness as its own signal (the dots already do most of this); keep the lifecycle status as a separate, secondary badge.

---

## 4. Micro-UX & terminology (lower priority, batched)

- **Variant differences are invisible** until you open each `<option>`'s tooltip — the one-line note should show inline under the picker. 🟡
- **Export card doesn't say what it's for** beyond "paste into Faire / Omnisend." A one-liner ("preview/section images to drop into your sending platform") would orient first-timers. 🟢
- **Copy history is collapsed with no count** until opened — surface "N versions" on the collapsed header. 🟢
- **"2nd-b" upload dot** is undefined jargon — label it "2nd image B" or similar. 🟢
- **Inconsistent object naming** — "campaign" vs "email" vs "draft" drift across screens; settle on **"campaign"** in chrome, "email" only when talking about the sent artifact. 🟢

---

## 5. Action plan

**Building now (the coherence core):**
1. **Dashboard header IA** — regroup into Create (primary) vs Views & tools; clearer labels. *(§1.1, §2.2)*
2. **Calendar clarity** — rename to "Send schedule" / "Events & holidays", add purpose subtitles, cross-link. *(§1.2)*
3. **Consistent back-nav** — unify on "← Email assistant" everywhere. *(§1.3)*
4. **Editor pipeline stepper** — Brief → Copy → Images → Designer → Schedule with current-stage highlight + "Next:" hint. *(§2.1)*
5. **Designer-queue loop closure** — "Mark ready for review" on the row + chevron affordance + separated badges. *(§3.1–3.3)*

**Batched if cheap:** variant notes inline, copy-history count, export blurb, "2nd-b" label *(§4)*.

**Deferred (parked, unchanged):** analytics/learning loop, ESP HTML export, Outlook robustness, image library, multi-brand.

---

## 6. Verification (after build)

All five coherence-core fixes shipped:

1. **Dashboard header** — now two ranked clusters: a primary **Create** row (filled "Plan the month" + outline "New campaign") above a quiet ghost-button **views & tools** row (Send schedule · Events & holidays · Designer queue). Each carries a `title` tooltip explaining what it does.
2. **Calendars** — `/marketing/email/calendar` is now **"Send schedule"**, `/marketing/calendar` is **"Events & holidays"**; each page's subtitle states its job and links to the other; the marketing hub card + the internal comment were renamed to match.
3. **Back-nav** — every sub-page (planner, both calendars, designer queue, editor) now leads with the same top-left **"← Email assistant"** link in the same position.
4. **Editor pipeline stepper** — a Brief → Copy → Images → Designer → Schedule strip sits directly under the editor header. Stage completion is derived from the campaign's real data (brief angle, copy, image prompts, uploaded images, scheduled status), the current stage is highlighted, and a single **"Next: …"** line names the one action to take.
5. **Designer queue** — rows gained a rotating chevron; the conflated badge is split into an **"Images in / Images pending"** completeness signal and a separate lifecycle-stage badge; and when every required image is uploaded, a **"Mark ready for review"** button advances `photography → design_review` in place — no detour through the editor.

Also done from §4: the cryptic "2nd-b" upload dot is now labelled "2nd image B".

**Checks:** `tsc` clean on all six touched files; `npm test` marketing suite green (33 tests, incl. the render-engine regression suite). Changes are presentational/markup + one status PATCH; no schema or data-flow changes.

**Deferred (unchanged):** inline variant-note hints and the export-card blurb (§4, marginal); and the parked list (analytics, ESP export, Outlook, image library, multi-brand).
