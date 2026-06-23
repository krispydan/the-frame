# Marketing Email Assistant — External Review (round 4) & Re-prioritized Plan

**Reviewer:** Claude (fresh external pass — did NOT build the main line; reviewing it as an outsider)
**Date:** 2026-06-23
**Companion to:** `SELF-REVIEW.md` (the build team's 3-round self-critique). This doc does **not** repeat their 30 items — it verifies them, finds what they missed, and **re-aligns the plan to what Daniel actually asked for.**

---

## 0. TL;DR

The build team self-assesses ~80% to "replaces the $3,000/mo agency." That's roughly fair on *production capability* — the pipeline (brief → copy → image briefs → designer handoff → image export) genuinely works and the monthly planner is a real ideation step. But two things need saying plainly:

1. **The team's stated top priorities are the ones Daniel explicitly de-scoped.** Their §7 "single most-impactful next thing" (every round) is the **learning-loop / send-results analytics**, and their §3.14 push is **Omnisend HTML export**. Daniel has said, in writing, he does **not** need analytics, ESP/Omnisend export, tests, or Outlook robustness "yet," and that **image export is the channel for now.** So the self-review's roadmap is aimed at the wrong target. This doc re-aims it.
2. **There are concrete, live bugs the self-review missed** (below). A 3-round self-review that never caught a hardcoded invalid-looking model id or a permanently-broken dashboard badge is a sign the reviews are walking the happy path, not stress-testing.

Net: it's a strong v3. The gap to "enterprise-grade internal tool" is now mostly **operational polish + correctness hardening on the channels Daniel actually uses**, not the big analytics build the team keeps proposing.

---

## 1. New findings the self-review missed (verified in code)

### 🔴 1.1 Dashboard "Designer queue" badge is permanently broken
`src/app/(dashboard)/marketing/email/page.tsx`:
```js
const designerQueueCount = statusCounts["image_pending"] + statusCounts["image_review"];
```
Those two statuses were **removed** when the kanban was flattened to `draft / copywriting / photography / design_review / scheduled / sent / analyzed`. `statusCounts` is only seeded for the new keys, so both terms are `undefined` → `undefined + undefined = NaN` → `NaN > 0` is false → **the badge never renders**. The designer can have 5 campaigns waiting and the dashboard shows nothing. Should be `statusCounts.photography` (+ optionally `design_review`).

### 🔴 1.2 Hardcoded model id, no env override, never verified
`lib/email-ai.ts`: `model = "claude-opus-4-7"`. Every other AI caller in the repo uses a **dated, known-valid** id (`claude-opus-4-1-20250805`, `claude-sonnet-4-20250514`). `claude-opus-4-7` is undated and not a known API id. If it ever stops resolving (or on a key without access) **every generation 502s** with no fallback and no way to switch without a code change + redeploy. It's also echoed to the user in the `GenerationStatus` panel as a hardcoded string (drift risk). Centralize + make env-overridable.

### 🟡 1.3 Dashboard ignores the `name` field — the actual title
The list + "this week" cards render `c.subject ?? c.heroHeadline ?? "(no subject)"`. They never fall back to `c.name`, even though `name` *is* the campaign title (the planner and the create-modal both set it, and generate-copy AI-proposes it). A named draft that hasn't generated copy yet shows **"(no subject)"**. The `Campaign` type on the dashboard doesn't even include `name`. (Self-review 3.13 called this "partially closed" — it isn't; the list still ignores `name`.)

### 🟡 1.4 No delete / duplicate / filter on the dashboard
Self-review 3.1 (delete) and 3.8 (duplicate) are still open across all 3 rounds. There is also no way to filter the "All campaigns" list by status or audience — it's an unbounded flat list that will become unusable after a few months of 4 emails/week (~200 rows/yr). These are the most basic CRUD operations for a list-of-things tool.

### 🟡 1.5 Prompt template leaks an unresolved placeholder
`lib/email-ai.ts` `extractPromptBody()` returns the first fenced block of `copy-generation-prompt.md`, which begins with the literal `{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md`. That token is not in the fill map for copy generation (the system prompt is sent separately), so the **literal string `{{SYSTEM_PROMPT_BASE}}` plus a doc-arrow is sent to Claude** in the user message. Harmless-ish, wastes tokens, and risks confusing the model. Also `extractPromptBody` grabbing "first fenced block" is silently wrong if anyone reorders a prompt file.

### 🟢 1.6 Orphaned month-calendar view (introduced this session)
`/marketing/email/calendar` now has a real month grid, but nothing links to it — the dashboard "Calendar" button points to `/marketing/calendar` (the holidays/events calendar). Two different calendars, one unreachable. Needs a nav entry or a merge decision.

### 🟢 1.7 Dead React template tree still present
`components/email-template/*` (10 files) remains, used only for the `CampaignData` *type* import. Self-review flagged this (3.22) and keeps deferring it. It's a divergence trap: edit the string renderer, the React tree silently rots.

---

## 2. Where I agree with the self-review (and the severity)

Confirmed still-open and genuinely worth doing (in Daniel's scope):
- **3.3** brief edits don't prompt image-prompt regeneration (stale briefs) — 🟡, real.
- **3.2** no AI copy version history (destructive overwrite) — 🟡, real but lower urgency than they rate it.
- **3.5** no subject-line A/B surface — 🟡, Daniel did ask to "test subject angles."
- **3.18** image regeneration always does both slots — 🟢.
- **3.26** rotation is naive modulo (no track-and-avoid) — 🟢 until there's volume.

Confirmed but **de-scoped by Daniel** (do NOT prioritize, despite the self-review ranking them #1):
- **3.24** learning loop / send-results analytics — *deferred by Daniel.*
- **3.14** Omnisend HTML / Faire JSON export — *deferred; image export is the channel.*
- **3.29** test coverage — *deferred.*
- Outlook/email-client robustness — *deferred* (image export sidesteps it anyway).

The self-review's own verdict ("the single most impactful next thing is the send-results form") is the thing to **not** build right now. That's the core misalignment.

---

## 3. Honest verdict on the "replaces a $3k/mo agency" question

Re-framed against Daniel's actual scope (image-channel, no analytics yet):

- **Production (make the emails): ~85%.** Briefing, on-brand copy, image direction, assembly, image export all work. With the copy-QA linter added this session, output quality is now *enforced*, not just hoped for.
- **Operations (run it day to day): ~60%.** This is the real gap now — no delete/duplicate/filter, a broken queue badge, name-display bugs, no "generate copy for all planned" batch. These are what make it *feel* like a tool vs. a prototype.
- **Strategy (decide what to send): ~75%.** The monthly planner + holidays calendar is a genuine strategy surface. Missing: it doesn't yet learn (de-scoped) and doesn't propose *adding* calendar events.

So: strong on production, behind on operations. The agency-replacement bar, given Daniel's scope, is mostly an **operations + reliability** problem now — not an analytics problem.

---

## 4. Re-prioritized plan (aligned to Daniel's scope)

### Sprint A — Reliability + operations (do now)  ← this session
1. **Centralize the AI model** (1.2) → `lib/ai-model.ts`, env `MARKETING_EMAIL_MODEL`, known-valid default; `GenerationStatus` reads it instead of a hardcoded string. *(done)*
2. **Fix the designer-queue badge** (1.1) → count `photography` (+ `design_review`). *(done)*
3. **Dashboard operations**: delete (confirm), duplicate (clone → draft), status + audience filter, `name` fallback everywhere. *(done)*
4. **Link the month calendar** (1.6). *(done)*
5. **Strip the `{{SYSTEM_PROMPT_BASE}}` leak** (1.5). *(done)*

### Sprint B — AI loop tightening (in progress)
1. Brief-change → "regenerate image prompts" stale banner (3.3). *(done)*
2. Designer queue shows campaign name + one-line brief (3.10). *(done)*
3. Per-slot image regeneration `?slot=hero|secondary` (3.18). *(next)*
4. Subject A/B: `subject_alt`/`preheader_alt` columns + a toggle (3.5) — Daniel asked for angle testing; this is the in-scope slice of it. *(next)*
5. AI copy version history (3.2) — lightweight `copy_versions` table + restore. *(next)*

### Sprint C — Make the image channel excellent (Daniel's chosen channel)
1. Batch "Generate copy + image prompts for all planned drafts" from the planner (self-review §9.6 — the highest-leverage planner upgrade).
2. Image-export polish: per-section + whole-email already client-side; add width presets (600/1200) + a "copied to clipboard" affordance for paste-into-Faire.
3. Designer queue: show brief/name + subject preview (3.10).

### Explicitly NOT now (Daniel-deferred)
Learning-loop analytics, Omnisend/Faire HTML export, automated tests, Outlook hardening, multi-brand, image library. Revisit when Daniel asks.

---

## 5. One thing to internalize

The build team is strong but is reviewing its own work and keeps proposing the *ambitious* next thing (analytics, multi-brand) over the *boring* next thing (delete button, fix the broken badge, don't ship an invalid model id). For an internal tool that has to be *trusted daily*, boring-and-correct beats ambitious-and-fragile. The fastest path to "this actually replaces the agency for us" is finishing operations and hardening reliability on the one channel Daniel uses — which is what Sprint A does.
