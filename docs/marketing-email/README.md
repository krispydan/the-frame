# Marketing Email Assistant — Module Guide

The integrated, AI-assisted email pipeline that replaces Jaxy's email
agency: theme ideation → copy → image briefing → designer handoff →
preview → **export to Omnisend/Faire** → results capture → learning loop.

See `REVIEW.md` for the audit and `ROADMAP.md` for what's done / next.

## Pipeline (10 stages)

`idea → themed → copy_pending → copy_review → image_pending →
image_review → preview_ready → exported → sent → analyzed`

Movement is gated (`lib/workflow.ts`): each forward step validates its
requirements; backward is always allowed. The editor shows a stepper.

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
| Email renderer (preview + export targets) | `lib/render-email.ts` |
| Template data type (single source) | `lib/email-template-types.ts` |
| Export (Omnisend HTML / Faire JSON) | `lib/email-export.ts` |
| Learning-loop persistence | `lib/strategy-outcomes.ts` |
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
| GET | `/campaigns/[id]/preview` | rendered HTML for the iframe |
| GET | `/campaigns/[id]/validate` | deterministic QA + readiness |
| POST | `/campaigns/[id]/advance` | move stage (gated) |
| GET | `/campaigns/[id]/export?format=omnisend\|faire` | export + → exported |
| GET/POST | `/campaigns/[id]/results` | capture metrics → learning loop |
| POST | `/themes/generate`, GET `/themes` | themes |
| POST | `/plan-week` | self-serve N-week planning |
| GET | `/designer-queue` | image-pending/review queue |
| GET | `/insights` | ROI ($ saved) + best strategy dimensions |

## Quality gates

- **Copy QA** (`copy-quality.ts`) runs server-side on every generate +
  save: subject ≤45, preheader 50–90 & ≠ subject, no emoji, ≤1 `!`,
  brand banned-words, hero ≤6 words, reader-as-hero pronoun ratio,
  wholesale-has-number, sentence-case CTAs, valid CTA URLs. Errors block
  confidence; warnings advise. The model's `selfCheckPassed` is advisory.
- **Write validation** (`campaign-validation.ts`) rejects bad enums /
  non-http CTA URLs / malformed dates / pathological lengths on PATCH.
- **Email rendering** has an `export` target that hardens HTML for
  Outlook/Gmail (mso conditionals, VML bulletproof CTA + hero
  background, hidden preheader).

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | required for all AI calls |
| `MARKETING_EMAIL_MODEL` / `ANTHROPIC_MODEL` | `claude-opus-4-1-20250805` | model id (bump when account has a newer one) |
| `MARKETING_AGENCY_MONTHLY` | `3000` | agency retainer for ROI math |
| `MARKETING_EMAILS_PER_MONTH` | `16` | emails/month for per-email cost |
| `NEXT_PUBLIC_IMAGE_BASE_URL` | prod CDN | image URL base |

## Tests

`npm test` (vitest). Marketing suites in `src/__tests__/marketing/`:
strategy, copy-quality, render-email, email-export, workflow,
campaign-validation (66 tests).

## Brand context

Snapshot in `brand-context/` (brand-bible, wholesale-voice,
visual-guidelines, photography-aesthetic). Refresh from Drive with
`scripts/sync-brand-context.sh`. The image-prompt generator injects the
photography aesthetic so every brief matches the look.
