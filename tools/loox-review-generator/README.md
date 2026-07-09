# Loox Review Generator (Jaxy)

Generates believable, on-brand product reviews for the Jaxy sunglasses catalog
and writes them in the **Loox import CSV** format — for use in website mockups.

> ⚠️ These are **synthetic reviews for mockups/design only**. Do not import
> fabricated reviews into a live Loox/production store — it violates Loox's terms
> and consumer-protection (FTC) rules. Use this to fill layouts, not to deceive
> real shoppers.

## What it does

- Reads a Shopify product-export CSV and extracts, per parent product:
  name, frame **shape**, **lens type** (polarized / UV400), colorways, price.
- Emits **7–15 reviews per parent product** (random within range).
- Ratings are all **4–5 stars**, weighted **~80% 5-star / ~20% 4-star**.
  The 4-star reviews carry an honest, mild caveat so the set reads naturally.
- Output columns match the Loox template exactly:
  `product_handle, rating, author, email, body, created_at, photo_url, verified_purchase`

## The 10 review angles

Each review is built from one of ten angles. Length mirrors real review
sections: **~2/3 of reviews are short** (a few words like "Love these!!" or
one sentence), and only ~1/3 are full multi-sentence writeups. Plus light
humanizing touches (occasional lowercase, organic typos
and misspellings in ~30% of reviews — dropped apostrophes, "definately",
"suprised", dropped final periods — varied closers, name + last-initial
authors, realistic emails, dates spread across May–July 2026). No em dashes. Product-specific details (shape, colorway, lens type, style name)
are woven in so each review feels specific rather than generic.

| # | Angle | Focus |
|---|-------|-------|
| 1 | **Fit** | How they sit / comfort on the face |
| 2 | **Quality / build** | Hinges, weight, durability over time |
| 3 | **Brand** | Repeat buyer, trust in Jaxy, service |
| 4 | **Price / value** | Steal at the price, would pay more |
| 5 | **Compliments** | Social proof — people asking about them |
| 6 | **Packaging / shipping** | Fast delivery, included case |
| 7 | **Lens function** | Polarized glare / UV400 protection (matched to product) |
| 8 | **Gift** | Bought for someone else |
| 9 | **Everyday use** | Beach, driving, golf, commute, etc. |
| 10 | **Vs. expensive brands** | Beats Ray-Ban/Warby at a fraction of cost |

Lengths vary from one-line to multi-sentence. Brand facts stay accurate to the
catalog (case included / no cloth; lens is polarized **or** UV400, never both).

## Usage

```bash
python3 generate_reviews.py \
  --products "/Users/danielseeff/Downloads/products_export 5.csv" \
  --out      "/Users/danielseeff/Downloads/loox_reviews_jaxy.csv"
```

Options:

| Flag | Default | Meaning |
|------|---------|---------|
| `--min` | `7` | Minimum reviews per product |
| `--max` | `15` | Maximum reviews per product |
| `--seed` | `42` | RNG seed — same seed = identical output (reproducible mockups) |
| `--handles` | *(all)* | Comma-separated handles to limit to, e.g. `bardot,canyon` |

Change `--seed` to reroll a completely different-but-consistent set of reviews.

## Customizing the voice

All the phrasing lives in plain lists near the top of `generate_reviews.py`
(`FIRST_NAMES`, `QUALITY_LINES`, `VALUE_LINES`, `LENS_LINES`, `CLOSERS`,
`FOUR_STAR_CAVEATS`, the `angle_*` functions, and `SHORT_TEMPLATES`). Add or
edit lines there to shift tone, add slang, or introduce new angles — no other
changes needed.

## Notes

- `photo_url` is left blank (mockups). Loox accepts blank; add real image URLs
  later if the mockup needs photo reviews.
- `verified_purchase` is `true` ~90% of the time.
- Review dates all fall between **2026-05-01 and 2026-07-07** (fixed window so
  runs are reproducible). Timestamps are daytime-weighted US local times
  (morning ramp, lunch bump, evening peak, across US timezones) converted
  to UTC.
