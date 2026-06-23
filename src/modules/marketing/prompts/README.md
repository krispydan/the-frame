# Jaxy Marketing Email Prompt Library

> **Status:** v1 (Daniel-approved 2026-06-23). Lives in DB at runtime
> (`marketing_prompts` table, future), with these files as the
> canonical defaults + version history.

This directory is the source of truth for every prompt the Marketing
Email Assistant sends to Claude. Each prompt is **modular**: it
composes a base brand context with task-specific instructions and a
structured JSON output schema.

## Why versioned files (not just DB rows)

Per Daniel's choice: prompts live in the DB at runtime so non-engineers
can iterate in the app, but every prompt has a fallback default
sourced from these files. When someone changes a prompt in the app and
it underperforms, we git-diff against the file to see what changed.

When you ship a new "v2" of a prompt:
1. Edit the file here (creates a clean git diff for review)
2. The next run loads from DB, falling back to the file default
3. Compare output quality against historical campaigns
4. If v2 wins, mark it default; if v1 wins, revert

## File layout

```
prompts/
  README.md                                    ← you are here
  system-prompt-base.md                        ← brand context loader (shared)
  theme-generation-prompt.md                   ← weekly theme batch
  copy-generation-prompt.md                    ← per-email subject + body + CTAs
  image-prompt-generation.md                   ← Higgsfield briefs per variant
  campaigns/                                   ← 5 worked examples
    01-retail-product-launch.md
    02-retail-seasonal-moment.md
    03-retail-customer-story.md
    04-wholesale-stock-drop.md
    05-wholesale-faire-event.md
```

## Composition

Every Claude call composes these layers:

1. **System prompt base** — voice anchor, banned words, brand
   facts. Loaded from `system-prompt-base.md` + the matching
   audience block from `brand-context/brand-bible.md` or
   `brand-context/wholesale-voice.md`.
2. **Task-specific prompt** — `theme-generation-prompt.md`,
   `copy-generation-prompt.md`, etc.
3. **Per-campaign variables** — theme, audience, scheduled date,
   variant choices.
4. **Output JSON schema** — Claude tool-use forced structured
   output (see each task prompt for the schema).

## How the AI gut-checks itself

Each task prompt ends with a self-check checklist drawn from the
brand bible. The model is instructed to run the check against its
output and revise BEFORE returning. This isn't a hack — it
materially improves first-pass quality.

## Refinement log

Each task prompt file has an "Iteration history" section at the
top showing what changed across versions and why. When you edit
a prompt, add an entry: date, what changed, the campaign that
exposed the gap.

The goal: this library is a living document the way the brand bible
is. Every weak output is a data point that improves the next version.
