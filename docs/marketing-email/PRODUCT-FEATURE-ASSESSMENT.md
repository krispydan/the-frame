# Featured-Products in Email AI — Test Report & Fixes

**Date:** 2026-06-24
**Feature:** Some campaigns feature real catalog products; the AI gets the product's name, description, specs, price **and photos** to ground the copy + image briefs. Operator attaches products in the editor; the planner auto-attaches to product-anchored emails.
**Method:** No `ANTHROPIC_API_KEY` in this environment, so I can't judge the model's *output*. Instead I tested the part that determines whether the feature works at all: **does the right data actually reach the model?** I stubbed `fetch` to intercept the exact Anthropic request body and assert its contents, plus unit-tested every deterministic piece (selection queries, id parse/serialize, planner distribution). 51 marketing tests total, all green; `tsc` clean on touched files.

> **Honest limitation:** this proves the *inputs* are assembled and transmitted correctly (product block in the prompt, photos as vision blocks, correct fallbacks). It does **not** prove the *output* is good — i.e. that the copy genuinely features the product, uses the specs accurately, and that image briefs depict the right frame. That requires the live key (see §4).

---

## 0. TL;DR

The wiring is correct and now resilient. Testing surfaced **three issues I fixed** (a fragile vision call with no fallback, an untestable inline planner heuristic, and a latent type bug introduced by the fallback refactor) and **three intentional behaviors I documented**. The one thing that remains genuinely unverified is LLM output quality, which is gated on the API key.

---

## 1. What's verified green (with tests)

- **Copy generation feeds products correctly** — when a campaign has products, the request body's user turn is a content **array**: a text block containing the formatted product list (name, price, description, specs) **plus one `image` block per photo** (`source: { type: "url", url }`). System prompt + forced tool intact. *(`email-ai-products.test.ts`)*
- **Image-brief generation feeds products correctly** — same: product block + photos reach `generateImagePrompts` so briefs can depict the real frame.
- **No-product path** — content stays a plain string and the prompt's `{{featuredProducts}}` resolves to the "(none — write a non-product brand email)" marker, so non-product emails are unaffected.
- **Product-with-no-photo path** — text is injected but content stays a string (no empty/broken image block).
- **Selection queries** — `resolveProducts` preserves order + drops unknown ids; `top_sellers` ranks by units ordered; `in_stock` lists featurable in-stock products; `searchProducts`; random suggest caps at N. *(`product-selector.test.ts`)*
- **Id column** — `parse/serialize` round-trip; junk tolerated; empty → clean `NULL`. *(`featured-products.test.ts`)*
- **Planner auto-assign distribution** — product-anchored proposals each get one cycling product; non-anchored get null; empty pool → all null. *(`featured-products.test.ts`)*

---

## 2. Findings I fixed

### 🟠 2.1 A failed product image sank the entire generation — FIXED
The image-bearing request was the only attempt. If Anthropic couldn't fetch/parse a product photo (bad URL, transient CDN error, a model that rejects the source), the **whole** `generate-copy` / `generate-image-prompts` call 502'd — the operator got *nothing*, not even text copy, because one photo failed.
**Fix:** `callClaude` now retries **once, text-only**, when an image-bearing request fails with an image-shaped error (`400` / `image` / `source` / "could not fetch"…). Copy/briefs still land; the photos are a bonus, not a single point of failure. *(test: "retries text-only when the image request fails")*

### 🟡 2.2 Planner auto-assign was inline + untested — FIXED
The "which proposals get a product, cycling a pool" logic lived inside the HTTP handler, so it couldn't be unit-tested and the cycling/anchored rules were unverified.
**Fix:** extracted to a pure `assignFeaturedProductIds(productHooks, poolIds)` in `featured-products.ts`; the route now does only the async pool fetch and calls it. 3 unit tests cover the cycle, the empty-pool, and the no-anchored cases.

### 🟡 2.3 Latent type bug from the fallback refactor — FIXED
Moving the fetch into a nested `send()` closure dropped TypeScript's non-null narrowing of `ANTHROPIC_API_KEY`, so the header value became `string | undefined` (a real "no overload matches" error, build-tolerated but wrong).
**Fix:** capture the narrowed key into a `const key: string` before the closure.

---

## 3. Intentional behaviors (documented, no change)

- **🟢 Image URLs must be publicly fetchable by Anthropic.** Relative catalog paths resolve to `https://theframe.getjaxy.com/api/images/…`, and `/api/images` is an unauthenticated public route (middleware allowlist), so Anthropic's servers can fetch them. *Implication:* a product whose photo exists only in a local/un-deployed store won't be visible to the model — its copy still generates (text), just without vision grounding.
- **🟢 The image URL is also printed in the prompt text** ("Image: …") even though the photo is sent as a vision block. Kept deliberately: with multiple products it lets the model correlate which photo belongs to which product.
- **🟢 Only `approved`/`published` products are featurable.** Intake/review SKUs are excluded so half-finished products never ship in an email. If you want to feature pre-launch products, we'd widen this.

---

## 4. Not yet tested — needs the live key

The model's **output quality** is unverified by design here:
- Does the copy actually weave the product in (name/specs/price), in brand voice?
- Does it respect the "(none)" path and write a clean non-product email?
- Do the image briefs depict the **featured frame** (color/shape/material) rather than a generic one, now that the photo is attached?

This is exactly the live end-to-end run we set up: with `ANTHROPIC_API_KEY` in a fresh session, seed a product-featured campaign and a non-product one, generate both, and assess. The harness above guarantees the inputs are correct, so a bad output would point at the *prompt wording*, not the plumbing.

---

## 5. Verification

`npm test` marketing suite: **51 passed** (render-email 17, product-selector 7, featured-products 7, email-ai-products 5, + existing). `tsc` clean on all touched files. Changes are additive; non-product campaigns are byte-for-byte unaffected (no products → identical string-content request as before).
