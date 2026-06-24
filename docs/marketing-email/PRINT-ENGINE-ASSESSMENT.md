# Printing / Render Engine — 5-Campaign Test & Action Plan

**Target:** `src/modules/marketing/lib/render-email.ts` — the pure string-template renderer that "prints" a campaign row into the final email HTML. This is the half of the pipeline the earlier `OUTPUT-ASSESSMENT.md` (copy/prompt engine) never stress-tested.
**Date:** 2026-06-24
**Method:** Five campaigns authored to mirror the real generate-copy → designer handoff output (Jaxy reading/blue-light glasses voice, sentence case), deliberately spanning **every** hero / section-A / secondary / section-B variant plus edge cases (no-image draft, special characters, disabled section, missing CTA URL, one-sentence pullquote body, 89-char headline). Each rendered through `renderEmailHtml()` — the exact function the editor preview iframe and the client-side image export both consume — then audited structurally **and parsed with `jsdom`** (a WHATWG-compliant HTML parser) to read back the *computed* result a real browser would produce. No API key needed — the renderer is pure.

> Note on channel: the chosen output channel is **image export** (render HTML in the browser → rasterize with `html-to-image`) and the in-app preview iframe. So "does it survive Outlook" is explicitly out of scope (parked). The bar here is: **does the HTML render correctly in a real browser engine** — because that browser is what produces both the preview and the exported image.

---

## 0. TL;DR

The five-variant matrix renders the right *structure* every time — correct blocks, correct dispatch, disabled sections omitted, HTML escaping of copy is flawless (`<No code needed>` → `&lt;…&gt;`, `&`/`"` in alt text correctly entity-encoded), the two-column→centered fallback fires correctly, and the pullquote heuristic picks a sensible sentence.

**But there is one critical, pervasive bug that breaks typography on every single email**, plus four real quality gaps. The critical one alone is the difference between "looks like a $3k/mo agency made it" and "looks like a broken template."

---

## 1. 🔴 CRITICAL — Inline styles are truncated; headline & button CSS is silently dropped

**Every** styled element that declares a font (48 occurrences across the 5 test emails) is broken.

The font stacks are defined with **double quotes** around multi-word family names:

```js
const F = {
  display: '"Instrument Sans", -apple-system, …, "Helvetica Neue", Arial, sans-serif',
  body:    '"Instrument Sans", -apple-system, …, "Helvetica Neue", Arial, sans-serif',
  pullquote: '"Syne", Georgia, "Times New Roman", serif',
};
```

…and interpolated **unescaped** into double-quoted `style="…"` attributes:

```js
`<h1 … style="font-family:${F.display};font-size:44px;…;color:${C.ivory};margin:0 0 12px;">`
```

By the HTML spec a double-quoted attribute value ends at the **first inner `"`**. So the parser reads the `<h1>` style as **just `font-family:`** and treats the rest (`Instrument Sans"`, `font-size:44px`, `color`, `margin`, …) as ~13 garbage attributes. Verified with jsdom:

```
HERO <h1>:
  style attr  : "font-family:"
  .fontSize   : (lost)          ← should be 44px
  .color      : (lost)          ← should be ivory/espresso
  .margin     : (lost)
  stray attrs : instrument, sans",, -apple-system,, "helvetica, neue",, … font-size:44px;…
```

**Impact, by element:**
- **Headlines (`<h1>`), section headings, body `<p>`, pull quotes** — font-family is the *first* declaration, so the entire style is dropped. They fall back to browser defaults: wrong size (~32px default `<h1>` instead of 44px), wrong color (default black instead of brand espresso/ivory), wrong weight, wrong margins. The whole email's typography is off.
- **CTA buttons** — font-family is *mid-declaration*, so `display/background/color/text-decoration` survive but **`padding:13px 28px`, `border-radius:999px`, `font-size`, `font-weight`, `letter-spacing` are lost.** The "pill" renders as a cramped, square-cornered terracotta text label — not a button.

This hits the editor preview **and** every exported image (both are browser-rendered). It's the kind of defect that's easy to miss at a glance (things are *colored*, just not *styled*), which is exactly why an automated render test catches it and three rounds of eyeballing didn't.

**Fix:** use **single quotes** around font-family names (valid CSS, safe inside double-quoted HTML attributes and inside `<style>`). One 4-line change at the source fixes all 48 occurrences.

---

## 2. 🟠 HIGH — Dead CTA buttons (`href="#"`) when no URL is set

When copy generation / hand-edits leave a CTA URL empty, the dispatcher defaults it to `"#"` and still renders a fully-styled button (e.g. hero defaults the label to "Find your pair" → a button that links nowhere). Sending customers a button that does nothing is worse than no button.

**Fix:** the renderer should **fail safe — omit the CTA entirely when there's no real URL** (empty or `"#"`), rather than emit a dead button. The existing readiness/validate step already flags the missing URL to the operator, so nothing is hidden.

---

## 3. 🟡 MEDIUM — Full-bleed hero text is top-aligned, not centered

`heroFullBleedOverlay` lays content into a 460px-tall cell with `padding:40px 36px 0` and no vertical centering, so the headline/subtitle/CTA cling to the **top third** and leave a large empty band of image below. Composition reads as "unfinished." The dark/light scrim also only covers the top 55%, which matched top-aligned text but won't match centered text.

**Fix:** vertically center the overlay content (`vertical-align:middle`, symmetric padding) and switch the scrim to a **center-weighted** gradient so the darkening/lightening sits behind the text wherever it lands.

---

## 4. 🟡 MEDIUM — `scrim:"none"` over an image can be illegible

The full-bleed hero only applies a text-shadow when `scrim:"dark"`. With `scrim:"none"` **and** an image present, the renderer paints dark espresso text directly over the photo with no scrim and no shadow — unreadable over a busy/dark image. The renderer trusts the strategy to never pick that combination; it shouldn't have to.

**Fix:** make the renderer legibility-safe regardless of input — when an image is present, (a) always apply a text-shadow, and (b) treat `scrim:"none"` as a subtle **light** scrim so the dark text always has a lightened backdrop. Explicit `dark`/`light` choices are preserved.

---

## 5. 🟡 MEDIUM — Pullquote heuristic degenerates on short bodies

`sectionAWithPullquote` promotes the single **longest sentence** to a pull quote and renders the rest below it. On a **one-sentence** body the pull quote becomes the *entire* body with no supporting text beneath it (verified on campaign 5) — a lone floating italic line. On a two-sentence body it can strand a short fragment.

**Fix:** only use the pullquote layout when the body has **≥2 sentences and a non-empty remainder**; otherwise fall back to the clean centered layout. Guarantees the pull quote always has supporting copy.

---

## 6. Lower-severity / informational

- **🟢 LOW — long-headline overflow.** An 89-char hero headline at 44px wraps to 3+ lines and can overflow the 460px hero / push the CTA below the fold on mobile. Real fix belongs in the **copy-quality linter** (a headline-length budget) rather than the renderer — noted as a follow-up, not built in this pass to keep it scoped to the printing engine.
- **🟢 LOW — font URL `&` not entity-encoded.** `FONT_LINK` contains raw `&family=` / `&display=`. Browsers tolerate it, but it's not well-formed HTML. Trivial to `&amp;`-encode.
- **ℹ️ INFO — browser-only CSS** (`background-image` on `<td>`, `display:flex`, `aspect-ratio`, `object-fit`). Correct for the image-export channel; would break in Outlook/many email clients. **Out of scope** (Outlook robustness parked). Documented so it's a known, deliberate trade-off, not a surprise.
- **ℹ️ INFO — stale doc comment.** `renderSectionHtml`'s comment still describes Playwright screenshotting (removed last session); the path is now client-side `html-to-image`.

---

## 7. What's genuinely good (don't regress)

- Variant dispatch is correct for all 3×2×3×2 combinations; disabled sections are cleanly omitted.
- Copy escaping is airtight (`esc`/`escAttr` on every text + alt insertion).
- Missing-image placeholders are graceful and dimensioned.
- Two-column→centered fallback when only one paragraph is present.
- Mobile media query clamps headline/padding/grid sensibly.

---

## 8. Action plan (this pass)

| # | Fix | Severity | Scope |
|---|-----|----------|-------|
| 1 | Single-quote font stacks → stop style truncation | 🔴 Critical | `render-email.ts` `F` |
| 2 | Omit CTA when no real URL (no dead buttons) | 🟠 High | `ctaAnchor()` + dispatch |
| 3 | Vertically center full-bleed hero + center-weighted scrim | 🟡 Med | `heroFullBleedOverlay` / `scrimGradient` |
| 4 | Legibility-safe scrim/shadow when an image is present | 🟡 Med | `heroFullBleedOverlay` |
| 5 | Pullquote layout only with ≥2 sentences + remainder | 🟡 Med | `sectionAWithPullquote` |
| 8 | `&amp;`-encode the font URL | 🟢 Low | `FONT_LINK` |
| 9 | Fix stale Playwright doc comment | ℹ️ | `renderSectionHtml` |

**Deferred follow-ups (noted, not built here):** headline-length budget in `copy-quality.ts` (#6); a committed render smoke-test (email-module tests are parked — this assessment's harness lived in scratch and would have caught #1 on day one).

---

## 9. Verification (after build)

Re-ran the identical 5-campaign harness + jsdom read-back against the patched renderer:

**Critical (#1) — fixed, proven by parser:**
- The truncation signature (`style="…"` immediately followed by a stray letter) dropped from **10–11 per email to 0** across all five.
- **0** double-quoted `font-family:"` remain; all **49** font declarations are now single-quoted.
- jsdom reads the hero `<h1>` style back fully intact: `font-size: 44px`, `color: rgb(255,253,240)`, `margin`, `text-shadow` all present, **zero stray attributes** (was ~13). The CTA pill's `style` attribute now round-trips complete through `padding:13px 28px;border-radius:999px`.

**The rest:**
- #2 — campaign 5's URL-less hero CTA is now **omitted** (no dead button); the section-B CTA with a real URL still renders.
- #3/#4 — full-bleed hero content is `vertical-align:middle` in the 460px cell with a center-weighted scrim; text over an image always gets a shadow, and `scrim:"none"`-over-image is upgraded to a light scrim.
- #5 — campaign 5's one-sentence section-A body now falls back to the centered layout (no lone floating pull quote).
- #8/#9 — font URL `&amp;`-encoded; doc comment updated to client-side `html-to-image`.

**Audit totals:** went from **5 errors / 3 warnings → 0 errors / 1 warning**. The one remaining warning is the 89-char headline overflow (campaign 5) — deliberately a copy-side concern, deferred to the linter follow-up (#6).

**Test method note:** the harness was a throwaway script run from a scratch directory (email-module tests are parked, so nothing was committed). It is reproducible from this document's method section; a committed render smoke-test remains a recommended — currently parked — follow-up, and would have caught #1 immediately.
