# Output Assessment — 3-Campaign Test Run

**Date:** 2026-06-24
**Method:** Ran a realistic week (week of 2026-06-29, 4th-of-July window) through the system. The **deterministic parts ran live** — the strategy engine (`recommendForWeek`) assigned slots/variants/angles, and the real copy-QA linter (`lintCopy`) scored the output. The **LLM step was reproduced faithfully** against the actual v5 `copy-generation-prompt.md` + `system-prompt-base.md` + brand voice (the sandbox has no `ANTHROPIC_API_KEY`, so the live endpoint couldn't be hit — but the prompts/linter/strategy that shape the result are exercised exactly).

Campaigns tested (the mix Daniel sends in a week):
1. **Retail · Mon 06-29** — Sunday Drive, long-weekend angle
2. **Retail · Thu 07-02** — Main Character, on-model/curiosity angle
3. **Wholesale · Tue 06-30** — restock before July 4, Christina

---

## 1. Headline result

The generated copy is **genuinely good** — on-voice, specific, customer-as-hero, screenshot-worthy headlines. It would beat a generic agency draft on voice fidelity and turnaround. **But the QA layer that's supposed to guarantee that quality is misaligned with the brand's own rules**, and the single-campaign path has no defense against cross-email sameness. The fixes are small and high-trust.

Linter scores (live): C1 **100**, C2 **95** (1 warning), C3 **85 — FAILED** (1 error).

---

## 2. 🔴 The QA linter false-positives on the brand's own documented patterns

This is the most important finding: **two of three campaigns were dinged for doing exactly what the prompt tells the AI to do.** An operator who sees the QA gate flag the AI's correct output will stop trusting the gate.

### 2.1 `mailto:` CTAs fail validation (C3 wholesale — hard error)
`copy-quality.ts` requires CTA URLs to be `http(s)` or `#`. But the **wholesale voice's documented CTA is a mailto** — worked example #4 in `copy-generation-prompt.md` literally uses `mailto:christina@getjaxy.com?subject=Starter%20mix`. So the linter throws `cta_url_invalid` and marks the campaign **not OK** on a perfectly valid, on-brand wholesale email. **Fix:** allow `mailto:` and `tel:` schemes.

### 2.2 Product-named CTAs flagged as Title Case (C2 retail — warning)
"Shop the Main Character" warns `cta_title_case`. But product-named CTAs are explicitly endorsed (worked example #3 uses this exact label). The title-case heuristic can't tell a proper-noun product name from shouting. **Fix:** don't flag a CTA when its capitalized words are a proper noun / product name (e.g. ignore the leading invitation verb + treat subsequent capitalized tokens as names), or only warn on genuine ALL-Title-Case with no function words.

---

## 3. 🟡 The linter under-enforces the documented rules

The deterministic linter is the *enforcement* of the prompt's *intent* — but it's a strict subset:

- **Banned-word coverage gap.** The prompt's banned list (`system-prompt-base.md`) is ~40 phrases; the linter's `BANNED_PHRASES` is ~20. Copy using **"journey," "experience," "staple," "wardrobe essential," "leverage," "synergy," "ecosystem," "treat yourself," "affordable luxury," "gender-neutral," "sustainable/conscious/mindful," "great news," "crafted in LA"** passes the linter today. The gate is softer than the prompt claims.
- **The A/B alternate is unlinted.** `subjectAlt`/`preheaderAlt` (added this session) get **zero** QA — they could exceed 45 chars, dupe the primary, or contain banned words and still pass. If the operator swaps the alt to primary, unchecked copy ships.
- **No wholesale sign-off check.** The prompt requires "— Christina" on wholesale; the linter never checks it (it only checks for a number). A wholesale email with no human sign-off passes.

---

## 4. 🟡 Cross-campaign sameness has no guardrail in the single-campaign path

Generating three campaigns back-to-back, the AI tells showed up:
- **"doing the heavy lifting"** appeared in **both** C2 and C3.
- Near-identical **triadic list rhythm** ("Honey for the…, Midnight for the…, Crystal for the…" / "the cooler, the flag-print napkin, the sunburn") in every Section B.
- Heavy **em-dash** reliance in every section.

The prompt *has* a "soft variations — avoid sameness across consecutive emails" section, but it only works **"if you have access to the last 3 emails."** The single-campaign `generate-copy` route **passes no recent-email context**, so the guidance is dead on that path. At 4 emails/week, this is precisely the "all the emails feel same-y" problem an agency avoids. **Fix:** `generate-copy` should fetch the last ~3 sent/written subjects + hero headlines for the audience and pass them into the prompt so the variation guidance fires.

---

## 5. 🟢 Strategy: a week's four emails share one hero variant

The live engine assigned `image_75_solid` to **all four** emails the week of 06-29 (layout rotates *by week*, both slots inherit it). The self-review claims the rotation prevents "two emails with the same hero variant" — true across weeks, false within a week. Four same-variant emails in one week reads monotone. **Fix:** offset the hero variant by slot (and/or audience) so a single week mixes at least two hero layouts.

Minor: the subject-angle rotation can contradict the slot's image style (retail slot 1 this week = flat-lay image but `lifestyle_sensation` angle), because angle rotates by week+slot independently of the image-style/slot lock. Low impact.

---

## 6. Verdict on the copy itself

If I were Daniel reading these three: **I'd send C1 as-is, send C3 after the mailto fix, and lightly edit C2's repeated phrase.** That's a strong place to be — the bottleneck is no longer "is the copy good" but "does the QA gate trust good copy, and does the inbox avoid sameness over a month." Both are mechanical fixes, not voice problems.

---

## 7. Improvement plan (prioritized, all in Daniel's scope)

| # | Fix | Sev | Effort | Status |
|---|---|---|---|---|
| 1 | CTA validation: allow `mailto:`/`tel:` (linter **+** write-validation) | 🔴 | XS | build now |
| 2 | CTA title-case heuristic: stop flagging product-named CTAs | 🔴 | S | build now |
| 3 | Expand linter banned list to match `system-prompt-base.md` | 🟡 | S | build now |
| 4 | Lint `subjectAlt`/`preheaderAlt` (limits, banned words, ≠ primary) | 🟡 | S | build now |
| 5 | Wholesale: warn when no "— Christina" sign-off | 🟡 | XS | build now |
| 6 | Strategy: offset hero variant by slot so a week isn't monotone | 🟢 | S | build now |
| 7 | `generate-copy` passes last-3 subjects/headlines → variation guidance fires | 🟡 | M | build now |

Items 1–6 are small, evidence-backed, and low-risk. Item 7 is the highest-value anti-sameness lever and is a moderate wiring change. All seven are built in the commit that follows this doc.
