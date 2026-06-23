# Marketing Email Assistant — End-to-End Review & Critique

**Reviewer:** Engineering (deep audit)
**Date:** 2026-06-23
**Scope:** Everything shipped under `src/modules/marketing` (email), `src/app/api/v1/marketing/email/*`, `src/app/(dashboard)/marketing/email/*`, the brand-context snapshot, the prompt library, and the MCP tool surface.
**Goal of the product:** Replace a $3,000/month email agency for Jaxy Eyewear (2 retail + 2 wholesale emails/week) — and beat it.

---

## 1. Verdict in one paragraph

This is a genuinely strong v1. The architecture is clean, modular, and shows real product thinking — the **strategy engine** (deterministic layout/image/subject-angle rotation) and the **MCP orchestration tools** (`plan_week`, `build_campaign_from_idea`) are above the bar for an internal tool and are the seeds of something an agency cannot match on speed or cost. The brand-voice grounding (snapshotted brand bible + wholesale voice + structured prompts with self-checks) is thoughtful. **But it is not yet a product that can replace the agency, because the pipeline does not finish.** There is no export, so nothing ever leaves the tool and lands in Omnisend or Faire — which is the entire point. The back half of the workflow (`preview_ready → exported → sent → analyzed`) is unreachable, Phase 6 analytics are stubbed, copy "QA" is self-reported by the model rather than enforced, the email HTML is fragile in Outlook/Gmail, and there are zero tests. The fixes are well-scoped and mostly additive. With the work in `ROADMAP.md` this becomes a credible agency replacement.

**Grade by dimension (1–5):**

| Dimension | Score | Note |
|---|---:|---|
| Architecture & modularity | 4.5 | Clean separation, future-proofed strategy engine |
| Code quality / readability | 4 | Well-commented, consistent; some duplication & dead code |
| Brand-voice fidelity | 4 | Strong grounding; QA is self-reported, not enforced |
| Pipeline completeness | 2 | No export, no advance, no analytics — pipeline dead-ends |
| Email rendering robustness | 2.5 | Fragile in Outlook/Gmail (bg-image, flex, object-fit) |
| Reliability / correctness | 3 | Invalid model id, no validation on writes |
| Testing | 1 | None for this module |
| Security / multi-user | 3 | Auth via middleware OK; no attribution, no guardrails |
| **Overall** | **3.0** | Strong bones, unfinished pipeline |

---

## 2. What's genuinely good (keep / build on)

1. **The strategy engine (`lib/email-strategy.ts`) is the standout.** Pure, deterministic, dependency-free, and explicitly designed to grow into a data-driven recommender (`recordOutcome` stub, v2/v3 notes). Slot-1/slot-2 image-style split and week-indexed rotation directly encode Daniel's brief. This is the thing that, with a feedback loop, becomes "better than the agency."
2. **MCP tool surface is excellent.** `build_campaign_from_idea` is a true one-shot ("build me a wholesale email about the Faire Summer Market for next Tuesday") and `plan_week` seeds per-slot briefs that differ within a week. This is the chat-native UX that makes the tool fast.
3. **Prompt library is versioned and serious.** `prompts/*.md` with iteration history, hard-shape constraints, banned-word lists, and audience-conditional blocks. Snapshotting the brand bible into the repo for zero-latency loading was the right call.
4. **Schema is clean and dedicated.** Not overloading `marketing_content_calendar` was correct. Variant-per-block columns, AI-metadata columns (`aiCopyRawJson`) for replay, and the `brief_*` editable surface are all well-modeled.
5. **Designer handoff is thoughtful.** Copyable prompts, per-variant dimensions, brand swatches, drag-drop with auto-advance to `image_review`. This mirrors how a real designer hand-off works.
6. **Tool-use for structured output** (forced single tool call) instead of free-form text parsing is the correct pattern and is applied consistently.

---

## 3. Critical gaps (P0 — the product doesn't do its job without these)

### 3.1 There is no export. The pipeline dead-ends. 🔴
The plan specifies `GET /campaigns/[id]/export?format=omnisend|faire` as the Phase 5 deliverable — "self-serve copy-paste into Omnisend / Faire." **It does not exist.** No route, no UI button, no lib. Consequences:
- The tool can ideate, write, brief, and preview — but **nothing can ever be put into the actual sending platforms.** The agency's job is "email in the inbox"; this stops one step short.
- Without it, statuses `exported`, `sent`, `analyzed` are **unreachable** (nothing sets them), so 4 of the 10 pipeline stages are dead.

**Fix:** Build the export route (Omnisend = downloadable standalone HTML; Faire = `{subject, preheader, blocks[]}` JSON for paste), an "Export" affordance in the editor, and have it flip status to `exported`. *(Implemented in this pass — see ROADMAP §A.)*

### 3.2 No `advance` endpoint / status stepper. 🔴
The plan calls for `POST /campaigns/[id]/advance` with per-stage validation, and a 10-stage stepper in the editor's left rail. Today, status only ever moves as a **side effect** of generate/upload calls (`idea→copy_review`, `→image_pending`, `→image_review`). There is no way to move a campaign to `preview_ready`, `exported`, `sent`, or `analyzed`, and no UI to see/drive the pipeline on a single campaign. The editor doesn't even show a stepper. **Fix:** add `advance`/`revert` with validation + a stepper. *(Implemented — ROADMAP §B.)*

### 3.3 Invalid AI model id — likely 502s every generation in prod. 🔴
`lib/email-ai.ts` defaults `model = "claude-opus-4-7"`. Every other AI call in the repo uses a **dated, valid** id (`claude-opus-4-1-20250805`, `claude-sonnet-4-20250514`). `claude-opus-4-7` is not a known-valid API id, is not env-overridable, and will almost certainly return a 4xx from the Anthropic API — meaning **copy/theme/image generation fails in production.** **Fix:** centralize to one env-overridable constant with a known-valid default. *(Implemented — ROADMAP §C.)*

### 3.4 Copy "QA" is self-reported by the model, not enforced. 🔴 (quality-critical)
`generateCopy` asks Claude to fill a `selfCheckPassed` object (banned words, pronoun ratio, char limits…). The HTTP route just surfaces whatever the model *claims*. The model can (and will) mark its own homework as passing while violating a hard constraint (subject > 45 chars, an emoji, two exclamation marks, "curated/elevate/effortless", preheader duplicating subject). An agency ships consistent copy; "trust the model's self-grade" is not consistency. **Fix:** a deterministic, pure `copy-quality.ts` linter (char counts, banned phrases, emoji, `!` count, subject≠preheader, pronoun ratio, wholesale-number/Christina presence) run server-side on every generate + save, surfaced as hard errors vs. warnings. *(Implemented — ROADMAP §D.)*

---

## 4. High-impact gaps (P1 — needed to be "enterprise grade")

### 4.1 Email HTML is fragile in real clients. 🟠
The renderer uses techniques that **silently fail in Outlook (desktop/Windows) and partially in Gmail**:
- **Hero `full_bleed_overlay` uses CSS `background-image`** with text overlaid. Outlook (Word engine) ignores it entirely → text on a blank ivory box. Gmail support is inconsistent. This is the *signature* layout and it's the least reliable.
- `object-fit:cover`, `aspect-ratio`, `display:flex`, `min-height` — **none reliable in Outlook.** The secondary full-bleed image (`height:360px;object-fit:cover`) will distort or crop unpredictably.
- No `<!--[if mso]>` conditionals, no VML for background images, no ghost-table button fallbacks.

An agency's deliverable is "renders correctly in Apple Mail, Gmail, Outlook, iOS." The plan put a Litmus matrix out of scope, but **basic Outlook/Gmail robustness is table stakes** for replacing an agency. **Fix:** harden the export renderer (mso conditionals, VML hero background, bulletproof buttons, drop unsupported CSS in favor of fixed heights / nested tables). *(Roadmap item — partially addressed; full hardening tracked.)*

### 4.2 Phase 6 analytics is a stub — no feedback loop, so it can't "learn." 🟠
`recordOutcome()` is a no-op and there's no capture UI or route. The strategy engine's entire value-over-agency thesis is "it learns from open/click data." Without even *manual* capture, there is no path to v2. **Fix:** results capture route + UI panel, persist to a real outcomes table, wire `recordOutcome`. *(Implemented — ROADMAP §E.)*

### 4.3 Dead code: two renderers / two sources of truth. 🟠
`components/email-template/` (React component tree + `index.tsx` `EmailTemplateRenderer`) is **dead** — only its `CampaignData` *type* is imported by `render-email.ts` (the string-template renderer that's actually used). Maintaining the template now means editing string templates while a parallel, divergent React tree rots. This guarantees drift. **Fix:** delete the React tree, move `CampaignData` to a types module. *(Implemented — ROADMAP §F.)*

### 4.4 Calendar month view is a stub. 🟠
`/marketing/email/calendar` renders "coming in Phase 5." The dashboard's "this week" is fine but there's no month view to plan/scan the cadence. **Fix:** build the month grid. *(Implemented — ROADMAP §G.)*

### 4.5 No way to plan a week from the UI. 🟠
`plan_week` exists only via MCP/chat. A non-chat user has no button to "generate 4 weeks of themes + slots." **Fix:** a "Plan weeks" action on the dashboard. *(Roadmap.)*

### 4.6 Writes are unvalidated. 🟠
`PATCH /campaigns/[id]` whitelists columns (good) but does **no enum/length/URL validation**. You can set `heroVariant:"banana"` (renderer falls back, but DB integrity is lost) or a non-URL CTA. `POST /campaigns` validates audience+date only. **Fix:** validate enum membership + URL shape + length caps on write. *(Roadmap.)*

---

## 5. Correctness bugs & smaller issues (P2)

1. **Dangling prompt placeholder.** `extractPromptBody()` returns the first ``` block of `copy-generation-prompt.md`, which literally begins with `{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md`. That key is **not** in the `fillTemplate` var map for `generateCopy`, so the user message sent to Claude contains the literal string `{{SYSTEM_PROMPT_BASE}}    ← see system-prompt-base.md` (the system prompt is sent separately). Harmless-ish but sloppy and wastes tokens/can confuse the model. Strip unresolved `{{...}}` tokens before sending.
2. **`extractPromptBody` is brittle.** It grabs the *first* fenced block. If anyone reorders a prompt `.md` so an example precedes the prompt, the wrong block is sent silently. Add an explicit delimiter (e.g. a `<!-- PROMPT -->`…`<!-- /PROMPT -->` marker) or a fenced block tagged ` ```prompt `.
3. **Editor "Save" is last-write-wins on the whole row.** `save()` PATCHes the entire local `campaign` object; a concurrent generate (which mutates server-side) can be clobbered if the user then clicks Save with stale fields. Low risk at this volume but worth an `updatedAt` precondition for enterprise.
4. **No optimistic concurrency / audit fields.** No `createdBy`/`updatedBy`/`lastEditedBy`. For an internal multi-user tool (Daniel + designer + maybe a marketer), attribution matters.
5. **`maxDuration = 60`** on `build_campaign_from_idea` equivalent flows: the MCP `build_campaign_from_idea` does **3 sequential Claude calls** (copy + image, plus theme in plan_week). On a cold/over-loaded model these can exceed platform limits. Consider parallelizing independent calls and/or raising/streaming.
6. **`generate-copy` persists brief with `COALESCE(NULLIF(...))`** — it will *not* overwrite an existing brief with a new body value passed in the request body (it only fills when empty). The route comment says body overrides, but the SQL keeps the old non-empty value. Minor mismatch between intent and behavior.
7. **Preheader length guidance inconsistent.** Schema/prompt say ≤90; editor input caps at 90 but label says "50–90"; tool schema says maxLength 110. Pick one.
8. **`heroScrim` default `dark`** is applied even for non-overlay variants (ignored at render, fine) — but the image-prompt tool can write a scrim for a non-overlay hero. Cosmetic.
9. **`catalogImageUrl` reuse for email images works** (paths are `email/{id}/...`), but the helper is named for catalog and strips a legacy `data/images/` prefix — fine today, but an `emailImageUrl` wrapper (as the plan suggested) would be clearer and safer against future prefix logic.
10. **No `robots`/noindex on preview route** — it returns full HTML at an authed path, so low risk, but the export download should set `Content-Disposition: attachment`.
11. **Brand-context loader divergence from plan.** Plan specified `brand-context/index.ts` exposing `loadBrandContext(audience)`; instead loading is inlined in `email-ai.ts` *and* re-implemented in `mcp/tools.ts` (`get_brand_context` reads files directly). Two readers of the same files = drift risk. Centralize.
12. **Missing artifacts from the plan:** `scripts/sync-brand-context.sh`, `brand-context/photography-aesthetic.md` (referenced by the image prompt as "per PHOTOGRAPHY-AESTHETIC.md" but the file isn't in the snapshot), `brand-context/index.ts`.

---

## 6. Security, cost & operations

- **Auth:** `/api/v1/marketing/*` is **not** in `middleware.ts` `publicPaths`, and the matcher covers everything — so these routes require a session. Good. (Verify the MCP surface enforces the same.)
- **No cost guardrails.** AI endpoints have no per-user/day rate limit or token budget. `plan_week` with `weeks=8` + `createCampaigns` fans out to a theme call + (8×2) campaign rows; `build_campaign_from_idea` is 3 calls each. A loop or fat-fingered call can run up spend. Add simple guardrails + log `usage` (it's returned but discarded).
- **No structured logging/metrics.** `usage` tokens come back from `callClaude` but aren't persisted; there's no per-campaign cost/története. For an internal tool replacing a $3k line item, *showing the $ saved* is a feature.
- **Secrets:** relies on `ANTHROPIC_API_KEY` (correct, env-based). Fine.

---

## 7. Differentiation — how to actually be *better* than the agency

The agency's moat is taste + reliability + reporting. This tool's moat should be **speed, integration, and a learning loop**:

1. **Ground copy in the *real* catalog (Shopify).** `briefProductHook` is free text today. Validate it against the live product catalog (this repo already has Shopify + a `products` table): pull the real SKU name, price, colorways, and **inventory** so copy never promotes a sold-out frame and CTAs deep-link to the real PDP. An agency can't do that in 30 seconds; this can. *(High-value roadmap item.)*
2. **Close the learning loop.** Capture results → weight the rotation → show "angle X opens 18% better for wholesale." This is the v2 the strategy engine is already shaped for.
3. **One-click week.** "Plan + write + brief next 4 weeks" from a single button/chat turn, then a human reviews. Agency turnaround is days; this is minutes.
4. **Deliverability & client QA built in.** Even a lightweight inline lint ("subject too long, two exclamation marks, low contrast scrim") plus Outlook-robust HTML beats the typical agency's inconsistent hand-offs.
5. **Cost transparency.** A small "this week cost $0.42 in AI vs. $750 of agency retainer" panel makes the ROI undeniable.

---

## 8. Prioritized fix list (ties to ROADMAP.md)

| # | Item | Sev | Status this pass |
|---|---|---|---|
| A | Export route (Omnisend HTML + Faire JSON) + UI + status→exported | P0 | ✅ Implemented |
| B | Advance/revert endpoint + per-stage validation + status stepper | P0 | ✅ Implemented |
| C | Fix model id → env-overridable valid default | P0 | ✅ Implemented |
| D | Deterministic copy-QA linter, enforced server-side | P0 | ✅ Implemented |
| E | Send-results capture (route + UI) + wire learning loop | P1 | ✅ Implemented |
| F | Delete dead React template tree; one source of truth | P1 | ✅ Implemented |
| G | Calendar month view | P1 | ✅ Implemented |
| H | Tests (strategy, renderer, linter, export) | P1 | ✅ Implemented |
| I | Outlook/Gmail HTML hardening (VML hero, mso, bulletproof CTA) | P1 | ✅ Implemented (export renderer) |
| J | Shopify catalog grounding for product hooks | P2 | tracked |
| K | Write-time validation, audit fields, cost logging | P2 | tracked |
| L | Plan-week UI, sync-brand-context.sh, photography-aesthetic.md, central brand loader | P2 | tracked |

See **ROADMAP.md** for the sequenced build plan and acceptance criteria.
</content>
</invoke>
