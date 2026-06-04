# Jaxy Product Naming Brief

Use this when naming new eyewear styles locally (ChatGPT / Claude /
any LLM). Copy the relevant block, paste in your frame details
where indicated, send.

Mirrored from the canonical source: `src/modules/catalog/lib/prompt-engine.ts`
(`COPY_PROMPTS.productName`). Update both if you change one.

---

## The prompt

> You're naming a new **{category — "sunglasses" / "reading glasses" / "blue light"}** style for Jaxy — a modern, lifestyle-driven eyewear brand.
>
> Frame details: **{paste details — colorway, shape, material, vibe notes from the PO}**.
>
> Generate 8 candidate names following these rules:
>
> **STYLE**
> - 1–2 words, max 14 characters total. Easy to say out loud.
> - Evoke a MOMENT, MOOD, or ATTITUDE — not the frame itself.
>   Strong references: late nights, music, motion, weather, light,
>   small intimate scenes, after-hours energy, golden-hour calm.
>   Weak references: literal colors, frame shapes, technical specs.
> - The name should make you feel something the second you read it.
> - Mix registers across your 8: some single evocative nouns
>   (Encore, Vesper, Static), some short verb/state phrases
>   (All In, Closing Time, Off Duty), one wildcard.
> - Avoid clichés saturated in eyewear: Aviator, Rebel, Maverick,
>   Icon, Classic, Vintage, Modern.
> - Tonal register: **{reading glasses → approachable + grown-up + un-fussy ; sunglasses → confident + lifestyle-forward ; blue light → calm + focused + everyday-friendly}**.
>
> **LEGAL — IMPORTANT**
> - Do NOT propose any name you know belongs to another eyewear,
>   fashion, or sunglass brand — not as a brand name, model name,
>   or collection name. Examples to avoid (non-exhaustive):
>   Ray-Ban / Wayfarer / Aviator / Clubmaster / Erika; Oakley /
>   Holbrook / Frogskins / Sutro / Radar; Quay names (After Hours,
>   Hardwire, All In, Sweet Dreams, Encore, On Repeat, Vesper,
>   Empire, Soundcheck, Closing Time, Off Duty); Warby Parker /
>   Felix / Percey / Haskell / Burke; Persol / Steve McQueen;
>   Maui Jim / Banyans; Smith / Lowdown; Le Specs / Halfmoon
>   Magic; Krewe / Conti / Clio; DIFF / Carson / Becky; Bonlook;
>   Privé Revaux; Pair Eyewear; Zenni; EyeBuyDirect; Liingo;
>   YESGLASSES; Felix Gray.
> - Avoid trademark-style names of large consumer brands in
>   adjacent categories (Apple, Tesla, Nike, Lululemon, etc.) —
>   even when the literal meaning is generic.
> - If a name is even SLIGHTLY at risk of overlap, do not include
>   it. Pick a different angle.
>
> **OUTPUT**
> For each name return:
> ```
> { "name": "...",
>   "vibe": "<one-line scene/mood it conjures>",
>   "legal_confidence": "high" | "medium" | "low",
>   "legal_notes": "<reasoning>" }
> ```
> Return a JSON array of 8 such objects, sorted by `legal_confidence` descending.

---

## Critical caveat on legal_confidence

`legal_confidence: high` from the LLM means **"I don't recall this being used in eyewear."** It is **NOT** a trademark guarantee.

Before any name ships to production, run a manual check:

1. **USPTO TESS** — `https://tmsearch.uspto.gov/`
   - Search the candidate name
   - Filter to **Class 9** (sunglasses, eyewear) AND **Class 16** (sometimes used for reading aids)
   - Look for live registrations and pending applications
   - 30 seconds per name

2. **Common-law gut check** — Google `"<name>" eyewear` and `"<name>" sunglasses` to catch unregistered uses (e.g. Etsy sellers, smaller brands not in TESS yet).

3. **Domain check** (optional, useful) — `<name>eyewear.com` and `jaxy<name>.com` availability is a tiebreaker if you want a microsite later.

Only after those three checks does a candidate go on the official short-list.

---

## Template for this PO (JAX501 — 7 reading-glass styles)

For each row, fill in the details from the PO and send the prompt above. Recommended details format:

```
Style code: JX5001-R
Category: reading glasses
Colorways: shiny black, demi tortoise, milky green multi demi
Notes: classic balanced trio, polished, no spring hinge
Reading power range: 0.00 (blue light) through +3.00
```

Suggested vibe direction per PO style (use this as input alongside the details so the LLM tunes to the right mood — these are mood notes, not name suggestions):

| Style | Suggested vibe seed for the prompt |
|---|---|
| JX5001 | balanced, classic, polished — for someone who reads books on Sunday mornings |
| JX5002 | easy daily wearer, spring hinge — slip on/off all day, low fuss |
| JX5003 | playful colorways (rust, sage, pink) — confident person who likes a pop of color |
| JX5004 | bold matte trio + leopard — after-dark dinner energy |
| JX5005 | dreamy top-fade gradients — golden-hour, slow-paced |
| JX5006 | matte minimal outdoorsy trio — quiet competence, weekend cabin |
| JX5007 | wood-look temples — grounded, natural, slightly heritage |

---

## Source of truth

If you change the rules / brand voice / cliché list — update **both**:

- This file (for local naming sessions)
- `src/modules/catalog/lib/prompt-engine.ts` → `COPY_PROMPTS.productName` (for the in-app generator)
