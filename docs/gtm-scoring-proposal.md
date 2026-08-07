# Lead scoring and GTM — a proposal grounded in our own numbers

*August 2026. Prompted by Alex Vacca's signal-scoring thread; written against
the 251,083 leads and 255 customers actually in The Frame.*

---

## The one-paragraph version

We hold **251,083 leads**. They have produced **255 customers** — a 0.10%
conversion rate and **$0.87 of revenue per lead**. Inside that database sits a
sub-population of **1,808 former A.J. Morgan customers**, 0.7% of the total,
which has produced **157 of those 255 customers and 71.6% of all Jaxy revenue**.
An A.J. Morgan account that spent over $20k converts at **48.84%** and is worth
**$1,355 per lead** — 1,221× the conversion rate and 5,420× the revenue per
lead of a record with no A.J. Morgan history. **588 of these accounts, carrying
$2.85M of demonstrated spend, have never placed a Jaxy order**, and **130 of
them are marked "not qualified" in our own system.**

Meanwhile the ICP classifier we score leads with is *anti*-predictive: tier A
converts at 0.02% and tier C at 0.23%. Anyone prioritising by ICP tier is being
pointed at the worst accounts in the database.

The scoring work is not "add more signals". It is: **delete the score we have,
replace it with the one signal that demonstrably works, and stop adding leads.**

---

## Part 1 — What the framework actually says

Alex Vacca (ColdIQ, ~3,000 outbound campaigns for 250+ B2B companies) is
arguing for **signal-based outbound over list-based outbound**. The structure:

**Two scores, not one.**
- **Fit** — firmographics and technographics. Answers *should we ever call
  them?* Produces Tier 1 / 2 / 3, which sets how much effort a lead is worth.
- **Signal** — a live event. Answers *why today?* Funding, a new VP, a tool
  going live, a hiring spike.

Fit decides **depth**; signal decides **timing**. Most teams collapse these into
one number and then can't explain why a "hot lead" has been hot for six months.

**Buying signals, ranked by purchase correlation.** His order:

1. **Former customers and alumni users**
2. New leadership
3. High-intent website visits
4. Tech stack changes
5. Expansion
6. Hiring or downsizing

**Four lead classes** — Inbound, Postbound, Bridgebound, Outbound — where
"Bridgebound" is anything that gives you a non-cold reason to make contact.

The rest of the system (buying-committee mapping, five personalisation buckets,
a four-email sequence, six messaging templates) is downstream of those two ideas.

### What of this transfers to wholesale eyewear, and what does not

You flagged this yourself, and you were right to.

| Does not transfer | Why |
|---|---|
| Buying-committee mapping (champion / economic buyer / technical evaluator / end user) | A boutique has **one** decision maker — the owner. Building a persona map is effort spent on a committee that does not exist. |
| Funding rounds, new VP hires, headcount signals | Independent retailers do not raise a Series A or hire a VP of Anything. |
| Intent data (G2, review sites, visitor de-anonymisation) | No equivalent exists for a shop deciding which sunglasses to stock. |
| Tech-stack change as a buying signal | We tested it. See below — it predicts nothing. |
| "Scale what top performers do" across a large SDR team | The team is small enough that the top performer *is* the team. |

| Does transfer, hard | Why |
|---|---|
| **Former customers as the #1 signal** | We have the cleanest instance of this signal I have ever seen quantified — an entire supplier's book, orphaned, with the person who ran it now working here. See Part 2. |
| Fit and signal as **separate** scores | Directly applicable, and directly missing today. |
| Bridgebound as a category | "A.J. Morgan closed and I now work at Jaxy" is a bridge, not a cold call. |
| Signal decides timing | Wholesale has *stronger* timing structure than SaaS — buying seasons are fixed. |

**The wholesale-native signals that replace the SaaS ones:**

| SaaS signal | Wholesale equivalent we can actually compute |
|---|---|
| Funding round | **Reorder cadence break** — bought every ~90 days, now silent 200 |
| New VP hire | **New store opening / second location** |
| Tool went live | **Season** — sunglasses buy Jan–Apr for spring, readers buy year-round |
| Hiring spike | **Google review velocity** rising (proxy for a shop doing well) |
| Contract renewal date | **The A.J. Morgan gap** — they have a supplier hole to fill |

---

## Part 2 — What our data says

All figures from `/api/admin/ops/gtm`, computed over the live database. Every
rate carries its denominator. Buckets under 20 leads are excluded, because
three leads with one customer reads as 33% and means nothing.

### Baseline

| | |
|---|---|
| Leads | **251,083** |
| Customers | **255** |
| Conversion | **0.10%** |
| Revenue | **$218,989** |
| Revenue per lead | **$0.87** |

### The finding: A.J. Morgan history

| Prior A.J. Morgan spend | Leads | Customers | Conversion | Revenue / lead |
|---|---|---|---|---|
| None | 249,275 | 98 | **0.04%** | $0.25 |
| Under $1k | 1,089 | 26 | 2.39% | $14.23 |
| $1k – $5k | 492 | 65 | 13.21% | $73.96 |
| $5k – $20k | 184 | 45 | 24.46% | $253.13 |
| **$20k+** | 43 | 21 | **48.84%** | **$1,355.11** |

Monotonic across every band. **71.6% of all Jaxy revenue** ($156,732 of
$218,989) comes from accounts with A.J. Morgan history, and **62% of customers**
(157 of 255) — from **0.7% of the database**.

This is Vacca's #1-ranked signal, confirmed on our own data at a magnitude that
dwarfs every other attribute we store.

**The honest caveat.** Part of this lift is effort: we imported these accounts
deliberately, and Christina — who ran A.J. Morgan's wholesale book — works here
and has been calling them. "They convert because we called them" and "they
convert because they are genuinely better prospects" both predict this pattern.

Two things argue it is not purely effort. First, the gradient is monotonic
*within* the A.J. Morgan population, where everyone was equally reachable.
Second, and more decisively: **22 of the 43 accounts in the $20k+ band have
never placed a Jaxy order.** If effort had simply been concentrated on the
biggest accounts, that number would be near zero. Effort has not been thorough
even at the very top.

Either way the implied action is identical: **work the rest of them.**

### The un-worked pool — this is the deliverable

Accounts with **$1,000+ of A.J. Morgan spend and zero Jaxy orders**:

| Band | Accounts | A.J. Morgan spend | Have email | Have phone | **Marked "not qualified"** |
|---|---|---|---|---|---|
| $20k+ | 22 | $679,255 | 20 | 18 | **9** |
| $5k – $20k | 139 | $1,220,663 | 131 | 114 | **21** |
| $1k – $5k | 427 | $948,089 | 389 | 349 | **100** |
| **Total** | **588** | **$2,848,007** | **540** | **481** | **130** |

**92% are reachable by email, 82% by phone.** Nothing needs to be bought,
scraped or enriched to work this list. It exists.

**130 of them are marked `not_qualified` — including 9 of the 22 largest.** We
have actively disqualified former customers of the supplier we are replacing.
That is the single most correctable error in this analysis.

**What it is worth.** Each converted A.J. Morgan account has produced an average
of **$998** in roughly four months of trading. I am deliberately *not*
projecting the band conversion rates onto this pool — the un-worked accounts are
by definition the residual, and the residual is harder than the half that has
already converted. Two scenarios instead:

| Scenario | Assumption | New customers | Revenue (4-month basis) |
|---|---|---|---|
| Conservative | One third of demonstrated band rates | ~34 | ~$34,000 |
| At demonstrated rates | Residual behaves like its band | ~101 | ~$100,000 |

Against a current total book of $218,989, the conservative case is **+16%** and
the upper case **+46%** — from a list we already own, with contact details we
already have.

### The ICP classifier is pointing the wrong way

| ICP tier | Leads | Customers | Conversion |
|---|---|---|---|
| **C** | 15,087 | 35 | **0.23%** |
| B | 2,409 | 1 | 0.04% |
| **A** | 118,518 | 25 | **0.02%** |
| D | 212 | 0 | 0.00% |
| F | 250 | 0 | 0.00% |

**Tier C converts ten times better than tier A.** The score band tells the same
story inverted: 80+ converts at 0.03%, while 60–79 converts at 0.15%.

The tier × source cross-tab explains it: **96,168 of the tier-A leads came from
`shopify_crawl` and produced 5 customers — 0.005%.** The classifier has learned
to label "is a Shopify store that sells apparel" as tier A. That is a
description of a *population*, not a buying signal, and the population is
enormous and nearly inert.

This is worse than having no score. A neutral score wastes nobody's time; an
inverted one actively routes the team to the wrong accounts.

### Assumptions that turned out to be false

**"Shops that already carry eyewear are better prospects."** They are not.

| Already carries eyewear | Leads | Customers | Conversion |
|---|---|---|---|
| Yes | 12,352 | 11 | 0.09% |
| No | 238,731 | 244 | 0.10% |

No difference. We have spent crawler effort building `top_brand`,
`eyewear_sku_count`, `eyewear_top_competitors` and `eyewear_price_range` across
12,352 stores, and none of it separates a buyer from a non-buyer.

**"Bigger, better-reviewed shops are better prospects."** Mixed, and the good
half is weakly powered:

| Estimated yearly sales | Leads | Conversion |
|---|---|---|
| $1M – $5M | 1,255 | **0.32%** |
| $5M+ | 3,731 | 0.29% |
| $250k – $1M | 13,196 | 0.02% |
| Under $250k | 105,733 | 0.03% |

Ten-fold better above $1M, on 124k leads of coverage — this one is real, and it
is the second-best fit signal we have after A.J. Morgan history.

### Two numbers to throw away

Both are reverse causation, and both would look like brilliant findings if
quoted without checking:

- **`source = shopify` converts at 100%** (64 of 64). These company records are
  *created by the Shopify order webhook*. They are customers by construction.
- **"Has a Google Maps listing" converts at 82.81%** (106 of 128). The capture
  job in `gmaps-profile.ts` only targets customers and called-no-order accounts.
  We captured listings *because* they were customers.

Neither is a signal. I flag them because they sit at the top of any naive
sort of this data.

### Where the money actually is: the second order

| Orders placed | Customers | Revenue |
|---|---|---|
| 1 | 155 | $62,966 |
| 2 – 3 | 76 | $94,817 |
| 4 – 6 | 20 | $38,798 |
| 7+ | 4 | $22,408 |

**100 of 255 customers (39%) have reordered, and they account for $156,023 —
71% of revenue.** The four accounts with 7+ orders average $5,602 each, six
times the average customer.

A first order is worth about $406. A customer who reaches a second order is
worth $1,560. **The highest-return work in this business is not lead generation
at all — it is getting order two.**

### Time to first order

| | Customers |
|---|---|
| 0 – 7 days | 60 |
| 8 – 30 days | 23 |
| 31 – 90 days | 82 |
| 91 – 365 days | 48 |

Only **39%** convert within a month. **61% take between one month and a
year** — so a sequence that stops at four emails over three weeks abandons the
majority of eventual buyers before they were ever going to buy.

### Signal coverage — the constraint on any model

| Signal | Leads with it | Coverage |
|---|---|---|
| Email | 149,580 | 60% |
| Phone | 129,386 | 52% |
| Website / domain | 163,430 | 65% |
| ICP tier | 136,476 | 54% |
| Eyewear data | 12,352 | 5% |
| StoreLeads firmographics | 5,637 | 2% |
| Google listing | 4,986 | 2% |

You cannot score on what you do not hold. Any model that leans on Google rating
or firmographics is scoring 2% of the database and guessing at the rest — which
is exactly why the model has to be built on A.J. Morgan history, which we hold
completely for the population that matters.

---

## Part 3 — The proposal

### 3.1 Stop doing these

1. **Stop adding leads.** 96,168 tier-A `shopify_crawl` records produced five
   customers. The database is not short of leads; it is short of *reasons to
   call*. Every additional crawl makes the signal-to-noise worse and the ICP
   score less meaningful.
2. **Turn off the ICP tier as a prioritisation input** today, before rebuilding
   it. It is inverted. Leaving it visible while knowing that is a trap for
   whoever uses it next.
3. **Stop enriching the whole database.** Enrich the 588, and the accounts that
   clear the fit bar. Enrichment across 251k records is where the budget goes
   and it buys signals that do not separate buyers from non-buyers.

### 3.2 Replace the score: fit × signal

Two numbers, kept separate, each traceable to something measured above.

**Fit (0–100) — should we ever call them?**

| Input | Points | Grounded in |
|---|---|---|
| A.J. Morgan spend ≥ $20k | **60** | 48.84% observed conversion |
| A.J. Morgan spend $5k – $20k | 45 | 24.46% |
| A.J. Morgan spend $1k – $5k | 30 | 13.21% |
| A.J. Morgan spend under $1k | 12 | 2.39% |
| No A.J. Morgan history | 0 | 0.04% |
| Estimated yearly sales ≥ $1M | +10 | 0.32% vs 0.03% |
| Reachable by email **and** phone | +10 | 0.13%/0.15% vs 0.06%/0.05% |
| Reachable by one of the two | +5 | — |
| United States | +5 | no conversions from any non-US bucket of 20+ leads |
| Estimated yearly sales under $250k | −5 | 0.03% |

Deliberately **not** included: ICP tier (inverted), eyewear inventory (no
effect), Google rating (2% coverage, biased sample), ecommerce platform (0.04%,
i.e. the population).

**Signal (0–40) — why today?**

| Trigger | Points |
|---|---|
| Replied to outreach (`instantly_pull`) | 15 |
| Reader-led A.J. Morgan buyer, and readers just launched | 15 |
| Lapsed against their own A.J. Morgan cadence (silent > 1.5× their median gap) | 10 |
| In-season for their category (sunglasses: Jan–Apr) | 10 |
| New or newly-expanded store | 5 |

`instantly_pull` earns its 15 empirically — 493 leads, 25 customers, **5.07%**,
50× baseline. It is the only outbound-response signal in the data and it works.

**Tiers, and what each is worth doing:**

| Tier | Fit | Population | Treatment |
|---|---|---|---|
| **1** | ≥ 45 | 227 accounts — **161 not yet customers** | Named owner. Phone first, personal email second. Christina's relationships. Weekly review. |
| **2** | 30 – 44 | 492 — **427 not yet customers** | Sequenced email over **90 days**, one call. |
| **3** | 12 – 29 | 1,089 — **1,063 not yet customers** | Email only, low frequency. |
| **4** | < 12 | ~249,275 | **Do not work.** Leave in the database as a search index. |

The whole of tiers 1–3 is 1,808 accounts. That is the real target market, and
it is small enough to work properly.

### 3.3 Fix the own-goal first

**Re-qualify the 130 A.J. Morgan accounts marked `not_qualified`**, starting
with the 9 in the $20k+ band. This is an afternoon's work and it is the highest
expected value action in this document.

### 3.4 Sequence length must match the data

39% of buyers convert within 30 days; **61% take between one month and a year**.
The standard four-email, three-week sequence is calibrated for the first group
and abandons the second. Tier 1 and 2 sequences should run **90 days minimum**,
with a seasonal re-entry each January (sunglasses buying) rather than a
break-up email.

### 3.5 Chase order two, not just order one

A first order is worth $406; a customer who reaches a second is worth $1,560.
155 customers are sitting on exactly one order. That is the cheapest revenue in
the business and nothing currently triggers on it.

Concretely: a reorder-due alert at 1.5× a customer's own median inter-order gap,
routed the same way a Tier 1 lead is.

### 3.6 What to build in The Frame

In order of value per hour of work:

1. **`fit_score` and `signal_score` columns**, computed from the table above,
   with the inputs stored alongside so the number is auditable. Replace ICP tier
   in every list, sort and filter.
2. **A Tier 1 worklist** — the 161 accounts, sorted by A.J. Morgan spend,
   showing last contact and next action. This is the sales team's home page.
3. **The re-qualification queue** — the 130 wrongly disqualified accounts.
4. **Reorder-due alerts** on a customer's own cadence.
5. **A signal feed** — lapsed cadence, season entry, new store — that writes
   into the existing activity timeline so a trigger and its outcome sit in one
   place.
6. **Retire the ICP classifier**, or retrain it against `converted` as the
   label. It currently learns "looks like our database", which is why it scores
   the whole database highly.

### 3.7 How we will know it worked

Track two numbers monthly, both of which we can compute today:

- **Tier 1 coverage** — share of the 161 top-fit accounts contacted in the last
  90 days. Today this is unmeasured, and 22 of the 43 largest have never been
  touched.
- **Revenue per worked account**, by tier. If the model is right, tier 1 should
  clear $250/account and tier 4 should stay near zero. If tier 4 ever
  outperforms, the model is wrong and this document should be rewritten.

---

## Appendix — reproducing this

`GET /api/admin/ops/gtm` with `x-ops-key`. Read-only, ~8 seconds, returns every
table above with denominators. The two reverse-causal artifacts (`source =
shopify`, "has a Google listing") are present in the output and are *not*
filtered out — they are left visible precisely so the next person to read it
has to reckon with them rather than rediscover them.
