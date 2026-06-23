# Marketing Email Assistant — Module Guide

The integrated, AI-assisted email pipeline: theme ideation → copy →
image briefing → designer handoff → preview → **export to image**.

> Scope note (per Daniel, 2026-06-23): we are NOT building ESP export
> (Omnisend/Faire HTML), send-results/analytics, email-module unit
> tests, or Outlook/email-client robustness yet. Export is to an image
> for now. See `REVIEW.md` for the full audit and `ROADMAP.md` for the
> deferred items.

## Pipeline (10 stages)

`idea → themed → copy_pending → copy_review → image_pending →
image_review → preview_ready → exported → sent → analyzed`

Movement is gated (`lib/workflow.ts`): each forward step validates its
requirements; backward is always allowed. The editor shows a stepper.
Exporting an image marks the campaign `exported`.

## Where things live

| Concern | File |
|---|---|
| DB schema (3 tables) | `schema/email-campaigns.ts` + boot block in `src/lib/db.ts` |
| Strategy/rotation engine (pure) | `lib/email-strategy.ts` |
| Week planning (shared by route + MCP) | `lib/plan-week.ts` |
| AI calls (Claude tool-use) | `lib/email-ai.ts` |
| Model selection (env) | `lib/ai-model.ts` |
| Brand-context loader (single reader) | `brand-context/index.ts` |
| Copy QA linter (pure) | `lib/copy-quality.ts` |
| Write-time validation (pure) | `lib/campaign-validation.ts` |
| Workflow gates (pure) | `lib/workflow.ts` |
| Email renderer (single render path) | `lib/render-email.ts` |
| Template data type (single source) | `lib/email-template-types.ts` |
| MCP tools (chat surface) | `mcp/tools.ts` |
| UI | `src/app/(dashboard)/marketing/email/*` |

## HTTP API (`/api/v1/marketing/email`)

| Verb | Path | Purpose |
|---|---|---|
| GET/POST | `/campaigns` | list (filters) / create |
| GET/PATCH/DELETE | `/campaigns/[id]` | CRUD (PATCH is validated) |
| POST | `/campaigns/[id]/generate-copy` | Claude copy + server QA lint |
| POST | `/campaigns/[id]/generate-image-prompts` | Higgsfield briefs |
| POST | `/campaigns/[id]/upload-image` | designer render upload |
| GET | `/campaigns/[id]/preview` | rendered HTML (editor iframe + image capture source) |
| GET | `/campaigns/[id]/validate` | deterministic QA + readiness |
| POST | `/campaigns/[id]/advance` | move stage (gated) |
| POST | `/themes/generate`, GET `/themes` | themes |
| POST | `/plan-week` | self-serve N-week planning |
| GET | `/designer-queue` | image-pending/review queue |

**Export is client-side**: the editor renders the email at 600px in an
offscreen iframe and rasterizes it to PNG/JPG with `html-to-image`
(no server browser). Then it best-effort marks the campaign `exported`.

## Quality gates

- **Copy QA** (`copy-quality.ts`) runs server-side on every generate +
  save: subject ≤45, preheader 50–90 & ≠ subject, no emoji, ≤1 `!`,
  brand banned-words, hero ≤6 words, reader-as-hero pronoun ratio,
  wholesale-has-number, sentence-case CTAs, valid CTA URLs. Errors block
  confidence; warnings advise. The model's `selfCheckPassed` is advisory.
- **Write validation** (`campaign-validation.ts`) rejects bad enums /
  non-http CTA URLs / malformed dates / pathological lengths on PATCH.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for all AI calls |
| `MARKETING_EMAIL_MODEL` / `ANTHROPIC_MODEL` | `claude-opus-4-1-20250805` | model id (bump when account has a newer one) |
| `NEXT_PUBLIC_IMAGE_BASE_URL` | prod CDN | image URL base |

## Brand context

Snapshot in `brand-context/` (brand-bible, wholesale-voice,
visual-guidelines, photography-aesthetic). Refresh from Drive with
`scripts/sync-brand-context.sh`. The image-prompt generator injects the
photography aesthetic so every brief matches the look.
