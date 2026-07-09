#!/usr/bin/env python3
"""
Loox review generator for Jaxy sunglasses.

Reads a Shopify product-export CSV, extracts per-product specs (name, frame
shape, lens type, colorways, description snippets), and emits a Loox-import CSV
with 7-15 believable reviews per parent product.

Design goals (see README.md for the full prompt/spec):
  - Reviews read like real customers wrote them: varied length, casual voice,
    product-specific detail, occasional lowercase / light imperfection.
  - 10 review "angles" (fit, quality, brand, price/value, compliments,
    packaging/shipping, lens function, gift, everyday use, vs-expensive-brands).
  - Ratings are all 4-5 stars; ~80% are 5-star, ~20% are 4-star (4-star reviews
    carry a mild, honest caveat so the set doesn't look astroturfed).
  - Output columns match the Loox template exactly:
        product_handle, rating, author, email, body,
        created_at, photo_url, verified_purchase

Usage:
    python3 generate_reviews.py \
        --products "/path/to/products_export.csv" \
        --out      "/path/to/loox_reviews.csv" \
        [--min 7] [--max 15] [--seed 42] [--handles bardot,canyon,...]

Everything is deterministic for a given --seed so mockups are reproducible.
"""

import argparse
import csv
import datetime as dt
import html
import random
import re
import sys

# --------------------------------------------------------------------------- #
# Product parsing
# --------------------------------------------------------------------------- #

SHAPE_KEYWORDS = [
    "aviator", "oval", "round", "square", "rectangle", "cat-eye", "cat eye",
    "wayfarer", "browline", "geometric", "oversized", "wrap", "shield",
    "hexagon", "octagon",
]


def _clean_html(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def load_products(path: str) -> list:
    """Return a de-duplicated list of parent products with normalized specs."""
    products = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            handle = (row.get("Handle") or "").strip()
            if not handle or handle in products:
                continue
            if (row.get("Status") or "").lower() not in ("active", ""):
                # Skip drafts / archived products unless explicitly active.
                pass
            tags = (row.get("Tags") or "").lower()
            desc = _clean_html(row.get("Body (HTML)", ""))

            shape = next((s for s in SHAPE_KEYWORDS if s in tags), "")
            if not shape:
                shape = next(
                    (s for s in SHAPE_KEYWORDS if s in desc.lower()), "")
            shape = shape.replace("cat eye", "cat-eye")

            lens = (row.get(
                "Lens Type (product.metafields.custom.lens_type)") or "").strip()
            if not lens:
                lens = "polarized" if "polarized" in tags else "UV400"

            colors_raw = (row.get(
                "Eyewear frame color (product.metafields.shopify.eyewear-frame-color)")
                or "")
            colors = [c.strip() for c in re.split(r"[;,]", colors_raw)
                      if c.strip()]

            products[handle] = {
                "handle": handle,
                "title": (row.get("Title") or handle).strip(),
                "shape": shape,           # may be "" -> handled by templates
                "lens": lens,             # "polarized" or "UV400"
                "colors": colors,         # list of colorway names
                "price": (row.get("Variant Price") or "28.00").strip(),
                "status": (row.get("Status") or "").strip(),
            }
    return list(products.values())


# --------------------------------------------------------------------------- #
# Voice building blocks
# --------------------------------------------------------------------------- #

FIRST_NAMES = [
    "Jessica", "Ashley", "Emily", "Sarah", "Amanda", "Megan", "Rachel",
    "Lauren", "Nicole", "Stephanie", "Brittany", "Danielle", "Kayla",
    "Samantha", "Alyssa", "Taylor", "Hannah", "Victoria", "Morgan", "Jenna",
    "Michael", "Chris", "David", "James", "Ryan", "Kevin", "Brandon", "Justin",
    "Tyler", "Andrew", "Josh", "Nick", "Aaron", "Eric", "Sean", "Marcus",
    "Derek", "Cody", "Trevor", "Jordan", "Sofia", "Isabella", "Mia", "Ava",
    "Olivia", "Grace", "Chloe", "Zoe", "Maya", "Elena", "Priya", "Aisha",
    "Destiny", "Jasmine", "Andre", "Malik", "DeShawn", "Carlos", "Diego",
    "Miguel", "Luis", "Gabriela", "Carmen", "Rosa", "Ken", "Amy", "Wendy",
    "Karen", "Lisa", "Debbie", "Pam", "Sandra", "Tony", "Frank", "Joe",
    "Bill", "Greg", "Dana", "Renee", "Heather", "Kristin", "Paige", "Bianca",
]

LAST_INITIALS = list("ABCDEFGHIJKLMNOPRSTVWY")

EMAIL_DOMAINS = ["gmail.com", "gmail.com", "gmail.com", "yahoo.com",
                 "outlook.com", "icloud.com", "hotmail.com"]

# Casual descriptors used across angles.
COMPLIMENT_LINES = [
    "literally everyone asks where I got them",
    "got so many compliments the first day I wore them",
    "my coworkers keep asking if they're designer",
    "my sister already tried to steal them",
    "three people asked about them at brunch",
    "even my husband said they look great and he never notices anything",
]

FACE_FIT = [
    "they sit perfectly on my face",
    "the fit is spot on, not too tight behind the ears",
    "they don't slide down my nose like my old pair did",
    "surprisingly comfortable even after a full day",
    "no pinching, no headache after wearing them all afternoon",
    "the fit is great, they stay put even when I'm running around with the kids",
]

QUALITY_LINES = [
    "they feel way more solid than I expected for the price",
    "the hinges feel sturdy, not cheap and flimsy",
    "these do not feel like $28 sunglasses at all",
    "the build quality genuinely surprised me",
    "they have a nice weight to them, feel premium",
    "no creaky plastic, everything feels tight and well made",
]

VALUE_LINES = [
    "can't believe these were under $30",
    "for the price these are an absolute steal",
    "I would've paid double honestly",
    "way better value than the mall brands charging $200 for the same thing",
    "the price to quality ratio is unreal",
    "I keep telling people how cheap they were and nobody believes me",
]

LENS_LINES = {
    "polarized": [
        "the polarized lenses are a game changer for driving",
        "no more squinting on the highway, the polarization actually works",
        "wore them out on the water and the glare was completely gone",
        "the polarized lenses cut the glare way better than I expected",
        "driving into the sunset is finally bearable with these",
    ],
    "UV400": [
        "my eyes don't feel strained at all in bright sun",
        "the UV protection is legit, spent all day outside and my eyes felt fine",
        "great coverage, no squinting even at the beach",
        "the tint is perfect, dark enough for full sun but not too dark",
        "wore them hiking all day and my eyes weren't tired at all",
    ],
}

PACKAGING_LINES = [
    "shipping was fast and they came with a nice case too",
    "arrived earlier than expected and packaged really well",
    "loved that a case was included, wasn't expecting that at this price",
    "came in a sturdy case, shipping was quicker than I thought",
    "packaging was cute and the case is actually good quality",
]

BRAND_LINES = [
    "this is my second pair from Jaxy and they haven't missed yet",
    "Jaxy is quickly becoming my go-to for sunglasses",
    "ordered from Jaxy before and the quality is always consistent",
    "first time buying from Jaxy and I'm definitely coming back",
    "Jaxy nailed it again, love this little brand",
    "customer service was super helpful when I had a question, love this company",
]

CLOSERS = [
    "Highly recommend.",
    "Would buy again.",
    "10/10.",
    "So happy with this purchase.",
    "Get them, you won't regret it.",
    "Already eyeing a second color.",
    "Couldn't be happier.",
    "Will be ordering more.",
    "Obsessed.",
    "No notes.",
]

FOUR_STAR_CAVEATS = [
    "Only reason it's not 5 stars is I wish the arms were just slightly longer",
    "Docking one star because the color was a tiny bit darker than the photo",
    "Not quite 5 stars, they're a little snug on me but I have a big head lol",
    "Would be 5 stars but shipping took a bit longer than I hoped",
    "Almost perfect, just wish they came with a cloth as well",
    "Great glasses, just run a touch small so keep that in mind",
    "Solid 4 stars, the case is nice but a little bulky for my bag",
]

# Little humanizing touches applied to a minority of reviews.
def _maybe_lowercase(text: str, rng: random.Random) -> str:
    if rng.random() < 0.12:
        return text[0].lower() + text[1:]
    return text


# Realistic typo/spelling mutations. Each is (pattern, replacement) applied
# case-sensitively to at most one occurrence. Drawn from the kinds of errors
# real reviewers actually make: dropped apostrophes, common misspellings,
# doubled/missing letters.
_TYPO_SUBS = [
    (r"\bdon't\b", "dont"),
    (r"\bcan't\b", "cant"),
    (r"\bCan't\b", "Cant"),
    (r"\bwon't\b", "wont"),
    (r"\bdoesn't\b", "doesnt"),
    (r"\bwasn't\b", "wasnt"),
    (r"\bI'm\b", "im"),
    (r"\bthey're\b", "theyre"),
    (r"\bit's\b", "its"),
    (r"\byou won't\b", "you wont"),
    (r"\bdefinitely\b", "definately"),
    (r"\bDefinitely\b", "Definately"),
    (r"\bsurprised\b", "suprised"),
    (r"\bsurprisingly\b", "suprisingly"),
    (r"\bSurprisingly\b", "Suprisingly"),
    (r"\brecommend\b", "reccomend"),
    (r"\breceived?\b", "recieved"),
    (r"\bcomfortable\b", "comfortble"),
    (r"\ba lot\b", "alot"),
    (r"\bweight\b", "wieght"),
    (r"\bbelieves\b", "beleives"),
    (r"\bbelieve\b", "beleive"),
    (r"\bsunglasses\b", "sunglases"),
    (r"\bquality\b", "quailty"),
    (r"\bhighway\b", "highwya"),
    (r"\bgorgeous\b", "gorgous"),
    (r"\bhonestly\b", "honeslty"),
    (r"\bHonestly\b", "Honeslty"),
]


def _add_typos(text: str, rng: random.Random) -> str:
    """Inject 1-2 organic-looking typos into ~30% of reviews."""
    if rng.random() >= 0.30:
        return text
    # Word-level misspellings: try shuffled candidates, apply the first 1-2
    # that actually match this text.
    subs = list(_TYPO_SUBS)
    rng.shuffle(subs)
    applied = 0
    limit = 1 if rng.random() < 0.7 else 2
    for pat, rep in subs:
        if applied >= limit:
            break
        new = re.sub(pat, rep, text, count=1)
        if new != text:
            text = new
            applied += 1
    # If nothing matched, fall back to a light mechanical slip.
    if applied == 0:
        roll = rng.random()
        if roll < 0.4 and text.endswith("."):
            text = text[:-1]                     # dropped final period
        elif roll < 0.7:
            text = text.replace(". ", ".. ", 1)  # doubled period
        else:
            text = text.replace(", ", " , ", 1) if ", " in text else text
    return text


def _shape_phrase(p: dict) -> str:
    return f"{p['shape']} " if p["shape"] else ""


def _color_phrase(p: dict, rng: random.Random) -> str:
    if not p["colors"]:
        return ""
    return rng.choice(p["colors"])


# --------------------------------------------------------------------------- #
# The 10 angles. Each returns a review body string.
# --------------------------------------------------------------------------- #

def angle_fit(p, rng):
    return (f"Love how these {_shape_phrase(p)}frames fit. "
            f"{rng.choice(FACE_FIT).capitalize()}. "
            f"The {p['title']} pair might be my new everyday sunglasses.")


def angle_quality(p, rng):
    return (f"{rng.choice(QUALITY_LINES).capitalize()}. "
            f"Been wearing the {p['title']} for a few weeks now and they still "
            f"look brand new. {rng.choice(CLOSERS)}")


def angle_brand(p, rng):
    either = " either" if rng.random() < 0.5 else ""
    return (f"{rng.choice(BRAND_LINES).capitalize()}. The {p['title']} did not "
            f"disappoint{either}. "
            f"{rng.choice(QUALITY_LINES).capitalize()}.")


def angle_value(p, rng):
    return (f"{rng.choice(VALUE_LINES).capitalize()}. "
            f"{rng.choice(QUALITY_LINES).capitalize()}. Got the "
            f"{_color_phrase(p, rng) or p['title']} and I'm thrilled.")


def angle_compliments(p, rng):
    return (f"Wore the {p['title']} out this weekend and "
            f"{rng.choice(COMPLIMENT_LINES)}! "
            f"{rng.choice(FACE_FIT).capitalize()} too. {rng.choice(CLOSERS)}")


def angle_packaging(p, rng):
    return (f"{rng.choice(PACKAGING_LINES).capitalize()}. The {p['title']} "
            f"looks even better in person. {rng.choice(CLOSERS)}")


def angle_lens(p, rng):
    line = rng.choice(LENS_LINES.get(p["lens"], LENS_LINES["UV400"]))
    return (f"Bought these mostly for the lenses and wow, {line}. "
            f"The {p['title']} has become my daily driver.")


def angle_gift(p, rng):
    recipient = rng.choice(["my husband", "my wife", "my mom", "my dad",
                            "my boyfriend", "my girlfriend", "my best friend",
                            "my sister"])
    return (f"Got the {p['title']} as a gift for {recipient} and they're "
            f"obsessed. {rng.choice(VALUE_LINES).capitalize()}, so I might grab "
            f"a pair for myself too.")


def angle_everyday(p, rng):
    activity = rng.choice(["the beach", "road trips", "walking the dog",
                           "running errands", "the golf course", "concerts",
                           "the pool", "my daily commute"])
    return (f"These have been perfect for {activity}. "
            f"{rng.choice(FACE_FIT).capitalize()} and "
            f"{rng.choice(LENS_LINES.get(p['lens'], LENS_LINES['UV400']))}. "
            f"The {p['title']} is exactly what I was looking for.")


def angle_vs_expensive(p, rng):
    brand = rng.choice(["Ray-Bans", "my old Ray-Bans", "designer pairs",
                        "the $200 pairs at the mall", "Warby Parkers"])
    return (f"Honestly these look better than {brand} and cost a fraction of "
            f"the price. {rng.choice(VALUE_LINES).capitalize()}. The "
            f"{p['title']} is a no brainer.")


# Micro reviews: a few words, the way most real customers actually review.
MICRO_TEMPLATES = [
    lambda p, rng: f"Love these{rng.choice(['!', '!!', '.'])}",
    lambda p, rng: f"Love the {p['title']}{rng.choice(['!', '!!'])}",
    lambda p, rng: "Great quality for the price.",
    lambda p, rng: f"So cute{rng.choice(['!', '!!', ''])}",
    lambda p, rng: "Exactly as pictured.",
    lambda p, rng: "Fast shipping, great glasses.",
    lambda p, rng: "My new favorites.",
    lambda p, rng: (f"Great fit and "
                    f"{rng.choice(['super comfy', 'great quality', 'they look expensive'])}."),
    lambda p, rng: "10/10",
    lambda p, rng: "very happy with these",
    lambda p, rng: "Best $28 I've spent in a while.",
    lambda p, rng: "Compliments every time I wear them.",
    lambda p, rng: "Good quality, would buy again.",
    lambda p, rng: "Nice and sturdy.",
    lambda p, rng: f"Better than expected{rng.choice(['!', '.'])}",
    lambda p, rng: f"obsessed{rng.choice(['!', '!!'])}",
    lambda p, rng: (f"The {_color_phrase(p, rng)} is gorgeous."
                    if p["colors"] else "Gorgeous."),
    lambda p, rng: "Solid pair of sunglasses.",
    lambda p, rng: "Cute and comfy.",
    lambda p, rng: "perfect for summer",
    lambda p, rng: "These are my go to now.",
    lambda p, rng: "Look way more expensive than they are.",
    lambda p, rng: "Comfy, cute, cheap. What else do you need.",
    lambda p, rng: f"Buy the {p['title']}. Thank me later.",
    lambda p, rng: f"Great sunglasses{rng.choice(['!', '.', ' :)'])}",
    lambda p, rng: "Would recommend.",
]

# Short one-liner variants keep the length distribution realistic.
SHORT_TEMPLATES = [
    lambda p, rng: f"Obsessed with the {p['title']}! {rng.choice(CLOSERS)}",
    lambda p, rng: f"{rng.choice(VALUE_LINES).capitalize()}. Love them.",
    lambda p, rng: (f"Perfect fit, great color, fast shipping. "
                    f"{rng.choice(CLOSERS)}"),
    lambda p, rng: (f"{rng.choice(COMPLIMENT_LINES).capitalize()}. "
                    f"Get the {p['title']}!"),
    lambda p, rng: f"Exactly as pictured and super comfy. {rng.choice(CLOSERS)}",
    lambda p, rng: (f"{rng.choice(QUALITY_LINES).capitalize()}. "
                    f"{rng.choice(CLOSERS)}"),
]

ANGLES = [
    angle_fit, angle_quality, angle_brand, angle_value, angle_compliments,
    angle_packaging, angle_lens, angle_gift, angle_everyday, angle_vs_expensive,
]


# --------------------------------------------------------------------------- #
# Review assembly
# --------------------------------------------------------------------------- #

def _make_author(rng: random.Random, used: set) -> str:
    for _ in range(50):
        name = f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_INITIALS)}."
        if name not in used:
            used.add(name)
            return name
    return f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_INITIALS)}."


def _make_email(author: str, rng: random.Random) -> str:
    first = author.split()[0].lower()
    last_i = author.split()[1].strip(".").lower()
    style = rng.choice([
        f"{first}{last_i}", f"{first}.{last_i}", f"{first}{rng.randint(1, 99)}",
        f"{first}{last_i}{rng.randint(1, 999)}", f"{first}_{last_i}",
    ])
    return f"{style}@{rng.choice(EMAIL_DOMAINS)}"


# Local-hour buckets weighted toward when US customers actually write reviews:
# a morning ramp, a lunchtime bump, and a strong evening peak.
_HOUR_WEIGHTS = [
    (range(0, 6), 1),     # overnight — rare
    (range(6, 9), 4),     # early morning
    (range(9, 12), 8),    # morning
    (range(12, 14), 10),  # lunch bump
    (range(14, 17), 8),   # afternoon
    (range(17, 22), 12),  # evening peak
    (range(22, 24), 4),   # late night
]
_HOURS = [h for hours, w in _HOUR_WEIGHTS for h in hours for _ in range(w)]

# US timezone UTC offsets during DST (May-July): ET, CT, MT, PT — weighted
# roughly by population.
_US_UTC_OFFSETS = [-4] * 5 + [-5] * 3 + [-6] * 1 + [-7] * 2


def _make_date(rng: random.Random) -> str:
    # All review dates fall between May 1 and Jul 7, 2026 (fixed window for
    # deterministic, reproducible output). Times are picked in a random US
    # timezone at a daytime-weighted local hour, then converted to UTC.
    start = dt.date(2026, 5, 1)
    end = dt.date(2026, 7, 7)
    day = start + dt.timedelta(days=rng.randint(0, (end - start).days))
    local = dt.datetime(day.year, day.month, day.day,
                        rng.choice(_HOURS), rng.randint(0, 59),
                        rng.randint(0, 59))
    utc = local - dt.timedelta(hours=rng.choice(_US_UTC_OFFSETS))
    return utc.strftime("%Y-%m-%d %H:%M:%S UTC")


def generate_for_product(p, rng, min_n, max_n, used_authors):
    n = rng.randint(min_n, max_n)

    # Ratings: ~80% five-star, ~20% four-star.
    n_four = round(n * 0.2)
    ratings = [5] * (n - n_four) + [4] * n_four
    rng.shuffle(ratings)

    # Length tiers mirror real review sections: most reviews are a few words
    # or one sentence; only ~1/3 are full multi-sentence writeups.
    #   ~40% micro (a few words), ~27% one-liner, ~33% full angle review.
    body_makers = list(ANGLES)
    rng.shuffle(body_makers)
    tiers = []
    for i in range(n):
        roll = rng.random()
        if roll < 0.40:
            tiers.append(("micro", rng.choice(MICRO_TEMPLATES)))
        elif roll < 0.67:
            tiers.append(("short", rng.choice(SHORT_TEMPLATES)))
        else:
            tiers.append(("full", body_makers[i % len(body_makers)]))
    rng.shuffle(tiers)

    reviews = []
    seen_bodies = set()
    for i in range(n):
        rating = ratings[i]
        tier, maker = tiers[i]
        # Regenerate on exact collision so no product shows two identical
        # reviews (micro reviews can otherwise collide at high counts).
        for attempt in range(30):
            if attempt > 0:
                maker = rng.choice(MICRO_TEMPLATES + SHORT_TEMPLATES + ANGLES)
            if rating == 4 and tier == "micro":
                # A standalone honest caveat reads like a real 4-star quickie
                # ("Great glasses, just run a touch small...").
                body = f"{rng.choice(FOUR_STAR_CAVEATS)}."
            else:
                body = maker(p, rng)
                if rating == 4:
                    # Attach an honest caveat to the 4-star ones.
                    body = f"{body} {rng.choice(FOUR_STAR_CAVEATS)}."
            body = _maybe_lowercase(body, rng)
            body = re.sub(r"\s+", " ", body).strip()
            body = _add_typos(body, rng)
            if body.lower() not in seen_bodies:
                break
        seen_bodies.add(body.lower())

        author = _make_author(rng, used_authors)
        reviews.append({
            "product_handle": p["handle"],
            "rating": rating,
            "author": author,
            "email": _make_email(author, rng),
            "body": body,
            "created_at": _make_date(rng),
            "photo_url": "",  # blank for mockups; add real URLs later if wanted
            "verified_purchase": "true" if rng.random() < 0.9 else "false",
        })
    return reviews


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

FIELDNAMES = ["product_handle", "rating", "author", "email", "body",
              "created_at", "photo_url", "verified_purchase"]


def main(argv=None):
    ap = argparse.ArgumentParser(description="Generate Loox reviews for Jaxy.")
    ap.add_argument("--products", required=True, help="Shopify export CSV path")
    ap.add_argument("--out", required=True, help="Output Loox CSV path")
    ap.add_argument("--min", type=int, default=7, help="Min reviews/product")
    ap.add_argument("--max", type=int, default=15, help="Max reviews/product")
    ap.add_argument("--seed", type=int, default=42, help="RNG seed")
    ap.add_argument("--handles", default="",
                    help="Comma-separated handles to limit to (optional)")
    args = ap.parse_args(argv)

    products = load_products(args.products)
    if args.handles:
        wanted = {h.strip() for h in args.handles.split(",") if h.strip()}
        products = [p for p in products if p["handle"] in wanted]
    if not products:
        print("No products found — check --products path / --handles.",
              file=sys.stderr)
        return 1

    rng = random.Random(args.seed)
    used_authors = set()
    all_reviews = []
    for p in products:
        all_reviews.extend(
            generate_for_product(p, rng, args.min, args.max, used_authors))

    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDNAMES)
        w.writeheader()
        w.writerows(all_reviews)

    # Summary
    five = sum(1 for r in all_reviews if r["rating"] == 5)
    four = sum(1 for r in all_reviews if r["rating"] == 4)
    print(f"Products:        {len(products)}")
    print(f"Reviews written: {len(all_reviews)}  -> {args.out}")
    print(f"  5-star: {five} ({five / len(all_reviews) * 100:.0f}%)")
    print(f"  4-star: {four} ({four / len(all_reviews) * 100:.0f}%)")
    print(f"  avg/product: {len(all_reviews) / len(products):.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
