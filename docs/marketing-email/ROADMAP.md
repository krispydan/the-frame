# Marketing Email Assistant — Roadmap to Enterprise-Grade

> **Scope update (2026-06-23, per Daniel):** Export to Omnisend/Faire,
> send-results/analytics (Phase 6), email-module unit tests, and
> Outlook/email-client robustness are **deferred** — not needed yet.
> Export is to an **image** for now (client-side render → PNG/JPG).
> Those features were removed from the codebase (recoverable via git)
> to keep it lean; the notes below are retained as the future plan.

Companion to `REVIEW.md`. This is the sequenced plan to take the v1 from "strong but unfinished" to "a credible, better-than-agency replacement." Items A–H are implemented in this pass; I–L are specified for follow-up with acceptance criteria.

Guiding principle: **finish the pipeline first** (so a campaign can actually reach an inbox), **then make it trustworthy** (validation + robust rendering + tests), **then make it learn** (analytics loop + catalog grounding).

---

## Phase 5 (completed this pass): finish the pipeline

### A. Export — Omnisend HTML + Faire JSON  ✅
- **Lib:** `lib/email-export.ts` — `buildOmnisendHtml(campaign)` (standalone, client-hardened HTML) and `buildFaireBlocks(campaign)` (`{subject, preheader, blocks[]}`).
- **Route:** `GET /api/v1/marketing/email/campaigns/[id]/export?format=omnisend|faire`.
  - `omnisend` → `text/html` with `Content-Disposition: attachment; filename="<utm>.html"`.
  - `faire` → `application/json` with the structured blocks + a flattened plain-text body for paste.
  - Sets status → `exported` (only forward, never backward) and records `exported_html_path` semantics via `aiCopyPromptVersion`-style metadata is untouched; we set status only.
- **UI:** editor header gets **Export ▾** (Omnisend / Faire) + a readiness check (warns if copy/images missing).
- **Acceptance:** `curl '.../export?format=omnisend' -o out.html` opens in a browser and matches the preview; `?format=faire` returns valid JSON; status becomes `exported`.

### B. Advance / revert + per-stage validation + status stepper  ✅
- **Route:** `POST /api/v1/marketing/email/campaigns/[id]/advance` `{direction?: "forward"|"back", to?: status}`.
  - Forward validates the **gate** for the target stage (e.g. `→copy_review` requires subject+hero+sections; `→preview_ready` requires images or an explicit "text-only" ack; `→exported` requires preview_ready; `→sent` requires exported).
  - Returns `{ok, status, blocked?: string[]}` so the UI can show *why* it's blocked.
- **UI:** left-rail **status stepper** (10 stages) in the editor with current stage highlighted, next/prev buttons, and blocked-reason tooltips.
- **Acceptance:** a fresh campaign can be walked idea→…→sent with each gate enforced; skipping a gate returns `blocked`.

### C. Model configuration  ✅
- **`lib/ai-model.ts`** (or constant in `email-ai.ts`): `MARKETING_EMAIL_MODEL` env, default a known-valid dated id; logged once at first use. No more `claude-opus-4-7`.
- **Acceptance:** generation works against the default; setting the env var overrides it.

### D. Deterministic copy-QA linter  ✅
- **`lib/copy-quality.ts`** — pure `lintCopy(campaignLike, audience): {errors[], warnings[], score}`. Checks: subject ≤45, preheader 50–90 & ≠ subject & not a prefix dup, no emoji, ≤1 `!` per email, banned phrases (curated/premium/luxury/elevate/effortless/game-changer/must-have/introducing/we're so excited/made in la…), hero headline ≤6 words, reader-as-hero pronoun ratio heuristic, wholesale must contain a number, etc.
- **Wired into:** `generate-copy` route + MCP `save_draft` + a new `GET .../validate` and surfaced in the editor as red (errors) / amber (warnings). Self-reported `selfCheckPassed` is kept but demoted to advisory.
- **Acceptance:** known-bad copy ("Introducing our curated, must-have collection!!") yields the expected errors; clean copy passes.

### E. Send-results capture + learning-loop wiring  ✅
- **Table:** `marketing_email_strategy_outcomes` (boot block) keyed by campaign + the strategy dimensions (layout/imageStyle/subjectAngle) + opens/clicks/recipients — the substrate the v2 recommender will read.
- **Route:** `POST/GET /api/v1/marketing/email/campaigns/[id]/results` — persist to `marketing_email_send_results`, derive rates, and call `recordOutcome()` which now writes the outcomes table.
- **UI:** a "Results" panel on the editor (shown when status ∈ exported/sent/analyzed) to enter recipients/opens/clicks per platform; advances status → `analyzed`.
- **Acceptance:** entering results persists both tables, computes open/click rate, and `analyzed` status is set.

### F. One source of truth for the template  ✅
- Delete `components/email-template/` React tree. Move `CampaignData` into `lib/email-template-types.ts`. `render-email.ts` + `email-export.ts` import from there.
- **Acceptance:** preview + export still render; no imports of the deleted tree remain; typecheck clean.

### G. Calendar month view  ✅
- Replace the stub with a month grid (audience pill + subject + status dot per cell, prev/next month, click → editor). Reuses the campaigns list API with `from`/`to`.
- **Acceptance:** navigating months shows scheduled campaigns on the right days.

### H. Tests  ✅
- `src/__tests__/marketing/email-strategy.test.ts` — rotation determinism, slot dates, cadence.
- `src/__tests__/marketing/copy-quality.test.ts` — each lint rule.
- `src/__tests__/marketing/render-email.test.ts` — every variant renders, escaping, scrim, placeholders.
- `src/__tests__/marketing/email-export.test.ts` — Omnisend HTML completeness, Faire block shape.
- **Acceptance:** `npm test` green for the new suites.

---

## Phase 6 progress

Completed since the initial pass:
- **Self-serve week planning** — `lib/plan-week.ts` shared by the MCP
  tool + `POST /plan-week`; "Plan weeks" action on the dashboard.
- **ROI + learning surface** — `GET /insights` ("$ saved vs. agency" +
  best-performing strategy dimensions) shown on the dashboard.
- **Brand-context hygiene** — central `brand-context/index.ts` loader,
  added `photography-aesthetic.md` (injected into image briefs), and
  `scripts/sync-brand-context.sh`.
- **Write-time validation** — `lib/campaign-validation.ts` enforced on
  PATCH (enums / CTA URLs / dates / lengths).

### I. Email-client rendering hardening (Outlook/Gmail)  — export renderer hardened this pass; full matrix tracked
- VML background for the hero overlay so Outlook shows the image; `<!--[if mso]>` ghost-table buttons; replace `object-fit/aspect-ratio/flex/min-height` with fixed heights + nested tables; `mso-line-height-rule:exactly`.
- Stretch: integrate a Litmus/Email-on-Acid check in CI (out of original scope, but this is what an agency charges for).
- **Acceptance:** hero image + CTA render in Outlook 2019 and Gmail (manual or automated screenshots).

### J. Shopify catalog grounding (the differentiator)
- Resolve `briefProductHook` against the live `products` table / Shopify: inject real SKU name, price, colorways, **stock status**, and PDP URL into the copy + CTA-URL defaults. Block/flag promoting out-of-stock frames.
- **Acceptance:** a brief naming a real SKU produces copy with the correct price and a working PDP deep link; an out-of-stock SKU raises a warning.

### K. Hardening: validation, audit, cost
- ✅ Write-time enum/URL/length validation on PATCH.
- ✅ Dashboard "$ saved vs. agency" panel (`/insights`).
- Remaining: `createdBy`/`updatedBy` audit columns + `updatedAt`
  precondition (optimistic lock) on save; persist Claude `usage` per
  campaign for true AI-cost tracking; per-user/day AI rate limit + budget.

### L. Plan-week UI + brand-context hygiene  ✅
- ✅ Dashboard "Plan weeks" action over the shared `planWeeks()` lib.
- ✅ Central `brand-context/index.ts` consumed by `email-ai.ts` + MCP.
- ✅ `scripts/sync-brand-context.sh` + `brand-context/photography-aesthetic.md`.
- ✅ Strip unresolved `{{...}}` from prompts. Remaining: tagged
  ` ```prompt ` fences for fully explicit prompt extraction.

---

## Sequencing rationale

1. **A–C unblock the product** (export + advance + working model) — without these it literally cannot do its job.
2. **D + H make it trustworthy** (enforced QA + tests) — required before anyone relies on it for live sends.
3. **E seeds the learning loop**; **F/G remove debt & finish UX**.
4. **I–L** turn "works" into "beats the agency": robust rendering, real catalog data, cost proof, and operational hardening.
