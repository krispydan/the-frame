# Marketing Email Assistant — Self-review & Improvement Plan

**Last updated:** 2026-06-23 (round 2 — see §8 for delta)
**Reviewer:** Claude (built the whole thing — adversarial self-review)
**Scope:** Full pipeline from "operator clicks New campaign" through "designer uploads JPG" through "Daniel exports HTML/JPG and pastes into Faire/Omnisend."

This isn't a "looks great, ship it" review. The goal: find every place this falls short of "replaces a $3,000/mo agency" and write down what to do about it.

> **Round 2 quick index:** see §8 for what changed (real logo SVG, in-editor image uploads, section visibility toggles) and a re-evaluation of the issue list (3 closed, 27 still open + 4 new ones surfaced).

---

## 1. Pipeline walkthrough

The current end-to-end flow:

```
1. Daniel  → /marketing/email → "+ New campaign" button
2. MODAL   → Name, Audience, Date, Brief title/angle/hook/seasonal context
              Submit → POST /api/v1/marketing/email/campaigns
3. EDITOR  → /marketing/email/campaigns/[id]
              Header: audience / status / date / name (all inline editable)
              Body:   Campaign Brief card (editable)
                      Subject + preheader
                      Hero block (variant picker + 6 copy fields)
                      Section A (variant picker + 2 fields)
                      Secondary image (variant picker + image path)
                      Section B (variant picker + 4 fields + CTA)
              Right:  Live preview iframe + section JPG export buttons
              Actions: Generate copy / Generate image prompts

4. AI COPY    → POST /generate-copy → Claude reads brief, fills text fields,
                 sets status = copywriting

5. AI IMAGES  → POST /generate-image-prompts → Claude writes Higgsfield
                 briefs for hero + secondary, sets status = photography

6. DESIGNER   → /marketing/email/designer-queue
                 Sees campaign card with both prompts + drop zones
                 Renders in Higgsfield → drops JPG into slot
                 Both uploaded → status = design_review

7. DANIEL     → returns to editor, refines copy if needed,
                 changes status to "Scheduled" when ready

8. EXPORT     → Section JPG buttons in editor
                 → Paste into Faire / Omnisend / wherever
```

Or via chat-Claude through MCP:
```
chat-Claude → plan_week → creates 4 campaigns with auto-briefs
chat-Claude → build_campaign_from_idea → creates + fills 1 campaign
chat-Claude → generate_with_v5_prompt → fills copy
chat-Claude → generate_image_prompts → writes Higgsfield briefs
```

---

## 2. What works (genuinely)

| Area | Why it works |
|---|---|
| **Variant system** | Decoupling layout from content lets us avoid visual sameness across the 4 weekly emails without writing 4 templates. Adding a 5th variant = add a function + extend enum. |
| **Strategy engine** | Deterministic rotation (week + slot) means Daniel never gets two Mon emails with the same hero variant. Audience-specific cadence (retail Mon+Thu, wholesale Tue+Fri) baked in. |
| **Brief as primary input** | Right call to make brief the editable surface, not a hidden side-effect of theme picking. Per-slot unique briefs in plan_week means each email has its own clear lens. |
| **Modal create** | The forcing function — Daniel has to think about the brief BEFORE the campaign exists. Stops half-baked "I'll fill it in later" campaigns. |
| **Kanban statuses** | 7 stages vs 10 ops-flavored states. Reads like a real workflow. Editable from the header — Daniel can override the auto-advance whenever. |
| **Section JPG export** | Solves a real pain (Faire's image-based builder). Reuses the renderer — no duplicate template. |
| **MCP integration** | 13 tools cover the whole pipeline. Daniel can do everything via chat without ever opening the dashboard. |
| **Brand voice loaded at module init** | BRAND-BIBLE.md + WHOLESALE-VOICE.md snapshot in repo, read once at boot. Zero per-request latency. |
| **String-template renderer** | Survived the Next 16 + Turbopack `react-dom/server` ban. Decoupled from framework — won't break in future upgrades. |

---

## 3. Real problems (severity-ordered)

### 🔴 Severity 1 — User-visible breakage or workflow gaps

#### 3.1 No way to delete a campaign from the dashboard
The DELETE endpoint exists but there's no UI button. If you create a mistake-campaign you can't get rid of it without `curl`-ing. **Critical** — Daniel will hit this on first use.

#### 3.2 No undo on AI generation
`generate-copy` overwrites the previous copy with no version history. If the AI returns worse copy than you had, the prior version is gone. The campaign row has `aiCopyRawJson` (the raw response) but no history beyond the latest.

#### 3.3 Brief edits don't trigger image-prompt regeneration
If you change the brief AFTER generating image prompts, the prompts stay stale. No "regenerate image prompts" reminder when brief changes.

#### 3.4 Section export will silently fail on Railway first deploy
Chromium download in the build script may succeed but launching may fail (missing system libs — libnss, libgbm). Self-test would catch this. No health-check endpoint for `/export-image`.

#### 3.5 No subject-line A/B test surface
Daniel asked for "test subject angles." The schema doesn't have alt subjects. The strategy engine returns ONE subject angle per slot. Need: `subject_alt`, `preheader_alt` columns + an A/B picker UI before export.

#### 3.6 The brief modal can be dismissed with unsaved data
Click outside the modal (the backdrop) → modal closes, form state is lost. Should at least confirm or persist as a draft.

#### 3.7 Audience editing on the editor doesn't regenerate the brief
If you switch retail→wholesale, the brief still uses the retail voice. The strategy + brief are baked into the row at create time. Need: "Audience changed — regenerate brief?" affordance.

### 🟡 Severity 2 — Annoying friction, not blocking

#### 3.8 No campaign duplication
"This week's email worked great, let me clone it as the basis for next week" — no button. Must re-create from scratch.

#### 3.9 No bulk plan ahead UI
`plan_week` is only callable via MCP. Daniel can't sit at the dashboard and say "plan the next 4 weeks of both audiences" without typing into chat-Claude. Should be a button on the dashboard.

#### 3.10 The designer queue doesn't show subject / brief title preview
Designer only sees the image prompt — they don't see what the email is ABOUT. Adding a 1-line summary ("Honey colorway drop — terracotta tortoise tones") would help them shoot more aligned imagery.

#### 3.11 No CTA URL validation
The CTA fields are free-text. Could check at submit time if URL is reachable (HEAD request), or at least validate it's a URL.

#### 3.12 Preview iframe doesn't auto-refresh on save
Have to click Refresh. Should auto-debounce on any successful PATCH.

#### 3.13 The schema has `name TEXT NULL` but the form encourages a name
If left blank, the dashboard list shows "(no subject yet)" — confusing UX. Should fall back to brief title or auto-generate from date+audience.

#### 3.14 Export to Omnisend HTML / Faire JSON not implemented
Phase 5 was supposed to cover this. The section-JPG export got built first because Daniel asked for it specifically. But the full HTML download for Omnisend (which DOES accept HTML emails) is still missing.

#### 3.15 No way to see "what was the original AI output vs what I edited"
`aiCopyRawJson` stores the raw response but no UI surfaces it. Useful for understanding when the AI gets it right vs when you have to rewrite from scratch.

### 🟢 Severity 3 — Quality / polish

#### 3.16 Brand font load can FOUC in preview iframe
The Google Fonts CSS link is in the iframe HTML, but the iframe loads after the page. Brief flash of fallback fonts before Instrument Sans takes over.

#### 3.17 Section heading on mobile (480px) is 14px — possibly too small
Was 11px (when uppercase), now 14px (sentence case). Need to eyeball on actual phone.

#### 3.18 Image-prompt regeneration always regenerates BOTH hero + secondary
Even if only one variant changed. Wastes tokens. Should be per-slot.

#### 3.19 The "brief title" field has no character limit guidance
"3–8 words" in label but no maxLength. Long titles overflow the campaign list view.

#### 3.20 No saved-state indicator on the brief modal
Submit hangs for 1-2s with no spinner change beyond button text. Looks broken if you misclick.

#### 3.21 No way to upload a custom logo for one-off campaigns
The logo is hardcoded to "Jaxy" in Glitz. If you wanted a co-branded email (e.g. "Jaxy × someone") you can't.

#### 3.22 The orphaned React component tree is still there
`src/modules/marketing/components/email-template/` — 10 unused React files from before the string-template pivot. Should be deleted.

#### 3.23 The MCP tool `refine_campaign` has no field-level diffing
It just overwrites whichever fields you mention. No "diff before/after" surface, no confirmation.

### 🔵 Severity 4 — Long-term architecture

#### 3.24 No learning loop yet
The schema has `marketing_email_send_results` for capturing open/click metrics but no UI for entering them, no MCP tool for ingestion, and the strategy engine doesn't read from it. The whole "smart engine over time" Daniel asked for is stubbed but not wired.

#### 3.25 No multi-tenant / multi-brand support
Hardcoded to Jaxy throughout. If Daniel wanted to do this for a sibling brand, lots of refactoring.

#### 3.26 The strategy engine's rotation is naive
4-week rotation period. After 4 weeks, week 5 = week 1 again. No actual variety algorithm — just modulo arithmetic. Should track what was used recently and avoid repeats.

#### 3.27 No image library
Every campaign uploads fresh images. Can't reuse "that gorgeous Honey colorway flat-lay from 3 weeks ago." Should have a library view.

#### 3.28 Brand context snapshots can go stale
`src/modules/marketing/brand-context/*` is a snapshot of the Google Drive brand docs. No auto-sync. Daniel updates the brand bible → forgets to sync → AI starts generating off-brand copy.

#### 3.29 No test coverage
Zero tests on the AI generation, the rendering, the variants, the strategy engine. All the screw-ups will be found in production.

#### 3.30 Section export's screenshot is body-height not section-height
For a single hero block, fine. For "full" email export, the screenshot is the entire scrollable email — potentially 4000+ pixels tall. Bandwidth-heavy. Should have a max-height clamp.

---

## 4. Improvement plan (prioritized)

### Sprint 1 — Critical UX (1-2 days)

Fixes that unblock real use TODAY.

1. **Delete button on the dashboard** (3.1) — small icon in the campaign list, confirm dialog. ~30min.
2. **Plan-ahead button on the dashboard** (3.9) — opens a modal: audience picker, # weeks, calls plan_week. Replaces "use MCP" with one button. ~1hr.
3. **Duplicate campaign button** (3.8) — clone row, today's date, status reset to draft. ~30min.
4. **Auto-refresh preview on PATCH** (3.12) — already have `setPreviewKey(k => k + 1)` — just call it from `updateField`. ~10min.
5. **Modal close confirmation if dirty** (3.6) — track if any field touched; if yes, confirm on backdrop click. ~15min.
6. **Name fallback** (3.13) — if name empty, dashboard shows brief title; if both empty, "Untitled • {date} • {audience}". ~10min.
7. **Subject-line A/B test surface** (3.5) — add `subject_alt`, `preheader_alt`; AI generates both; toggle in editor. ~2hr.
8. **Designer queue: show brief title in the row header** (3.10) — already in the GET response, just render. ~10min.

**Total: ~5hr.** Big quality-of-life lift.

### Sprint 2 — AI workflow (2-3 days)

Make the AI loop tighter and safer.

1. **Brief change → image-prompt regenerate prompt** (3.3) — track brief hash; if changed since last image-prompt gen, show banner. ~1hr.
2. **Audience change → brief regenerate prompt** (3.7) — same pattern, brief title contains "(retail)" vs "(wholesale)" hint. ~30min.
3. **AI copy version history** (3.2) — add `marketing_email_copy_versions` table; persist on every regenerate; UI shows last 5, restore button. ~3hr.
4. **Per-slot image regenerate** (3.18) — add `?slot=hero|secondary` param. ~30min.
5. **CTA URL validation** (3.11) — HEAD request on PATCH, warn if 404. ~30min.
6. **"What the AI returned vs what you edited" diff view** (3.15) — split-pane in a modal. ~2hr.
7. **Brand context staleness check** (3.28) — `scripts/sync-brand-context.sh` exists in the plan; add cron that diffs Drive vs repo daily, alerts Daniel via MCP. ~1hr.

**Total: ~9hr.**

### Sprint 3 — Export completeness (1-2 days)

Phase 5 stuff that's still missing.

1. **Omnisend HTML download** (3.14) — `/export?format=omnisend` returns the full email HTML with inlined styles. ~2hr.
2. **Faire JSON download** (3.14) — same endpoint, JSON shape Faire's manual paste expects. ~1hr.
3. **Section export max-height clamp** (3.30) — `?maxHeight=2400` param. ~30min.
4. **Section export self-test endpoint** (3.4) — `/api/v1/marketing/email/health/screenshot` renders a hello-world and returns OK or the chromium error. ~30min.
5. **Month calendar view** (Phase 5) — `/marketing/email/calendar` shows 4-up cards per week, drag to reschedule. ~3hr.

**Total: ~7hr.**

### Sprint 4 — Architecture / learning loop (5-7 days)

The "smart engine over time" Daniel asked for.

1. **Send-results capture form** (3.24) — `/marketing/email/campaigns/[id]/results` page; manual entry of opens/clicks/unsubs. ~3hr.
2. **Strategy v2: track-and-avoid** (3.26) — query last 8 sends for the audience, prefer never-used or least-used variants. ~4hr.
3. **Strategy v2: outcome-weighted** (3.24) — once results table has data, weight variants by avg click-through. The `recordOutcome()` stub already exists. ~6hr.
4. **Image library** (3.27) — `/marketing/email/images` browser; tag by colorway / mood; reuse in any campaign. ~6hr.
5. **Multi-brand abstraction** (3.25) — extract `brand` column on campaigns; brand_context loaded per-row. ~8hr.

**Total: ~27hr (= ~3-4 days).**

### Sprint 5 — Test coverage (2-3 days)

1. **Unit tests on the strategy engine** — exhaustive: every audience × week × slot combo. ~2hr.
2. **Snapshot tests on every renderer variant** — assert HTML output matches golden. ~3hr.
3. **Integration test on the AI flow** — mock Anthropic, assert prompt structure + persistence. ~4hr.
4. **Playwright e2e** — create campaign → fill brief → click generate (mocked) → assert fields fill → click section export → assert JPG returned. ~4hr.

**Total: ~13hr.**

---

## 5. Recommended order

**This week:** Sprint 1 (5hr) + Sprint 3 items 1-2 (Omnisend + Faire export, 3hr) = the loop is genuinely complete.

**Next week:** Sprint 2 (9hr) — tightens the AI loop, prevents drift.

**Following week:** Sprint 4 first half (results capture + strategy v2 track-and-avoid, ~7hr) — starts collecting the data that makes the engine smarter.

**Then:** Sprint 5 (tests, 13hr) before the strategy v2 work compounds — easier to refactor with tests in place.

**Eventually:** Sprint 4 second half (outcome-weighted strategy, image library, multi-brand) — these are luxuries, not necessities.

---

## 6. Honest verdict — "does it replace a $3,000/mo agency?"

**Not yet.** It replaces the **production half** of an agency (briefing, drafting copy, image direction, assembly, export) but not the **strategy half** (campaign calendar planning, performance review, iteration).

What an agency does that this doesn't yet:
- Decides WHAT to email about each week (we have strategy-rotation but no real calendar with launches, holidays, inventory drops, etc.)
- Reviews last month's performance and shifts strategy
- Brings outside-the-brand creative ideas
- Acts as a guardrail when Daniel's busy (deadline pressure → ship anyway)

What this does that an agency doesn't:
- Drafts on demand at 11pm
- Costs $0 per campaign
- Stays perfectly on-brand (no "the agency forgot we changed our positioning")
- Lets chat-Claude collaborate on ideation
- Visible audit trail in git + DB

**Path to actually replacing the agency:**
1. Get the loop tight (Sprint 1 + Sprint 3.1-2)
2. Get learnings flowing (Sprint 4.1-3 — capture + track + weight)
3. Add a strategy calendar — inventory-aware, launch-aware, holiday-aware
4. Quarterly review: pull all sent emails, ask AI "what worked, what to do more of"

That's another ~3-4 weeks of focused work. Currently we're maybe 60% of the way there.

---

## 7. Single most-impactful next thing to do

**Build the send-results capture form (3.24) and wire `recordOutcome()` to it.** Today the strategy engine is deterministic-only — it has no feedback loop. Once we're capturing opens/clicks/unsubs per campaign, every other improvement (track-and-avoid, outcome-weighted, "what worked this month" review) becomes possible. Without it, we're flying blind.

Second most impactful: **Omnisend HTML download (Sprint 3.1).** Right now you have to use section JPGs which is the workaround pattern. Native HTML export means Omnisend handles dark-mode, responsive properly, accessibility — and click tracking works because text is text, not pixels.

---

## 8. Round 2 — what changed since the first review

Three asks from Daniel addressed:
1. **Real logo** — was a Cooper-Black-fallback wordmark rendering the text "Jaxy" in whatever serif the email client had. Now uses the actual SVG from `assets/logos/svg/jaxy-logo-black.svg`, vendored into `public/brand/jaxy-logo-black.svg` and emitted as an absolute-URL `<img>` so it resolves in every render context.
2. **In-editor image uploads** — was three text-input fields where Daniel had to type paths like `email/{id}/hero.jpg`. Now drag-drop dropzones with thumbnail previews and replace-on-drop, sharing the existing `/upload-image` endpoint.
3. **Delete sections** — was no way to skip a block. Now each section card has a "✓ Included / ✗ Hidden" pill toggling a `{section}_disabled` flag; the renderer skips disabled sections. Content preserved when toggled off (toggle back on, copy is still there).

Plus the cumulative pipeline now also has, since v1: brief modal at create time, 7-stage kanban statuses, audience/date/name inline editing in the editor, section JPG export via Playwright, on-brand fonts + sentence-case CTAs.

### 8.1 What got closed

From the previous severity list:
- **3.21 No way to upload a custom logo** — CLOSED. `logoImagePath` column + logo upload card.
- Several friction items implicitly improved by the upload flow:
  - The editor no longer says "Phase 4 will wire uploads" anywhere
  - Replace-on-drop is now an explicit affordance

### 8.2 What stayed open

All 27 other items from §3 still apply. Most-pressing ones unchanged:
- 🔴 No delete-campaign UI (3.1)
- 🔴 No AI version history (3.2)
- 🔴 Brief edits don't trigger image-prompt regeneration (3.3)
- 🔴 Railway Chromium can silent-fail (3.4)
- 🔴 No subject-line A/B test surface (3.5)
- 🟡 No campaign duplication (3.8)
- 🟡 No plan-ahead UI on the dashboard (3.9)
- 🟡 Omnisend HTML / Faire JSON export missing (3.14)
- 🔵 No learning loop / send-results capture (3.24)

### 8.3 New issues surfaced by this round

While building the new features, four new issues popped up:

#### 🔴 8.3.1 — Logo override doesn't validate aspect ratio
The default Jaxy logo SVG is roughly 5:2 (wide horizontal). If you upload a square co-brand logo, the renderer still constrains to `width:96px` with `height:auto`. Square logos become tiny. Should detect aspect ratio on upload and either resize or warn.

#### 🟡 8.3.2 — Logo SVG is served from `/public/brand/` directly
That works in dev but Next.js doesn't add cache headers to `/public` by default. Production logo loads will hit the origin every time instead of CDN-caching. Small fix: add a Cache-Control header in middleware for `/brand/*`.

#### 🟡 8.3.3 — Section toggles don't trigger preview refresh
The dashboard does optimistic state updates and PATCHes the row, but the iframe preview still needs a Refresh click to see the section disappear. Same root issue as 3.12 — preview doesn't auto-refresh on field changes, just on save.

#### 🟢 8.3.4 — Section-image export for a disabled section returns the rendered section anyway
The `renderSectionHtml()` function ignores the `*_disabled` flag — it always renders the requested block. Means you can export a "Section A" JPG even when Section A is hidden in the assembled email. Probably intended (designer might want to see what's there before deleting), but warrants a UI note: "this section is currently hidden but the JPG renders it."

### 8.4 Re-evaluation: what's the actual workflow now?

End-to-end trace, with the new affordances:

```
1. Dashboard → "+ New campaign"
   → Modal: name, audience, date, brief (title/angle/hook/seasonal)
   → POST creates campaign, redirects to editor

2. Editor opens, shows:
   • Header bar:    audience / status / date / name (all editable inline)
   • Logo card:     default brand SVG, optional custom upload
   • Brief card:    pre-filled, editable
   • Subject card:  inbox metadata
   • Hero card:     [✓ Included] [variant picker]
                     dropzone for hero image (thumbnail when uploaded)
                     6 copy fields
   • Section A:     [✓ Included] [variant picker] + copy
   • Secondary:     [✓ Included] [variant picker]
                     dropzone for secondary image (+ secondary_2 if grid)
                     alt text
   • Section B:     [✓ Included] [variant picker] + copy + CTA
   • Right pane:    live preview iframe + section JPG export buttons

3. Operator can:
   • Edit any field — auto-saves on blur
   • Toggle any section off — preview shrinks
   • Drop an image — preview updates
   • Click Generate copy — AI fills text fields
   • Click Generate image prompts — Higgsfield briefs land in DB
   • Move status manually (Draft → Copywriting → … → Sent)
   • Download per-section JPG for pasting into Faire/Omnisend

4. Or chat-Claude does it via MCP:
   • plan_week
   • build_campaign_from_idea
   • generate_with_v5_prompt
   • generate_image_prompts
   • refine_campaign
   • (designer queue still requires the human dropzone step)
```

**Verdict:** the editor now feels like a real composer, not a settings form. The biggest UX shift is the dropzones — typing image paths was the most "this is a database admin tool" moment of the v1 flow. Gone.

### 8.5 Updated improvement plan — added Sprint 1.5

Inserting a small **Sprint 1.5** between Sprint 1 (critical UX) and Sprint 2 (AI workflow) to address the round-2 polish items + remaining 🔴 issues that surfaced as soon as we removed the bigger blockers:

**Sprint 1.5 — Post-round-2 polish (~3hr)**

1. **Logo aspect-ratio detect on upload** (8.3.1) — sharp can read dimensions before save, store width/height, render uses `max-width:120px` with proper aspect. ~30min.
2. **Cache-Control on /brand/*** (8.3.2) — middleware adds `public, max-age=31536000, immutable` for brand assets. ~10min.
3. **Auto-refresh preview on PATCH** (3.12 + 8.3.3) — call `setPreviewKey(k => k + 1)` from `updateField`'s success handler. Already partially there for AI generates. ~15min.
4. **Disabled-section indicator on JPG export buttons** (8.3.4) — show "(currently hidden)" badge next to section buttons whose section is off. ~10min.
5. **Logo dimensions warning on hero variant pickers** (was implicit but surfaced today) — when you switch hero variant, the recommended dimensions change. Show them inline. ~30min.
6. **Confirm-before-leave on modal with dirty data** (3.6 from round 1) — track touched state in the modal; if dirty, confirm on backdrop click. ~15min.
7. **Name fallback in the dashboard list** (3.13) — if name empty, show brief title; if both empty, show `Untitled — {date} — {audience}`. ~15min.
8. **Delete-campaign button in the dashboard** (3.1) — small icon + confirm. The DELETE endpoint already exists. ~30min.

**Total: ~3hr.** Mostly polish, all wins.

### 8.6 New honest verdict

**Better than round 1, still not yet at "replaces a $3,000/mo agency."**

Round 2 closed the "this feels like a database admin tool" gap (dropzones replaced path inputs, real logo replaced fallback wordmark, deletable sections replaced fixed template). The pipeline is now genuinely usable for non-engineers.

What's still missing:
1. **No learning loop** — strategy engine still flying blind. (Sprint 4.1-3)
2. **No Omnisend HTML / Faire JSON export** — section JPGs are a workaround, not the real channel. (Sprint 3.1-2)
3. **No campaign-level operations** — can't delete, can't duplicate, can't bulk-plan a month from the UI. (Sprint 1 + 1.5)
4. **No version history** — AI overwrites are destructive. (Sprint 2.3)

Pipeline maturity: ~70% of the way to replacing the agency. (Was ~60% before round 2.) Three more sprints (1, 1.5, 3) puts it past 85% on production capability — leaving the learning-loop work (Sprint 4) as the final agency-replacement bridge.

### 8.7 Single most-impactful next thing (revised)

Unchanged from round 1: **build the send-results capture form + wire `recordOutcome()`**. Same reasoning — the engine has no feedback loop, so every other smart-engine improvement is theoretical until the data starts flowing.

But there's a tactical wedge that's easier and high-value too: **Sprint 1.5 in one sitting (~3hr)** closes 8 polish items at once. Stack that with **Sprint 3.1 — Omnisend HTML download (~2hr)** and the production capability story is essentially done. That's a ~5hr afternoon that turns "feels like a v1" into "feels like a v2."
