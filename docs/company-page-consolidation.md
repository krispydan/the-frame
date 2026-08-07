# Consolidating the company and customer pages

*Audit, Aug 2026. Written after a retailer's A.J. Morgan history turned out to
be visible on one of their two pages and not the other.*

## The problem in one line

**One retailer has two pages, and neither of them is complete.**

| | `/prospects/[id]` | `/customers/[id]` |
|---|---|---|
| Keyed by | `companies.id` | `customer_accounts.id` **or** `companies.id` |
| Shape | 2,435-line **client** component | 176-line server page + 612-line `CustomerDetail` |
| Exists for | every company | only companies that have ordered |
| Inbound links in the codebase | 13 | 5 |

Which page a retailer "has" depends on whether they ever placed an order. The
sections were then built independently on whichever page the author happened to
be working in, so the two have drifted into showing almost disjoint things:

**Only on `/prospects/[id]`** — Company Info, Store Profile, Tech Stack, Eyewear
Inventory, AI Outreach Openers, Stores & Contacts, Google Maps, Pipedrive,
Campaigns, Notes, Lead Source, Activity (legacy)

**Only on `/customers/[id]`** — Suggested Retention Actions, How They Compare
(benchmarks), Profit by Order, Revenue & Profit per Order, Reorder Prediction,
Health Score History, Churn risk

**On both, implemented twice** — Orders, Activity timeline, Account/Company
details, A.J. Morgan history

The cost is not abstract:

- A customer who is actively buying has **no Google Maps, no Pipedrive, no
  campaign history** on their page — exactly the context a rep needs before
  calling them.
- A prospect with $85k of AJM history has **no profit or benchmark view**.
- Nobody can tell from a link which page they'll land on.
- Every new section forces a choice — "which page does this go on?" — and the
  wrong answer is invisible until someone complains.

The A.J. Morgan bug was a textbook instance: `getAjmHistory` was defined inline
inside `/customers/[id]/page.tsx`, so retailers with AJM history and no Jaxy
orders — precisely the accounts the sales team is meant to be working — saw
nothing. Fixed by moving it to `modules/sales/lib/ajm/history.ts` and calling it
from both. That is the pattern this plan generalises.

## Related findings from the same audit

1. **A dropped column was still being read.** `companies.email` and
   `companies.phone` were removed on 2026-06-19 in favour of `contacts.email`
   and `company_phones`. The prospect API builds its company object with
   `SELECT c.*` and the page renders `company.email` / `company.phone`, so every
   prospect page showed a blank Email and Phone row even when the data existed.
   Fixed. Notably the *libs* all got this right — `icp-classifier`,
   `conversion-scorer`, `lead-resolution` each resolve from the canonical tables.
   Only the page was wrong, because pages hold their own SQL.

2. **Pages hold their own SQL.** Both page files and the prospect API contain
   inline queries. That is how #1 survived: there is no single place where
   "what a company page needs" is defined, so nothing broke visibly when the
   schema moved underneath it.

3. **Hand-maintained lists drift.** Three were found and replaced with schema
   introspection during the merge work (`COMPANY_REF_TABLES`,
   `UNIQUE_PER_COMPANY`, the ops endpoint index). Worth treating as a smell
   wherever a constant enumerates something the database already knows.

4. **Dead weight.** `/prospects/[id]` still renders an "Activity (legacy)" card
   alongside the current Activity card.

5. **`src/__tests__/sales/api-routes.test.ts` has 57 failing tests**, all
   pre-existing and unrelated to this work. They should either be fixed or
   deleted — a red suite trains everyone to ignore the suite.

## The plan

The goal is **one page per retailer, at one URL, with sections that appear when
they have something to say.** A prospect simply has no Profit section; a
customer simply has no "not yet contacted" hint. Nothing is hidden because of
which route you arrived through.

### Phase 1 — one route (small, unblocks everything else)

Make `/companies/[id]` the canonical route, keyed by `companies.id`, and turn
the other two into redirects. `/customers/[id]` already accepts a company id, so
the id space is nearly unified already; the redirect resolves a
`customer_accounts.id` to its `company_id` before forwarding, keeping old
bookmarks and the 18 in-repo links working.

*Ship this alone first.* It changes no rendering and is trivially reversible.

### Phase 2 — one loader

`getCompanyPage(companyId)` in `src/modules/companies/lib/page-data.ts`, returning
named blocks (`identity`, `orders`, `economics`, `ajm`, `gmaps`, `pipedrive`,
`campaigns`, `health`, `activity`…), each `null` when it doesn't apply. All SQL
currently inline in the two page files and the prospect API moves here.

This is where #1 and #2 above stop being possible: one definition of what a
company page reads, exercised by one test.

### Phase 3 — one page, composed of sections

Each section becomes a component under
`src/modules/companies/components/sections/`, taking exactly its own block and
returning `null` when that block is null — the way the new AJM card already
works. The unified page renders every section; ordering is a single array.

Do this section by section, keeping both routes rendering throughout, so it can
be paused at any point.

### Phase 4 — delete the duplicates

One order list, one activity timeline, one AJM section, one details block.
Remove "Activity (legacy)". This phase only removes code.

### Phase 5 — guardrails

- A render test over two fixtures — a pure prospect and a full customer — that
  asserts the expected section set appears for each. Catches "built it on the
  wrong page" at the point of writing it.
- A schema-drift test asserting no column referenced by the page loader is
  missing from the live schema. Catches the class of bug in finding #1
  automatically, instead of a year later.

## Sizing and risk

Phases 1–2 are the high-value, low-risk part and are worth doing as one piece of
work. Phase 3 is the bulk of the effort — it touches the most-used page in the
app — but it is incremental and pausable. Phases 4–5 are cleanup and are cheap
once 3 is done.

The honest risk is Phase 3 half-landing: two routes, two page implementations,
*and* a half-built section library. Mitigation is to keep both routes pointed at
the same unified page from the start of Phase 3, so a pause leaves one page and
a partially-extracted section list rather than a third variant.
