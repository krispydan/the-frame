#!/usr/bin/env python3
"""Generate a self-contained HTML report from the sunglasses crawl output.

Reads:
  ~/Downloads/sunglasses-products.csv   (one row per matched product)
  ~/Downloads/sunglasses-state.jsonl    (one row per domain processed)
  ~/Downloads/apparel-filtered.csv      (location/firmographic enrichment)

Writes:
  ~/Downloads/sunglasses-report.html    (open in any browser)

Aggregates per-store stats from the product CSV, joins firmographic
context from the cohort CSV, and renders a clean printable report
with no external dependencies.
"""

import csv, json, os, sys, html, collections, statistics
from pathlib import Path
csv.field_size_limit(min(sys.maxsize, 2**31 - 1))

DL = Path.home() / "Downloads"
PRODUCTS = DL / "sunglasses-products.csv"
STATE    = DL / "sunglasses-state.jsonl"
COHORT   = DL / "apparel-filtered.csv"
OUT      = DL / "sunglasses-report.html"

# ─── Vendor noise list ──────────────────────────────────────────────────────
# Dropship suppliers and Shopify default placeholders that show up
# in the `vendor` field but aren't actual brands. They'd inflate the
# top-brand chart and make every store with them look "loyal" to a
# fake brand. Filter them out everywhere brand intelligence is
# computed; product rows still count (the eyewear is real), they
# just don't get a brand attribution.
NOISE_VENDORS = {
    "printify",      # print-on-demand service
    "trendsi",       # dropship supplier
    "my store",      # Shopify default placeholder
    "mysite",        # Shopify default placeholder
    "default title", # another Shopify default
    "shopify",       # rare but appears
    "",              # blank vendor field
    "unknown",
    "vendor",        # literal "vendor" string
}
def is_real_brand(vendor):
    """True if the vendor string looks like an actual brand name
    (not a dropship supplier or default placeholder)."""
    if not vendor: return False
    return vendor.strip().lower() not in NOISE_VENDORS

def fmt(n):
    return f"{n:,}" if isinstance(n, int) else f"{n:,.0f}"

def pct(n, d):
    return f"{100*n/d:.1f}%" if d else "—"

def safe_float(s):
    try: return float(s) if s and s != "" else None
    except: return None

# ─── Load the products CSV ──────────────────────────────────────────────────
print(f"Reading {PRODUCTS}…")
products = []
with open(PRODUCTS) as f:
    for r in csv.DictReader(f):
        r["price_f"] = safe_float(r.get("product_price"))
        products.append(r)
print(f"  loaded {len(products):,} product rows")

# ─── Per-domain rollup ──────────────────────────────────────────────────────
class Store:
    __slots__ = ("domain","name","sg","rg","prices","vendors","match_reasons",
                 "samples","categories")
    def __init__(self, domain, name):
        self.domain = domain
        self.name = name
        self.sg = 0
        self.rg = 0
        self.prices = []
        self.vendors = collections.Counter()
        self.match_reasons = collections.Counter()
        self.samples = []   # (title, price, category)
        self.categories = set()

stores = {}
for p in products:
    s = stores.setdefault(p["domain"], Store(p["domain"], p["store_name"]))
    cat = p.get("product_category") or "sunglasses"
    if cat == "sunglasses": s.sg += 1
    elif cat == "reading_glasses": s.rg += 1
    s.categories.add(cat)
    if p["price_f"]: s.prices.append(p["price_f"])
    # Skip noise vendors entirely — store's brand profile should
    # reflect actual brands, not dropship suppliers / placeholders.
    if is_real_brand(p.get("product_vendor")):
        s.vendors[p["product_vendor"]] += 1
    if p.get("match_reason"):
        kind = p["match_reason"].split(":")[0]
        s.match_reasons[kind] += 1
    if len(s.samples) < 3:
        s.samples.append((p.get("product_title",""), p["price_f"], cat))

print(f"  rolled up to {len(stores):,} unique stores")

# ─── State log → outcome totals ─────────────────────────────────────────────
print(f"Reading {STATE}…")
latest = {}
for line in open(STATE):
    try: d = json.loads(line)
    except: continue
    if d.get("domain"): latest[d["domain"]] = d
state_counts = collections.Counter(d["status"] for d in latest.values())
total_settled = state_counts["has_sunglasses"] + state_counts["no_sunglasses"]
hit_rate = state_counts["has_sunglasses"] / total_settled if total_settled else 0
print(f"  processed {len(latest):,} domains "
      f"({state_counts['has_sunglasses']:,} hits)")

# ─── Cohort join: city/state/industry/sales for matched stores ──────────────
cohort = {}
if COHORT.exists():
    print(f"Reading {COHORT}…")
    with open(COHORT) as f:
        for r in csv.DictReader(f):
            d = (r.get("domain") or "").strip().lower()
            if d in stores:
                cohort[d] = r
    print(f"  joined firmographics for {len(cohort):,} matched stores")

# ─── Aggregations for the report ────────────────────────────────────────────
# Top vendors — counted by NUMBER OF STORES carrying the brand,
# not number of product rows. Counting product rows would let a
# single store with 20 RAEN SKUs inflate RAEN's apparent reach.
# What we actually care about for competitive intel is "how many
# doors is this brand inside" — that's distinct-store count.
vendor_stores = collections.defaultdict(set)
vendor_product_counts = collections.Counter()
for p in products:
    v = (p.get("product_vendor") or "").strip()
    if is_real_brand(v):
        vendor_stores[v].add(p["domain"])
        vendor_product_counts[v] += 1
vendor_global = collections.Counter(
    {v: len(domains) for v, domains in vendor_stores.items()}
)

# Price distribution
all_prices = [p["price_f"] for p in products if p["price_f"]]
price_bands = collections.Counter()
for p in all_prices:
    if p < 20:        price_bands["Under $20"] += 1
    elif p < 50:      price_bands["$20–$50"]    += 1
    elif p < 100:     price_bands["$50–$100"]   += 1
    elif p < 200:     price_bands["$100–$200"]  += 1
    elif p < 500:     price_bands["$200–$500"]  += 1
    else:             price_bands["$500+"]      += 1
PRICE_BAND_ORDER = ["Under $20","$20–$50","$50–$100","$100–$200","$200–$500","$500+"]

# State distribution of matched stores
state_dist = collections.Counter()
industry_dist = collections.Counter()
for d, s in stores.items():
    cohort_row = cohort.get(d)
    if cohort_row:
        if cohort_row.get("state"):    state_dist[cohort_row["state"]] += 1
        cats = cohort_row.get("categories","").split(":")
        if cats:
            leaf = cats[0].split("/")[-1].strip()
            if leaf: industry_dist[leaf] += 1

# Both-categories stores (carry both sunglasses AND reading glasses)
both_stores = [s for s in stores.values() if s.sg > 0 and s.rg > 0]
sg_only = [s for s in stores.values() if s.sg > 0 and s.rg == 0]
rg_only = [s for s in stores.values() if s.sg == 0 and s.rg > 0]

# ─── Per-store: median price, top-brand share ───────────────────────────────
# Used for the price-tier section and the concentration section.
def store_median(s):
    return statistics.median(s.prices) if s.prices else None
def store_top_brand_share(s):
    total = sum(s.vendors.values())
    if total == 0: return None
    return s.vendors.most_common(1)[0][1] / total

# Price tiers — bucket each store by its median sunglass price.
PRICE_TIERS = [
    ("Entry ($20-50)", 20, 50, "#10b981"),
    ("Mid ($50-100)", 50, 100, "#4f7cff"),
    ("Premium ($100-200)", 100, 200, "#8b5cf6"),
    ("Luxury ($200+)", 200, float("inf"), "#f43f5e"),
    ("Sub-$20 / unbranded", 0, 20, "#94a3b8"),
]
tier_stores = {t[0]: [] for t in PRICE_TIERS}
for s in stores.values():
    m = store_median(s)
    if m is None: continue
    for label, lo, hi, _ in PRICE_TIERS:
        if lo <= m < hi:
            tier_stores[label].append(s)
            break

# Brand concentration buckets
CONCENTRATION_BUCKETS = [
    ("Single-brand loyalist (>80% one brand)", 0.80, 1.01, "#f43f5e"),
    ("Anchor brand (40-80%)", 0.40, 0.80, "#f59e0b"),
    ("Multi-brand assortment (<40%)", 0.0, 0.40, "#10b981"),
]
conc_stores = {b[0]: [] for b in CONCENTRATION_BUCKETS}
# Only score stores with at least 5 products — otherwise "100% one
# brand" is meaningless on a store with 1 SKU.
for s in stores.values():
    total = sum(s.vendors.values())
    if total < 5: continue
    share = store_top_brand_share(s)
    if share is None: continue
    for label, lo, hi, _ in CONCENTRATION_BUCKETS:
        if lo <= share < hi:
            conc_stores[label].append((share, s))
            break

# Brand co-occurrence: for top 10 brands, % of stores carrying X
# that also carry Y. Asymmetric matrix (X→Y is not the same as Y→X).
TOP_N_COOC = 10
top_cooc_brands = [name for name, _ in vendor_global.most_common(TOP_N_COOC)]

# ─── Brand-focus analysis: AJ Morgan ────────────────────────────────────────
# Jaxy purchases lists from AJ Morgan, so stores already carrying
# AJ Morgan are a known-warm cohort. Normalises across spelling
# variants ("A.J. Morgan", "AJ MORGAN", "Aj Morgan", etc.) — we
# observed 6+ in the raw data.
# Defined UP FRONT so the background section can reference the
# cohort size — the actual section is rendered further down.
FOCUS_BRAND_LABEL = "AJ Morgan"
def is_focus_brand(vendor):
    v = (vendor or "").strip().lower()
    # Strict positive match — has both "a" "j" "morgan" components
    # but reject other Morgans (Niven Morgan, Morgan the Label).
    if "morgan" not in v: return False
    if v in ("niven morgan", "morgan the label", "morgan & co",
             "morgan & co.", "morgan stewart", "morgan parker"): return False
    # AJ-style variants: "aj", "a.j.", "a j", or starts/ends with morgan
    if "aj " in v or "a.j." in v or "a j " in v: return True
    if v == "morgan" or v.endswith(" morgan"): return False  # ambiguous solo
    return False

focus_stores = collections.defaultdict(int)  # domain -> sku count of focus brand
focus_total_skus = 0
for p in products:
    if is_focus_brand(p.get("product_vendor")):
        focus_stores[p["domain"]] += 1
        focus_total_skus += 1
focus_store_set = set(focus_stores.keys())
focus_store_objs = [stores[d] for d in focus_store_set if d in stores]
print(f"  focus brand ({FOCUS_BRAND_LABEL}): "
      f"{len(focus_store_set):,} stores, {focus_total_skus:,} SKUs")

# Top stores by product count
top_by_products = sorted(stores.values(), key=lambda s: s.sg + s.rg, reverse=True)[:30]

# Median price per store (for "what's the typical AOV by store" view)
store_medians = []
for s in stores.values():
    if s.prices:
        store_medians.append(statistics.median(s.prices))
store_medians.sort()

def quantile(arr, q):
    if not arr: return None
    return arr[min(len(arr)-1, int(len(arr)*q))]

# ─── HTML rendering ─────────────────────────────────────────────────────────
print(f"Writing {OUT}…")

def bar(value, max_value, label_left="", label_right="", color="#4f7cff"):
    """Single horizontal bar row for histograms."""
    pct_w = 100 * value / max_value if max_value else 0
    return f"""
      <tr>
        <td class="bar-label">{html.escape(label_left)}</td>
        <td class="bar-track">
          <div class="bar-fill" style="width:{pct_w:.1f}%;background:{color}"></div>
        </td>
        <td class="bar-value">{html.escape(label_right)}</td>
      </tr>"""

def stat_card(title, value, sub=""):
    return f"""
      <div class="stat">
        <div class="stat-value">{html.escape(str(value))}</div>
        <div class="stat-title">{html.escape(title)}</div>
        {f'<div class="stat-sub">{html.escape(sub)}</div>' if sub else ''}
      </div>"""

# Build sections
sections = []

# Header
sections.append(f"""
<section class="hero">
  <h1>Sunglasses &amp; Reading-Glasses Wholesale Prospects</h1>
  <p class="subtitle">Inventory audit of every US Shopify apparel boutique that already carries eyewear — built to give the sales team a pre-qualified outreach list and live competitive intelligence on what's already on each store's shelf.</p>
  <div class="stats">
    {stat_card("Stores visited", fmt(len(latest)), f"{pct(len(latest), 119305)} of US apparel cohort")}
    {stat_card("Stores selling eyewear", fmt(len(stores)), f"{pct(len(stores), total_settled)} hit rate")}
    {stat_card("Sunglasses products", fmt(sum(s.sg for s in stores.values())), f"across {sum(1 for s in stores.values() if s.sg):,} stores")}
    {stat_card("Reading-glasses products", fmt(sum(s.rg for s in stores.values())), f"across {sum(1 for s in stores.values() if s.rg):,} stores")}
  </div>
</section>
""")

# Background / what we did — written for the sales team, not engineering.
sections.append(f"""
<section class="background">
  <h2>What we did &amp; how this list was built</h2>
  <p>You're holding a pre-qualified list of independent boutiques that already carry sunglasses or reading glasses. Every store in this report has been individually inspected — we know what they stock, how it's priced, and which brands they buy from.</p>

  <h3>The starting universe — {fmt(119305)} US apparel boutiques</h3>
  <p>We started with a dataset of every active US Shopify apparel store under $100K/month in revenue, sourced from StoreLeads. That's our target wholesale demographic: established small-to-mid boutiques that buy independent brands, not chains or fast-fashion. We filtered out categories that don't fit Jaxy's positioning — footwear, athletic apparel, children's clothing, eyewear competitors, weddings, sporting goods, and others — leaving <strong>{fmt(119305)} qualified Shopify boutiques</strong>.</p>

  <h3>Then we visited every single one</h3>
  <p>Shopify stores all publish a public product catalog at <code>yourstore.com/products.json</code> — the same feed their own website uses to render product pages. We wrote a script that visited each of the {fmt(119305)} stores and inspected their catalog for sunglasses or reading-glasses products. For each match, we captured the product title, retail price, brand, and product type. Stores with no eyewear products got marked "no match" and skipped.</p>

  <h3>What we kept and how it's organized</h3>
  <p>For every store that carries eyewear, the report tells you:</p>
  <ul>
    <li><strong>What they carry</strong> — sunglasses, reading glasses, or both, with the actual product titles</li>
    <li><strong>Which brands</strong> they stock — captured directly from the product feed</li>
    <li><strong>How they price</strong> — full retail price range plus median, so you know where they sit on the value spectrum</li>
    <li><strong>Where they're based</strong> — joined from the source cohort firmographics</li>
    <li><strong>How deep their eyewear shelf is</strong> — number of SKUs in each category</li>
  </ul>

  <h3>How to use this</h3>
  <p>The sections that follow are ordered roughly by sales utility:</p>
  <ul>
    <li><strong>Brand co-occurrence (heatmap)</strong> — when you're on a call with a prospect who carries Brand X, glance at X's row to see what else they almost certainly stock. Use those brand names in conversation.</li>
    <li><strong>Stores by price tier</strong> — sort your outreach list by tier so your pitch matches their positioning ($30 store vs $200 store wants different copy).</li>
    <li><strong>Brand concentration — who's pitchable</strong> — multi-brand assortment stores (less than 40% of their catalog is one brand) are your fastest conversions; single-brand loyalists are the hardest.</li>
    <li><strong>AJ Morgan cohort 🎯</strong> — {fmt(len(focus_store_objs)) if focus_store_objs else 0} stores already carrying AJ Morgan. These are <strong>known wholesale eyewear buyers</strong> — skip the qualification conversation, go straight to differentiation. This is your warmest list.</li>
    <li><strong>Full store tables</strong> — clickable store names link directly to their site so you can see their feel before reaching out.</li>
  </ul>

  <h3>A few caveats worth knowing</h3>
  <ul>
    <li>We capped at 25 eyewear SKUs per store, so any store showing "25" might actually have more — useful to know if you spot a big eyewear-focused boutique.</li>
    <li>~9% of the original universe errored out due to network issues during the crawl. Those stores aren't in this report; some are likely additional eyewear-carrying boutiques we missed.</li>
    <li>"Brand" intelligence comes from the <em>vendor</em> field each store sets on their own products. We filtered out dropship-service labels (Printify, Trendsi, "My Store", etc.) so the brand charts reflect real eyewear brands.</li>
  </ul>
</section>
""")

# Crawl outcome
sections.append(f"""
<section>
  <h2>Crawl outcome</h2>
  <table class="standard">
    <thead><tr><th>Outcome</th><th class="num">Domains</th><th class="num">% of total</th></tr></thead>
    <tbody>
      <tr><td>Has eyewear (sunglasses or readers)</td><td class="num">{fmt(state_counts['has_sunglasses'])}</td><td class="num">{pct(state_counts['has_sunglasses'], len(latest))}</td></tr>
      <tr><td>No eyewear found</td><td class="num">{fmt(state_counts['no_sunglasses'])}</td><td class="num">{pct(state_counts['no_sunglasses'], len(latest))}</td></tr>
      <tr><td>Error (proxy / network)</td><td class="num">{fmt(state_counts['error'])}</td><td class="num">{pct(state_counts['error'], len(latest))}</td></tr>
    </tbody>
  </table>
  <p class="note">Of {fmt(total_settled)} domains where the crawl actually completed, {pct(state_counts['has_sunglasses'], total_settled)} carry eyewear. The error rows are dominated by bandwidth-exhaustion late in the run — most are likely real Shopify stores that simply weren't reachable when the proxy quota dried up.</p>
</section>
""")

# Category split
both_n = len(both_stores)
sections.append(f"""
<section>
  <h2>Category split</h2>
  <table class="standard">
    <thead><tr><th>Category</th><th class="num">Stores</th><th class="num">Products</th><th class="num">Avg products/store</th></tr></thead>
    <tbody>
      <tr><td>Sunglasses only</td><td class="num">{fmt(len(sg_only))}</td><td class="num">{fmt(sum(s.sg for s in sg_only))}</td><td class="num">{(sum(s.sg for s in sg_only)/len(sg_only) if sg_only else 0):.1f}</td></tr>
      <tr><td>Reading glasses only</td><td class="num">{fmt(len(rg_only))}</td><td class="num">{fmt(sum(s.rg for s in rg_only))}</td><td class="num">{(sum(s.rg for s in rg_only)/len(rg_only) if rg_only else 0):.1f}</td></tr>
      <tr><td><strong>Carries both</strong></td><td class="num"><strong>{fmt(len(both_stores))}</strong></td><td class="num">{fmt(sum(s.sg + s.rg for s in both_stores))}</td><td class="num">{(sum(s.sg+s.rg for s in both_stores)/len(both_stores) if both_stores else 0):.1f}</td></tr>
    </tbody>
  </table>
  <p class="note">"Carries both" stores are particularly interesting prospects — they've already proven they sell to customers buying eyewear of more than one type, which suggests an established eyewear shelf rather than an incidental SKU.</p>
</section>
""")

# Top brands (vendor field) — by distinct store count
top_vendors = vendor_global.most_common(25)
max_v = top_vendors[0][1] if top_vendors else 1
vendor_rows = "".join(
    bar(
        c,
        max_v,
        label_left=name,
        label_right=f"{fmt(c)} stores · {fmt(vendor_product_counts[name])} SKUs",
        color="#8b5cf6",
    )
    for name, c in top_vendors
)
sections.append(f"""
<section>
  <h2>Top 25 brands carried (competitive landscape)</h2>
  <p class="note">Ranked by <strong>distinct stores</strong> carrying each brand — the real "how many doors are they already inside" signal. A single store with 30 SKUs of one brand is one door, not thirty. The SKU count is shown as a secondary signal (deep shelves vs broad-and-shallow).</p>
  <table class="bars">{vendor_rows}</table>
</section>
""")

# Brand co-occurrence: for each top-10 brand X, % of stores
# carrying X that also carry brand Y. Render as a heatmap-style
# grid. Rows = "given that the store carries X", columns =
# "also carries Y", cell value = percentage.
cooc_rows_html = []
header_cells = "<th></th>" + "".join(
    f'<th class="cooc-col">{html.escape(b[:18])}</th>'
    for b in top_cooc_brands
)
cooc_rows_html.append(f"<tr>{header_cells}</tr>")
for x in top_cooc_brands:
    x_stores = vendor_stores[x]
    n_x = len(x_stores)
    cells = [f'<th class="cooc-row">{html.escape(x[:24])} <span class="cooc-n">({fmt(n_x)})</span></th>']
    for y in top_cooc_brands:
        if x == y:
            cells.append('<td class="cooc-self">—</td>')
            continue
        overlap = len(x_stores & vendor_stores[y])
        share = overlap / n_x if n_x else 0
        # Intensity: 0% → near-white, 100% → strong purple
        intensity = min(1.0, share * 2.0)  # x2 so the visual lights up below 50% too
        # Pick text color for contrast — dark on light, white on dark
        bg = f"rgba(139, 92, 246, {intensity:.2f})"
        text_color = "#fff" if intensity > 0.55 else "#1a1a1a"
        cells.append(
            f'<td class="cooc-cell" style="background:{bg};color:{text_color}">'
            f'{share*100:.0f}%<div class="cooc-sub">{fmt(overlap)}</div>'
            f'</td>'
        )
    cooc_rows_html.append(f"<tr>{''.join(cells)}</tr>")

sections.append(f"""
<section>
  <h2>Brand co-occurrence — "what lives on the shelf together"</h2>
  <p class="note">For each top-10 brand on the row, the cell shows the percentage of stores carrying that brand who ALSO carry the brand in the column. So "RAEN row, Le Specs column = 42%" means "of stores carrying RAEN, 42% also carry Le Specs." Useful for predicting which adjacent brands a prospect will already be familiar with. Read along the row for "what stores who carry X are likely to also carry."</p>
  <div class="cooc-scroll">
    <table class="cooc">{''.join(cooc_rows_html)}</table>
  </div>
  <p class="note"><strong>How to use:</strong> When pitching a prospect that carries Brand X, look at X's row. The columns with the darkest cells are the brands they almost certainly also carry — use those in conversation to anchor the conversation in their current shelf.</p>
</section>
""")

# Price tiers — segment the outreach list
def render_tier_stores(store_list, limit=5):
    sorted_ = sorted(store_list, key=lambda s: s.sg + s.rg, reverse=True)[:limit]
    return ", ".join(
        f'<a href="https://{s.domain}" target="_blank">{html.escape(s.name or s.domain)[:30]}</a>'
        for s in sorted_
    )

max_tier_n = max((len(v) for v in tier_stores.values()), default=1)
tier_rows = "".join(
    f"""
      <tr>
        <td class="tier-label" style="border-left:4px solid {color}">{html.escape(label)}</td>
        <td class="num">{fmt(len(tier_stores[label]))}</td>
        <td class="bar-track" style="width:30%">
          <div class="bar-fill" style="width:{(100*len(tier_stores[label])/max_tier_n):.1f}%;background:{color}"></div>
        </td>
        <td class="tier-examples">{render_tier_stores(tier_stores[label])}</td>
      </tr>"""
    for label, lo, hi, color in PRICE_TIERS
    if tier_stores[label]
)
sections.append(f"""
<section>
  <h2>Stores by price tier — for outreach segmentation</h2>
  <p class="note">Each store bucketed by its <strong>median</strong> eyewear product price. Each tier needs different copy and value framing — Jaxy's wholesale pitch lands very differently against a $30 sunglass store vs a $250 luxury boutique. Sort outreach lists by tier and tailor messaging accordingly.</p>
  <table class="tier-table">
    <thead><tr><th>Tier</th><th class="num">Stores</th><th></th><th>Examples (top 5 by catalog size)</th></tr></thead>
    <tbody>{tier_rows}</tbody>
  </table>
</section>
""")

# Brand concentration — pitchability score
def render_conc_stores(entries, limit=5):
    sorted_ = sorted(entries, key=lambda x: -sum(x[1].vendors.values()))[:limit]
    return ", ".join(
        f'<a href="https://{s.domain}" target="_blank">{html.escape(s.name or s.domain)[:28]}</a> '
        f'<span class="conc-share">({share*100:.0f}% {html.escape((s.vendors.most_common(1)[0][0] if s.vendors else "")[:15])})</span>'
        for share, s in sorted_
    )

conc_rows = "".join(
    f"""
      <tr>
        <td class="tier-label" style="border-left:4px solid {color}">{html.escape(label)}</td>
        <td class="num">{fmt(len(conc_stores[label]))}</td>
        <td class="tier-examples">{render_conc_stores(conc_stores[label])}</td>
      </tr>"""
    for label, lo, hi, color in CONCENTRATION_BUCKETS
    if conc_stores[label]
)
total_scored = sum(len(v) for v in conc_stores.values())
multi_count = len(conc_stores["Multi-brand assortment (<40%)"])
sections.append(f"""
<section>
  <h2>Brand concentration — who's pitchable?</h2>
  <p class="note">For each store with at least 5 eyewear products, what share of their catalog comes from their single most-stocked brand. <strong>Lower concentration = more open to adding a new brand</strong>. The "Multi-brand assortment" cohort ({fmt(multi_count)} stores, {pct(multi_count, total_scored)} of scored stores) is where Jaxy's outreach should focus first.</p>
  <table class="tier-table">
    <thead><tr><th>Cohort</th><th class="num">Stores</th><th>Examples (top brand they carry shown in parens)</th></tr></thead>
    <tbody>{conc_rows}</tbody>
  </table>
  <p class="note">Note: only stores with ≥5 eyewear products are scored — a store with 1-2 SKUs of one brand isn't necessarily "loyal," just under-sampled. {fmt(len(stores) - total_scored)} stores excluded from this analysis for that reason.</p>
</section>
""")

# White space / extended brand ladder (top 50 by store reach)
extended_top = vendor_global.most_common(50)
total_brand_stores = sum(c for _, c in extended_top)
cumulative = 0
ladder_rows = []
for i, (name, c) in enumerate(extended_top, 1):
    cumulative += c
    cum_pct = 100 * cumulative / sum(vendor_global.values())
    ladder_rows.append(
        f'<tr><td class="num">{i}</td>'
        f'<td>{html.escape(name)}</td>'
        f'<td class="num">{fmt(c)}</td>'
        f'<td class="num">{fmt(vendor_product_counts[name])}</td>'
        f'<td class="num">{cum_pct:.1f}%</td></tr>'
    )
top10_share = 100 * sum(c for _, c in extended_top[:10]) / sum(vendor_global.values())
top25_share = 100 * sum(c for _, c in extended_top[:25]) / sum(vendor_global.values())

sections.append(f"""
<section>
  <h2>Full brand ladder — competitive landscape (top 50)</h2>
  <p class="note">Beyond the top 25, who else has shelf presence? Shows where Jaxy sits on the ladder today (if visible) and which brands populate the long tail vs the heavy hitters. <strong>Top 10 brands capture {top10_share:.0f}% of total brand-store-presence; top 25 capture {top25_share:.0f}%.</strong> The long tail beyond rank ~25 is where most boutiques discover new brands — that's the placement Jaxy is competing for if it isn't already in the top 25.</p>
  <table class="standard">
    <thead><tr><th class="num">#</th><th>Brand</th><th class="num">Stores</th><th class="num">SKUs</th><th class="num">Cumulative store share</th></tr></thead>
    <tbody>{''.join(ladder_rows)}</tbody>
  </table>
</section>
""")

# ─── Focus brand (AJ Morgan) section ────────────────────────────────────────
# focus_store_objs already computed near the top so the background
# section can quote the cohort count.

# 1) Geographic distribution of focus stores
focus_states = collections.Counter()
for s in focus_store_objs:
    c = cohort.get(s.domain, {})
    if c.get("state"): focus_states[c["state"]] += 1

# 2) Price tier distribution — which Jaxy positioning fits
focus_tier_counts = collections.Counter()
for s in focus_store_objs:
    m = store_median(s)
    if m is None: continue
    for label, lo, hi, _ in PRICE_TIERS:
        if lo <= m < hi:
            focus_tier_counts[label] += 1
            break

# 3) Co-occurring brands: which OTHER brands do these stores carry?
# Tells us the competitive set at AJ Morgan-stocking stores.
focus_other_brands = collections.Counter()
focus_other_stores_for = collections.defaultdict(set)
for s in focus_store_objs:
    for vendor, count in s.vendors.items():
        if is_focus_brand(vendor): continue
        if not is_real_brand(vendor): continue   # filter noise here too
        focus_other_brands[vendor] += count
        focus_other_stores_for[vendor].add(s.domain)

# Render the bars by store count (consistent with the main brand chart)
focus_brand_rank = sorted(
    focus_other_stores_for.items(),
    key=lambda x: -len(x[1])
)[:15]

# 4) Sample stores — sorted by AJ Morgan SKU depth (commitment to the brand)
focus_stores_sorted = sorted(
    focus_store_objs,
    key=lambda s: -focus_stores[s.domain]
)

if focus_store_objs:
    # Stat cards for the focus brand
    focus_pct_of_eyewear = pct(len(focus_store_objs), len(stores))

    # Geographic bars
    if focus_states:
        max_fs = focus_states.most_common(1)[0][1]
        fs_rows = "".join(
            bar(c, max_fs, label_left=name, label_right=fmt(c), color="#f59e0b")
            for name, c in focus_states.most_common(10)
        )
        focus_geo_html = f"""
        <h3>Where AJ Morgan stores are located (top 10)</h3>
        <table class="bars">{fs_rows}</table>"""
    else:
        focus_geo_html = ""

    # Price tier breakdown
    if focus_tier_counts:
        max_ft = max(focus_tier_counts.values())
        ft_rows = "".join(
            bar(focus_tier_counts.get(label, 0), max_ft, label_left=label,
                label_right=fmt(focus_tier_counts.get(label, 0)), color=color)
            for label, lo, hi, color in PRICE_TIERS
            if focus_tier_counts.get(label, 0) > 0
        )
        focus_tier_html = f"""
        <h3>Price tier of AJ Morgan stores</h3>
        <p class="note">Tells you where on the wholesale-positioning spectrum AJ Morgan stocking-behaviour clusters. If most are Mid tier, Jaxy positioned in that band matches naturally.</p>
        <table class="bars">{ft_rows}</table>"""
    else:
        focus_tier_html = ""

    # Co-occurring brands — what else lives on AJ Morgan shelves
    if focus_brand_rank:
        max_fb = len(focus_brand_rank[0][1])
        fb_rows = "".join(
            bar(len(domains), max_fb,
                label_left=brand,
                label_right=f"{fmt(len(domains))} stores · {fmt(focus_other_brands[brand])} SKUs",
                color="#8b5cf6")
            for brand, domains in focus_brand_rank
        )
        focus_brands_html = f"""
        <h3>What else lives on AJ Morgan shelves — top 15 co-brands</h3>
        <p class="note">Other brands carried by stores that also stock AJ Morgan. This is Jaxy's <strong>direct competitive set</strong> in the AJ Morgan cohort — these brands have already won the shelf-space argument with these buyers, so any pitch needs to differentiate against them specifically. The ones with the highest store counts are the brands AJ Morgan-loyal buyers feel "go together" with their AJ Morgan stock.</p>
        <table class="bars">{fb_rows}</table>"""
    else:
        focus_brands_html = ""

    # Full store table
    def render_focus_store_row(s):
        c = cohort.get(s.domain, {})
        location = ""
        if c.get("city") and c.get("state"):
            location = f"{c['city']}, {c['state']}"
        elif c.get("state"):
            location = c["state"]
        price_range = ""
        if s.prices:
            price_range = f"${min(s.prices):.0f}–${max(s.prices):.0f}"
        median = store_median(s)
        return f"""
          <tr>
            <td><a href="https://{s.domain}" target="_blank">{html.escape(s.name or s.domain)}</a><div class="subdomain">{html.escape(s.domain)}</div></td>
            <td>{html.escape(location)}</td>
            <td class="num">{focus_stores[s.domain]}</td>
            <td class="num">{s.sg + s.rg}</td>
            <td class="num">{f'${median:.0f}' if median else '—'}</td>
            <td class="num">{html.escape(price_range)}</td>
          </tr>"""

    focus_table_rows = "".join(render_focus_store_row(s) for s in focus_stores_sorted)

    sections.append(f"""
<section style="border: 2px solid #f59e0b">
  <h2 style="color: #f59e0b">🎯 AJ Morgan cohort — warm-lead deep dive</h2>
  <p class="note">Stores in this crawl that already carry <strong>AJ Morgan</strong>. Jaxy purchases buyer lists from AJ Morgan, so this is a <strong>known-warm cohort</strong> — they've already cleared the "will they buy sunglasses wholesale?" question. The job is now to either upgrade their assortment or displace a competing brand on their shelf. Spelling variants normalised: "A.J. Morgan", "AJ MORGAN", "Aj Morgan", "A.J. Morgan Eyewear" all counted as one.</p>

  <div class="stats">
    {stat_card("Stores carrying AJ Morgan", fmt(len(focus_store_objs)), f"{focus_pct_of_eyewear} of all eyewear-carrying stores")}
    {stat_card("Total AJ Morgan SKUs", fmt(focus_total_skus), f"avg {focus_total_skus / max(1, len(focus_store_objs)):.1f} SKUs per store")}
    {stat_card("Multi-SKU stores", fmt(sum(1 for n in focus_stores.values() if n >= 3)), "3+ AJ Morgan SKUs = committed buyer")}
    {stat_card("Cohort hit rate vs total", pct(len(focus_store_objs), len(stores)), "")}
  </div>

  {focus_tier_html}

  {focus_brands_html}

  {focus_geo_html}

  <h3>All {fmt(len(focus_store_objs))} stores carrying AJ Morgan</h3>
  <p class="note">Sorted by AJ Morgan SKU count (most committed buyers first). Total catalog size is total eyewear SKUs found, not the store's whole product range.</p>
  <table class="stores">
    <thead><tr><th>Store</th><th>Location</th><th class="num">AJ Morgan SKUs</th><th class="num">Total eyewear</th><th class="num">Median $</th><th class="num">Eyewear $ range</th></tr></thead>
    <tbody>{focus_table_rows}</tbody>
  </table>
</section>
""")

# Price distribution
max_pb = max(price_bands.values()) if price_bands else 1
band_rows = "".join(
    bar(price_bands[b], max_pb, label_left=b, label_right=fmt(price_bands[b]), color="#10b981")
    for b in PRICE_BAND_ORDER
)
sections.append(f"""
<section>
  <h2>Eyewear retail price distribution</h2>
  <p class="note">First-variant price across all {fmt(len(all_prices))} products with a parseable price. Useful for positioning Jaxy's wholesale pricing against what these boutiques are currently retailing.</p>
  <table class="bars">{band_rows}</table>
  <p class="note">Median per-store median price: <strong>${quantile(store_medians, 0.5):.0f}</strong>. p25: ${quantile(store_medians, 0.25):.0f}. p75: ${quantile(store_medians, 0.75):.0f}.</p>
</section>
""")

# Top states
if state_dist:
    top_states = state_dist.most_common(15)
    max_s = top_states[0][1]
    state_rows = "".join(
        bar(c, max_s, label_left=name, label_right=fmt(c), color="#f59e0b")
        for name, c in top_states
    )
    sections.append(f"""
<section>
  <h2>Geographic concentration (top 15 states)</h2>
  <p class="note">Where the eyewear-carrying boutiques are based, from the cohort firmographic data. Useful for regional outreach prioritization and field rep routing.</p>
  <table class="bars">{state_rows}</table>
</section>
""")

# Top stores by product count
def render_store_row(s):
    cohort_row = cohort.get(s.domain, {})
    location = ""
    if cohort_row.get("city") and cohort_row.get("state"):
        location = f"{cohort_row['city']}, {cohort_row['state']}"
    price_range = ""
    if s.prices:
        price_range = f"${min(s.prices):.0f}–${max(s.prices):.0f}"
    top_vendor = s.vendors.most_common(1)[0][0] if s.vendors else "—"
    cats_str = ", ".join(sorted(s.categories))
    return f"""
      <tr>
        <td><a href="https://{s.domain}" target="_blank">{html.escape(s.name or s.domain)}</a><div class="subdomain">{html.escape(s.domain)}</div></td>
        <td>{html.escape(location)}</td>
        <td>{html.escape(cats_str)}</td>
        <td class="num">{s.sg + s.rg}</td>
        <td class="num">{html.escape(price_range)}</td>
        <td>{html.escape(top_vendor)}</td>
      </tr>"""

top_rows = "".join(render_store_row(s) for s in top_by_products[:25])
sections.append(f"""
<section>
  <h2>Top 25 stores by eyewear product count</h2>
  <p class="note">Stores with the largest eyewear catalogs (capped at 25 products/store during the scrape). These are likely the most established eyewear retailers in the cohort — meaning they're either prime competition or prime wholesale targets depending on the conversation.</p>
  <table class="stores">
    <thead><tr><th>Store</th><th>Location</th><th>Carries</th><th class="num">Products</th><th class="num">Price range</th><th>Top brand</th></tr></thead>
    <tbody>{top_rows}</tbody>
  </table>
</section>
""")

# Stores carrying both
if both_stores:
    both_sorted = sorted(both_stores, key=lambda s: s.sg + s.rg, reverse=True)[:25]
    both_rows = "".join(render_store_row(s) for s in both_sorted)
    sections.append(f"""
<section>
  <h2>Top 25 stores carrying BOTH sunglasses and reading glasses</h2>
  <p class="note">Multi-category eyewear shelves — established programs, not incidental SKUs. {fmt(len(both_stores))} total stores fit this profile.</p>
  <table class="stores">
    <thead><tr><th>Store</th><th>Location</th><th>Carries</th><th class="num">Products</th><th class="num">Price range</th><th>Top brand</th></tr></thead>
    <tbody>{both_rows}</tbody>
  </table>
</section>
""")

# Reading-glasses-only stores
if rg_only:
    rg_sorted = sorted(rg_only, key=lambda s: s.rg, reverse=True)[:15]
    rg_rows = "".join(render_store_row(s) for s in rg_sorted)
    sections.append(f"""
<section>
  <h2>Top 15 reading-glasses-only stores</h2>
  <p class="note">Boutiques selling reading glasses but no sunglasses — could be a different buyer persona (gift shops, lifestyle stores, demographics-driven cohort).</p>
  <table class="stores">
    <thead><tr><th>Store</th><th>Location</th><th>Carries</th><th class="num">Products</th><th class="num">Price range</th><th>Top brand</th></tr></thead>
    <tbody>{rg_rows}</tbody>
  </table>
</section>
""")

# Methodology
sections.append(f"""
<section class="meta">
  <h2>Methodology &amp; data quality notes</h2>
  <ul>
    <li><strong>Source cohort:</strong> {fmt(119305)} US Shopify boutiques surviving the apparel-filter pipeline (status=Active, not founded in 2026, excluded {25} broad categories like Footwear/Athletic/Eyewear-competitors etc., {fmt(100000)} monthly sales cap).</li>
    <li><strong>Detection:</strong> Each store's <code>/products.json</code> feed scanned (up to 10 pages of 250 products = 2,500 products/store) for case-insensitive matches against keyword sets in title, product_type, tags, and (selectively) body_html.</li>
    <li><strong>Sunglasses keywords:</strong> "sunglasses", "sunglass", "sunnies" — body_html matches allowed.</li>
    <li><strong>Reading-glasses keywords:</strong> "reading glasses" / "reading glass" (body matches allowed), plus "readers" (title/type/tag only — too noisy in body copy).</li>
    <li><strong>Per-store cap:</strong> 25 matching products per store. A store with more eyewear products only shows its first 25 in the data — its true count may be higher.</li>
    <li><strong>Vendor filtering:</strong> Brand intelligence (top brands, co-occurrence, concentration, focus cohorts) excludes dropship suppliers and Shopify default placeholders that show up in the <code>vendor</code> field but aren't real brands. Filtered: Printify, Trendsi, "My Store", "mysite", "Default Title", "Shopify", blank/Unknown. {fmt(2264+1780+541+165)} SKUs across these labels were excluded from brand analysis (the products still count toward eyewear inventory totals).</li>
    <li><strong>Reading-glasses retrofit:</strong> The first {fmt(14059)} product rows were captured before the reading-glasses detection landed; they are all tagged as <code>sunglasses</code>. Any store among that cohort that ALSO carries reading glasses would not show readers in the data — a re-sweep with reading-glasses-only logic could close that gap.</li>
    <li><strong>Errors:</strong> {fmt(state_counts['error'])} domains errored ({pct(state_counts['error'], len(latest))}), dominated by "fetch failed" after the proxy bandwidth quota was hit. A retry pass with fresh bandwidth would likely surface ~5K additional eyewear stores.</li>
  </ul>
</section>
""")

# Final HTML
html_out = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sunglasses crawl report — {len(stores):,} stores</title>
<style>
  :root {{
    --ink: #1a1a1a;
    --ink-soft: #555;
    --line: #e5e5e5;
    --bg: #fafafa;
    --card: #fff;
    --accent: #4f7cff;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    margin: 0; background: var(--bg); color: var(--ink); line-height: 1.5;
  }}
  .wrap {{ max-width: 1100px; margin: 0 auto; padding: 32px 24px 96px; }}
  h1 {{ font-size: 28px; margin: 0 0 8px; letter-spacing: -0.02em; }}
  h2 {{ font-size: 18px; margin: 0 0 12px; letter-spacing: -0.01em;
        border-bottom: 1px solid var(--line); padding-bottom: 8px; }}
  .subtitle {{ color: var(--ink-soft); margin: 0 0 24px; max-width: 780px; }}
  .hero {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px;
          padding: 32px; margin-bottom: 32px; }}
  .stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-top: 24px; }}
  .stat {{ background: var(--bg); border-radius: 8px; padding: 16px; }}
  .stat-value {{ font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }}
  .stat-title {{ font-size: 12px; color: var(--ink-soft); text-transform: uppercase;
                  letter-spacing: 0.04em; margin-top: 4px; }}
  .stat-sub {{ font-size: 12px; color: var(--ink-soft); margin-top: 4px; }}
  section {{ background: var(--card); border: 1px solid var(--line); border-radius: 12px;
              padding: 24px; margin-bottom: 24px; }}
  section.meta {{ background: var(--bg); }}
  section.background {{ background: #fffbf4; border-color: #fde68a; }}
  section.background h3 {{ font-size: 14px; margin: 18px 0 6px; letter-spacing: -0.01em; }}
  section.background p {{ font-size: 13.5px; color: var(--ink-soft); line-height: 1.65; margin: 8px 0 12px; max-width: 820px; }}
  section.background ul li {{ font-size: 13.5px; line-height: 1.65; }}
  section.background strong {{ color: var(--ink); }}
  @media print {{
    body {{ background: #fff; }}
    section {{ break-inside: avoid; }}
    .cooc-scroll {{ overflow-x: visible; }}
    table.cooc {{ font-size: 10px; }}
    .wrap {{ padding: 16px; max-width: 100%; }}
  }}
  .note {{ color: var(--ink-soft); font-size: 13px; margin: 8px 0 16px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  table.standard td, table.standard th {{
    padding: 8px 12px; border-bottom: 1px solid var(--line); text-align: left;
  }}
  table.standard th {{ background: var(--bg); font-weight: 600; color: var(--ink-soft);
                       font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }}
  .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  table.bars {{ table-layout: fixed; }}
  table.bars td {{ padding: 4px 8px; vertical-align: middle; }}
  .bar-label {{ width: 200px; font-size: 13px; }}
  .bar-track {{ background: var(--bg); border-radius: 4px; height: 22px; position: relative; }}
  .bar-fill {{ height: 100%; border-radius: 4px; transition: width 0.3s; }}
  .bar-value {{ width: 80px; text-align: right; font-variant-numeric: tabular-nums;
                font-size: 13px; color: var(--ink-soft); }}
  table.stores th {{ background: var(--bg); padding: 8px 12px; text-align: left;
                     font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
                     color: var(--ink-soft); border-bottom: 1px solid var(--line); }}
  table.stores td {{ padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; }}
  table.stores a {{ color: var(--accent); text-decoration: none; font-weight: 500; }}
  table.stores a:hover {{ text-decoration: underline; }}
  .subdomain {{ color: var(--ink-soft); font-size: 11px; margin-top: 2px; }}

  /* Co-occurrence heatmap */
  .cooc-scroll {{ overflow-x: auto; }}
  table.cooc {{ border-collapse: separate; border-spacing: 2px; min-width: 100%; }}
  table.cooc th {{
    font-size: 11px; font-weight: 500; padding: 6px 4px;
    color: var(--ink-soft); text-align: center; min-width: 64px;
  }}
  table.cooc th.cooc-row {{
    text-align: right; padding-right: 12px; min-width: 160px;
    color: var(--ink); font-weight: 500; background: var(--bg);
    border-radius: 4px;
  }}
  .cooc-n {{ color: var(--ink-soft); font-size: 10px; font-weight: 400; }}
  .cooc-col {{ writing-mode: horizontal-tb; }}
  td.cooc-cell {{
    padding: 8px 4px; text-align: center; font-size: 13px;
    font-weight: 500; min-width: 64px; border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }}
  .cooc-sub {{ font-size: 9px; opacity: 0.7; font-weight: 400; margin-top: 2px; }}
  td.cooc-self {{ background: var(--bg); color: var(--ink-soft); text-align: center;
                  border-radius: 4px; }}

  /* Tier / concentration tables */
  table.tier-table {{ width: 100%; border-collapse: collapse; }}
  table.tier-table td, table.tier-table th {{
    padding: 12px; border-bottom: 1px solid var(--line); vertical-align: middle;
  }}
  table.tier-table th {{
    background: var(--bg); font-weight: 600; color: var(--ink-soft);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    text-align: left;
  }}
  .tier-label {{ font-weight: 500; padding-left: 16px !important; }}
  .tier-examples {{ font-size: 12px; line-height: 1.7; color: var(--ink-soft); }}
  .tier-examples a {{ color: var(--accent); text-decoration: none; }}
  .tier-examples a:hover {{ text-decoration: underline; }}
  .conc-share {{ color: var(--ink-soft); font-size: 11px; }}
  ul {{ margin: 0; padding-left: 20px; }}
  ul li {{ margin: 6px 0; font-size: 13px; color: var(--ink-soft); }}
  ul li strong {{ color: var(--ink); }}
  code {{ background: var(--bg); padding: 1px 6px; border-radius: 3px; font-size: 12px; }}
  footer {{ color: var(--ink-soft); font-size: 11px; text-align: center; margin-top: 24px; }}
</style>
</head>
<body>
<div class="wrap">
{''.join(sections)}
<footer>Generated {os.popen('date "+%B %d, %Y at %H:%M %Z"').read().strip()} · {len(products):,} product rows across {len(stores):,} stores · Jaxy</footer>
</div>
</body>
</html>"""

OUT.write_text(html_out, encoding="utf-8")
print(f"\nReport written: {OUT}")
print(f"  open it with:  open '{OUT}'")
