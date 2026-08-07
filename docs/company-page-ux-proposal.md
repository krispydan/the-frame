# Redesigning the company page

*A UX + IA proposal for `/prospects/[id]`, Aug 2026.*
*Companion to [`company-page-consolidation.md`](./company-page-consolidation.md) — that
document decides **where the page lives**; this one decides **what the page is**.
Everything here is written against the section-per-block architecture of its Phase 3.*

---

## 1. The verdict

The page is not badly designed. It is **undesigned** — it is a chronological
accretion of every field anyone ever added, each wrapped in its own `<Card>`,
each with its own accent colour, all rendered at the same visual weight. There
is no answer on this page to "what matters?", because the page has never been
asked.

Concretely: **15 full-width cards, 5,172px tall on a 390px phone**. A rep who
opens this before dialling has to scroll past a Store Profile, a Tech Stack, an
AI-openers card and a Google Maps panel to find out whether the shop is worth
calling — and then scroll all the way back up to find the phone number, which
is rendered as plain text overlapping an email address.

The fix is not styling. It is deciding that this page has **one primary job**
and building the first screenful around it.

## 2. Who opens this page and why

Three jobs, in frequency order, from the brief:

| # | Job | When | What they need |
|---|-----|------|----------------|
| **A** | **Prepare and place a call / send an email** | 20× a day, on an iPhone, between calls | Are they open? Are they worth it? What do I open with? What's the number? |
| **B** | **Check what a shop has bought** | Before a reorder conversation | AJM spend + what categories, Jaxy orders |
| **C** | **Log what happened** | Immediately after A | One note field, one status change, zero scrolling |

Everything else on this page — StoreLeads firmographics, Shopify app lists,
cluster domains, StoreLeads IDs, enrichment buttons, ICP reasoning — serves
**job D: occasional research and data hygiene**. Job D currently occupies about
60% of the vertical space and 100% of the first screenful after the header.

**The design principle for this document:** jobs A, B and C get the screen.
Job D gets a collapsed row with a chevron.

## 3. Root causes (read this before touching any component)

Five mechanical faults explain most of the visible damage. Fixing them fixes
things that look like a dozen separate bugs.

### 3.1 The page pays for its padding twice

`src/app/(dashboard)/layout.tsx` already wraps children in
`<main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">`. The page then
opens with `<div className="p-4 md:p-6 …">` (line 528). On a 390px iPhone:

```
390  viewport
-32  main p-4
-32  page p-4
-32  CardContent px-4
= 294px of usable content width
```

Then `grid grid-cols-2 gap-4` (line 1035) splits that into **two 139px
columns**, of which the icon and gap eat 24px, leaving **115px for a value**.
`village.pharmacy@hotmail.co.uk` needs roughly 190px at `text-sm`. That is
defect #1 — not a truncation bug, an arithmetic one.

**Remove the page-level `p-4 md:p-6` entirely.** It is 64px of pure loss.

### 3.2 `InfoRow` cannot shrink

```tsx
// page.tsx:2296 — the inner <div> has no min-w-0
<div className="flex items-start gap-2">
  <span className="text-gray-400 mt-0.5">{icon}</span>
  <div>                                   {/* ← missing min-w-0 */}
    <p className="text-xs text-gray-500">{label}</p>
    <p className="…">{value}</p>          {/* ← no truncate, no break */}
  </div>
</div>
```

A flex item's default `min-width: auto` means this div refuses to shrink below
its content. It overflows its 139px grid cell and **paints on top of the next
column**. That is the literal mechanism behind
`village.pharmacy@hotmail01937572388`. Every two-column fact grid on the page
has this bug.

### 3.3 iOS is inventing links

There is no `formatDetection` in the root `metadata` export
(`src/app/layout.tsx`). Mobile Safari therefore auto-detects addresses and
phone numbers in plain text and renders them as underlined blue links (defect
#7) — links we didn't author, styled in a way we don't control, sitting next to
real links so nothing reads as trustworthy.

### 3.4 A `shrink-0` action cluster is eating the company name

Header row 1 (line 596) is `flex … justify-between` with a `shrink-0` action
group holding up to **four buttons** (View in Pipedrive, Edit, Lost, Won).
Those buttons are ~340px wide and refuse to shrink; the identity block has
`min-w-0` and an `h1` with `truncate`, so it absorbs all the loss. At 390px the
name has nowhere to go and renders as `T..` (defect #2).

The buttons win the layout argument because the markup says they should. The
fix is not `text-xs` — it is deciding that **terminal actions do not belong in
a mobile header at all**.

### 3.5 Colour carries no information

Section icons currently use blue (Store Profile, Campaigns), cyan (Tech Stack),
purple (Eyewear), amber (AJM, AI openers), red (Google Maps), green (Orders,
Pipedrive), orange, pink, indigo, sky and emerald across the chip rows. None of
these encode anything. Meanwhile *actual* state — permanently closed, bounced
email, disqualified — competes for attention with a cyan briefcase.

---

## 4. Additional defects found during this audit

These are not in the original list. Several are functional bugs, not cosmetics.

| # | Where | Problem |
|---|-------|---------|
| **E1** | `page.tsx:778`, `:798` | ICP save and Reclassify do `setCompany(await cr.json())` — assigning the **whole API envelope** (`{ajmHistory, company, stores, …}`) to `company`. Every subsequent read (`company.name`, `company.status`) is `undefined`, so saving an ICP tier blanks the page until reload. `updateCompany()` at line 411 does this correctly (`data.company`); these two do not. |
| **E2** | `page.tsx:1027` | The Not-Qualified banner tests `company.status === "rejected"`, but the codebase's own comment at line 457 says `"rejected"` is not a valid enum value and `confirmDisqualify` writes `not_qualified`. **The disqualify reason is never displayed.** |
| **E3** | `page.tsx:1045`, `:1545` | `{company.google_rating && (…)}` — when the rating is `0`, React renders the number `0` as a bare text node in the grid. Same for `primaryStore.google_rating`. |
| **E4** | `page.tsx:2402` | The contact Edit button is `opacity-0 group-hover:opacity-100`. **There is no hover on iPhone.** Contacts are uneditable on mobile. |
| **E5** | `page.tsx:646`, `:659`, `:791`; `gmaps-panel.tsx:341` | `window.confirm` / `window.prompt` for Won, Lost, Reclassify and "wrong business". These are blocked in several in-app browsers, unstyleable, and on iOS look like a system error. |
| **E6** | `page.tsx:731`, ICP editor | The score input is labelled **"Score (0–10)"** and `min=0 max=10`, but real data shows `65`. Either the label is wrong or the classifier writes a different scale. Whichever it is, the editor currently rejects real values. |
| **E7** | Everywhere | `bg-blue-50 text-blue-700` social chips, `bg-red-50 text-red-800` closure banner (`gmaps-panel.tsx:230`), `bg-blue-50/50` edit card, `bg-green-50/50` add-contact form — **no `dark:` variants.** Dark-grey text on near-white in dark mode. |
| **E8** | `page.tsx:2009` | `focus:rows-3` is not a Tailwind class. Dead. |
| **E9** | `page.tsx:517–525` | `sourceColorMap` is defined and never used. `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Tag`, `MessageSquare` are imported and never used. |
| **E10** | `page.tsx:1413` | Sample products are `grid-cols-1 sm:grid-cols-3` — on mobile that's three stacked `h-32` images, ~440px of vertical space for decoration. |
| **E11** | `page.tsx:2395` | The contact meta line (`title · email · phone`) is `flex items-center gap-3` with no `min-w-0` — the same overflow bug as 3.2, which is where `01937572...` comes from. |
| **E12** | Throughout | Every mutation triggers a full `GET /api/v1/sales/prospects/[id]` refetch — adding one contact re-downloads 50 activities, all orders and the full AJM history. |
| **E13** | `page.tsx:606`, `:611`, `:1055`+ | `target="_blank"` without `rel="noopener noreferrer"` on most external links. |

---

## 5. Information architecture

### 5.1 The model: Ribbon → Brief → Log → Reference

Four zones, in strict priority order. This ordering is the whole proposal;
layout and styling follow from it.

```
┌─ RIBBON ───────── sticky, always visible ──────────────┐
│  ← | Avatar  The Village Pharmacy        [Qualified ▾] │  identity + state + one
│      Wetherby · Optician                          [⋯]  │  escape hatch + overflow
└────────────────────────────────────────────────────────┘
┌─ BRIEF ───────── the first screenful. never collapsed ─┐
│  ⚠ alerts (only when true)                             │
│  📞 01937 572388            ✉ village.pharmacy@…       │  reach: full-width rows
│  ┌────────┬────────┬────────┬────────┐                 │
│  │ AJM    │ Jaxy   │ Google │ Last   │                 │  signal: 4 stat tiles
│  │ $8.4k  │ —      │ 4.6★82 │ 3d ago │                 │
│  └────────┴────────┴────────┴────────┘                 │
│  “Saw you're stocking Ray-Ban and Vogue…”      talking  │  one opener line
│  Emailed 3 Aug in Cold UK Q3 · opened ×2      last touch│
└────────────────────────────────────────────────────────┘
┌─ LOG ────────── what they do after the call ───────────┐
│  [ Add a note…                                    ]    │
│  Activity timeline (filters, 10 most recent)           │
└────────────────────────────────────────────────────────┘
┌─ REFERENCE ─── collapsed accordion / desktop tabs ─────┐
│  › Contacts & locations (2)                            │
│  › Buying history — AJM $8.4k · 12 orders              │
│  › Store intel — Shopify · 42 eyewear SKUs             │
│  › Google listing — 4.6★ · open now                    │
│  › Outreach — 1 campaign · not in Pipedrive            │
│  › Admin — source, tags, ICP reasoning, enrichment     │
└────────────────────────────────────────────────────────┘
┌─ ACTION BAR ─── fixed bottom, mobile only ─────────────┐
│      📞 Call        ✉ Email        ✎ Log               │
└────────────────────────────────────────────────────────┘
```

### 5.2 Card-by-card disposition

Every one of the current 15 cards gets an explicit verdict. **No card survives
unchanged.**

| Current card | Verdict | Where it goes |
|---|---|---|
| Prev/Next nav bar | **Demote** | `hidden md:flex` inside the ribbon. Arrow-key walking is a desktop behaviour; on a phone it's a row of grey chevrons nobody taps. |
| In-page breadcrumb | **DELETE** | The global header already renders `Home › Sales › Prospects › The Village Pharmacy` (and already receives the company name via `setOverride`). Replace with a single ← icon-button in the ribbon that preserves `?filters`. |
| Header row 1 (identity + Won/Lost/Edit/Pipedrive) | **Rebuild** | Split: identity → ribbon; Won/Lost → Log Outcome sheet; Edit → overflow; Pipedrive link → Outreach section. |
| Header row 2 (ICP chip, status chip, Google Maps, StoreLeads) | **Split** | ICP + status chips → ribbon. The two enrichment buttons → overflow menu (`⋯`). They are data-hygiene actions, not call actions. |
| Edit mode card | **Rebuild** | A `Sheet` (mobile) / `Dialog` (desktop) opened from the overflow menu, not an inline card that shoves the page down. |
| Faire mapping banner | **Keep, compact** | Promote into the Brief's alert slot. It's conditional and genuinely blocking. Trim to one sentence + two inputs; drop the "See all Faire customers" link (it belongs on the list page). |
| **Company Info** | **DISSOLVE** | Email/phone/website → Brief reach block. Address → Contacts & locations (once). Owner → ribbon overflow. Rating → Brief signal tile. Social chips → Contacts section, icon-only. Tags + ICP reasoning → Admin. **The card ceases to exist.** |
| **Store Profile** (StoreLeads) | **Demote + halve** | → Store intel. Keep: platform, employees, est. yearly sales, avg product price, one description. **DELETE from the UI:** meta_description (show `description` only — showing both is showing the same sentence twice), StoreLeads ID, "First seen by StoreLeads", monthly pageviews (redundant with monthly visits), cluster domains. |
| **Tech Stack** | **Demote** | → Store intel, as a 6-badge row + "+ 24 more" disclosure. **DELETE** the italic footer "Useful as an opener anchor — e.g. …". If it's useful, the badge is the useful part; the essay is not. |
| **Eyewear Inventory** | **Demote, keep the good bit** | → Store intel. Top brand, categories, SKU count, price range and competitors are strong pre-call material — keep them as facts. Sample product images → `grid-cols-3` at **all** widths (three 90px thumbnails, not three 400px stacks). |
| **AI Outreach Openers** | **Promote one line** | The *first* opener becomes the Brief's talking-point line. The full card (both openers, model, date) → Outreach section. **DELETE** the `{{ai_opener_email1}}` template-variable footnote — that's implementation trivia for one person. |
| **Store & Contacts** | **Rebuild** | → Contacts & locations. One address, tap-to-call phone, contacts as tappable rows with visible (not hover-gated) edit affordance. |
| **Orders** | **Merge** | → Buying history, unified with AJM under one heading with a source column. A rep asking "what have they bought" does not care which of our two systems knows it. |
| **A.J. Morgan history** | **Merge + fix** | → Buying history (see §8, defect 10). Headline number promoted to a Brief stat tile. |
| **Pipedrive panel** | **Demote** | → Outreach section. When `!synced`, render **nothing** but a "Push to Pipedrive" button in the section's action row. **DELETE** the "This company isn't in Pipedrive yet." card. |
| **Google Maps panel** | **Demote, hoist the alert** | → Google listing section. The *only* thing that escapes: `permanentlyClosed` / `temporarilyClosed`, which becomes a Brief alert. Rating + review count become a Brief stat tile. |
| **Activity** | **Promote** | Zone 3, second only to the Brief. Merge the note composer into its header so "log what happened" is one motion. |
| **Campaigns** | **Demote** | → Outreach. Empty state renders `null`. |
| **Notes** | **Merge** | Composer → Activity header. Existing note text → an activity-timeline-style block, newest first (it's already stored newest-first with `[timestamp]` prefixes). Kill the standalone card. |
| **Lead Source** | **Demote** | → Admin. |
| **Activity (legacy)** | **DELETE** | 150 lines behind `{false && …}` (line 2068). Already flagged as dead weight in the consolidation audit. |

### 5.3 What the Brief contains, exactly

This is the contract. An engineer should be able to build it from this table.

| Slot | Source | Rule |
|---|---|---|
| **Alerts** | `gmapsListing.permanentlyClosed`, `.temporarilyClosed`, `company.status === "not_qualified"` + `disqualify_reason`, `faireMapping.needed`, `email_verification_status === "invalid"` | Render 0–2. Never a placeholder. Closure outranks everything. |
| **Phone** | `company.phone` (already resolved from `company_phones` by the API) → fall back to `primaryStore.phone` → `contacts[0].phone` → `gmapsListing.phone` | `<a href={telHref(p)}>`, `text-lg font-medium tabular-nums`, formatted with spaces. |
| **Email** | `company.email` (resolved from `contacts`) → `contacts.find(is_primary)?.email` | `<a href="mailto:">`, `truncate`, plus a copy icon-button. |
| **Website** | `company.domain \|\| company.website` | Domain only, never the full URL. |
| **Stat 1 — AJM** | `ajmHistory.revenue` / `.orders` | `$8.4k` over `12 orders`. Omit tile entirely if `ajmHistory == null`. |
| **Stat 2 — Jaxy** | `orderSummary.total_revenue` / `.order_count` | Omit if 0 orders. |
| **Stat 3 — Google** | `google_rating`, `google_review_count` | `4.6★` over `82 reviews`. Omit if null **or 0** (see E3). |
| **Stat 4 — Last touch** | `activities[0].created_at` | `3d ago`. If no activities: `Never contacted`. |
| **Talking point** | `ai_opener_email1` → else `top_brand` + `eyewear_categories` → else `gmaps.categoryName` → else first sentence of `description` | Exactly one. `line-clamp-2` with a "more" disclosure. Label it with its provenance (`AI opener` / `Carries` / `Google`). |
| **Last touch line** | `activities[0]` rendered through the existing `EVENT_CATALOG` in `prospect-activity-timeline.tsx` | Reuse `specFor(a.event_type).render(data).body`. Do not write a second renderer. |

**A tile with no data does not render an em-dash. It does not render.** If only
two of the four have values, show two. A 2-up grid of real numbers beats a 4-up
grid of placeholders.

---

## 6. Layout

### 6.1 Mobile (`< 768px`, designed at 390px)

Single column. **No `grid-cols-2` anywhere below `sm:`.** That rule alone kills
defects 1 and 11's cramped variants.

```tsx
// company-page-shell.tsx
<div className="min-w-0 pb-24 md:pb-0">          {/* pb-24 clears the action bar */}
  <CompanyRibbon … />
  <div className="space-y-4 md:space-y-6">
    <CompanyBrief … />
    <ActivitySection … />
    <ReferenceSections … />
  </div>
  <CompanyActionBar … />                          {/* md:hidden */}
</div>
```

Note: **no `p-4`** — `<main>` supplies it.

**Ribbon** — sticky. `<main>` is the scroll container (`overflow-auto p-4`), so
the ribbon must bleed through that padding:

```tsx
<header className="sticky top-0 z-30 -mx-4 -mt-4 mb-4 border-b bg-background/95 px-4 py-3
                   backdrop-blur supports-[backdrop-filter]:bg-background/80
                   md:-mx-6 md:-mt-6 md:px-6">
  <div className="flex items-start gap-3">
    <Button variant="ghost" size="icon-sm" className="-ml-1 shrink-0"
            render={<Link href={`/prospects${navSuffix}`} aria-label="Back to prospects" />}>
      <ArrowLeft />
    </Button>
    <div className="min-w-0 flex-1">
      <h1 className="text-lg font-semibold leading-tight md:text-2xl
                     [overflow-wrap:anywhere] line-clamp-2">{company.name}</h1>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">
        {joinPlace([company.city, company.state])}
        {storeKind && <> · {storeKind}</>}
      </p>
    </div>
    <DropdownMenu>…<Button variant="ghost" size="icon-sm"><MoreHorizontal /></Button>…</DropdownMenu>
  </div>
  <div className="mt-2 flex flex-wrap items-center gap-1.5">
    <StatusChip … /> <IcpChip … />
  </div>
</header>
```

Decisions embedded above:
- **`line-clamp-2`, not `truncate`.** A wholesale shop name is the primary
  identifier; two lines is cheap and `T..` is worthless.
- **No avatar on mobile.** The gradient square is 56px of decoration competing
  with the name for 390px. Bring it back at `md:` as `size-10`.
- **`[overflow-wrap:anywhere]`** so a long unspaced name breaks rather than
  forcing a horizontal scroll.
- Prev/next: `hidden md:flex` on the right of the ribbon, icon-only.

**Brief** — a card whose *content* is single-column but whose stat strip is a
2×2 grid (four 130px tiles fit comfortably; four values in one row do not):

```tsx
<Card>
  <CardContent className="space-y-4 pt-4">
    <AlertStack alerts={alerts} />
    <div className="space-y-2">
      <ReachRow icon={<Phone/>} href={telHref(phone)} value={formatPhone(phone)}
                className="text-lg tabular-nums" />
      <ReachRow icon={<Mail/>}  href={`mailto:${email}`} value={email} copyable truncate />
      <ReachRow icon={<Globe/>} href={siteHref} value={domain} external />
    </div>
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map(t => <StatTile key={t.key} {...t} />)}
    </div>
    <TalkingPoint … />
    <LastTouch … />
  </CardContent>
</Card>
```

`ReachRow` is `flex items-center gap-3 min-w-0` with the value in a
`min-w-0 flex-1 truncate` span. **`min-w-0` on both the flex container and the
text child is non-negotiable** — that's §3.2.

**Reference sections** — native `<details>`, not a JS accordion. The repo
already uses `<details>` for tags and AJM order rows; it costs nothing, works
without hydration, and is keyboard- and screen-reader-correct:

```tsx
<details className="group rounded-xl bg-card ring-1 ring-foreground/10">
  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-4 py-3
                      [&::-webkit-details-marker]:hidden">
    <Icon className="size-4 shrink-0 text-muted-foreground" />
    <span className="text-sm font-medium">{title}</span>
    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform
                            group-open:rotate-180" />
  </summary>
  <div className="border-t px-4 py-4">{children}</div>
</details>
```

The `summary` prop is what makes collapsing acceptable: **`Buying history — AJM
$8.4k · 12 orders`** tells the rep whether opening it is worth a tap. A row
that just says "Buying history" is a lottery ticket.

`min-h-11` (44px) is the iOS touch-target minimum. Note that shadcn `Button`
defaults to `h-8` (32px) and even `size="lg"` is only `h-9` — **every tappable
control in the mobile layout needs an explicit `h-11`/`min-h-11`.**

**Action bar** — the answer to defect 12:

```tsx
<div className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur
                px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
  <div className="grid grid-cols-3 gap-2">
    <Button className="h-11" variant="outline" disabled={!phone}
            render={<a href={telHref(phone)} />}><Phone /> Call</Button>
    <Button className="h-11" variant="outline" disabled={!email}
            render={<a href={`mailto:${email}`} />}><Mail /> Email</Button>
    <Button className="h-11" onClick={() => setLogOpen(true)}><PenLine /> Log</Button>
  </div>
</div>
```

`env(safe-area-inset-bottom)` matters — without it the bar sits under the iPhone
home indicator. The page shell needs `pb-24 md:pb-0` so the last section isn't
trapped behind it.

**Log sheet** — one `Sheet side="bottom"`, the single place job C happens:
note textarea (autofocus), a row of disposition chips that prefix the note
(`No answer` / `Left voicemail` / `Spoke — interested` / `Spoke — not now` /
`Wrong number`), a status `Select`, and — at the bottom, in an outlined
`Won`/`Lost` pair — the terminal actions. This is where defect 6's buttons go.
They are the last thing in a sheet you had to open on purpose, which is exactly
the prominence a one-way door deserves.

### 6.2 Desktop (`≥ 1024px`)

Genuinely different, not a widened stack.

```tsx
<div className="mx-auto max-w-[1200px]">
  <CompanyRibbon />                        {/* full width, sticky, with prev/next */}
  <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
    <div className="lg:col-span-8 space-y-6">
      <CompanyBrief />                     {/* stat tiles go 4-up here */}
      <ReferenceTabs />                    {/* Overview | Buying | Intel | Outreach | Admin */}
    </div>
    <aside className="lg:col-span-4 lg:sticky lg:top-20 lg:self-start space-y-4">
      <ContactCard />                      {/* phone, email, contacts, one address */}
      <ActivitySection compact />          {/* note composer + timeline */}
    </aside>
  </div>
</div>
```

Two deliberate differences from mobile:

1. **Reference is tabs, not an accordion.** At 1200px a horizontal tab bar is
   free and scannable; on 390px it's a scroll-snapping strip that hides half its
   options. Use `Tabs` from `@/components/ui/tabs` (Base UI, already imported
   and currently unused). Persist the selected tab in a `?tab=` search param so
   a link to "their buying history" is shareable.
2. **Activity is pinned in a sticky rail, never behind a tab.** Logging is job
   C; it must be reachable from any tab without losing your place. `lg:top-20`
   clears the sticky ribbon.

Between 768 and 1024: single column, but stat tiles go 4-up and fact grids go
`sm:grid-cols-2`. The bottom action bar disappears at `md:` because the reach
block is already on screen.

### 6.3 The one grid rule

Every fact grid on the page becomes:

```
grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3
```

with every cell `min-w-0`. Not `grid-cols-2` at 390px. Ever. This single
substitution fixes the collision class of bug in Company Info, Store Profile,
Eyewear Inventory, Store & Contacts and the edit form simultaneously.

---

## 7. Visual system

### 7.1 Colour: four meanings, no decoration

Replace the seven-colour icon rainbow with a rule:

| Role | Token | Used for |
|---|---|---|
| **Neutral** | `text-muted-foreground` | **All** section icons. Every one. |
| **Positive** | `emerald-600 / dark:emerald-400` | Won, customer, revenue figures, "pushed" chips |
| **Attention** | `amber-600 / dark:amber-400` | Temporarily closed, unverified email, needs mapping |
| **Danger** | `destructive` (token) | Permanently closed, bounced, unsubscribed, Lost |
| **Interactive** | `primary` | Links and primary buttons only |

Rule: **colour means state, never category.** A card about eyewear is not
purple. Google Maps is not red. If two things are the same colour they mean the
same kind of thing.

The AJM `text-amber-700` revenue figure moves to emerald — it's money, and
amber now means "attention". `tierColors` for ICP (`A` green → `F` grey) stays;
that's an ordinal scale, which is a legitimate use of hue.

### 7.2 Dark mode

Fix E7 by banning bare `-50`/`-100` backgrounds. Every tinted surface uses the
pattern already correct in `company-status-display.ts`:

```
bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300
```

Specifically to fix: the five social chips (page.tsx:1055–1078), the closure
banners (gmaps-panel.tsx:230, 235), the edit card `bg-blue-50/50` (941), the
add-contact form `bg-green-50/50` (2414), the edit-contact form `bg-blue-50/50`
(2361), and every `text-gray-*` in `gmaps-panel.tsx` and `pipedrive-panel.tsx`
(these should be `text-muted-foreground` / `text-foreground`).

**Prefer semantic tokens** (`muted-foreground`, `card`, `border`, `foreground`)
over `gray-N` throughout. The page currently mixes `text-gray-500` with
`text-muted-foreground` in adjacent lines; they are not the same colour in dark
mode.

### 7.3 Typography and density

- Section titles: `text-sm font-medium` (currently `text-base` — too loud for a
  collapsed row).
- Facts: label `text-xs text-muted-foreground`, value `text-sm font-medium`.
- Money and phone numbers: `tabular-nums`. Non-negotiable for scanning.
- One card radius (`rounded-xl`, the `Card` default), one border treatment
  (`ring-1 ring-foreground/10`). The page currently mixes `rounded-md`,
  `rounded-lg`, `rounded-r-lg` and `border` inconsistently.
- Delete the `animate-pulse` "NEW" badges (E7 in the original card, page.tsx:2303).
  A 30-second pulsing badge on six fields at once is a seizure risk and it
  communicates nothing a rep acts on. If provenance matters, use a static
  `text-emerald-600` dot with a `title`.

### 7.4 Empty states

**A section with no content renders `null`.** Not a card with grey text. This
one rule deletes five cards' worth of vertical space (defect 11).

Where an empty section still has an *action* (add to campaign, push to
Pipedrive, add a contact), those actions collect in **one** row at the bottom of
the Reference zone:

```tsx
<div className="flex flex-wrap gap-2">
  <Button variant="outline" size="sm">Add to campaign</Button>
  <Button variant="outline" size="sm">Push to Pipedrive</Button>
  <Button variant="outline" size="sm">Add contact</Button>
</div>
```

Three buttons in 40px, replacing three cards in 300px.

---

## 8. Defect table

| # | Defect | Fix | Where |
|---|---|---|---|
| 1 | Email/phone collide (`village.pharmacy@hotmail01937572388`) | Three compounding causes: remove the page's duplicate `p-4 md:p-6` (§3.1); add `min-w-0` to `InfoRow`'s inner div **and** `truncate` to the value (§3.2); replace `grid-cols-2` with `grid-cols-1 sm:grid-cols-2` (§6.3). In the new design email/phone are full-width `ReachRow`s in the Brief and never share a row on mobile. | `page.tsx:528, 1035, 2296` |
| 2 | Name truncated to `T..` | Remove the `shrink-0` four-button cluster from the header (§3.4); Won/Lost → Log sheet, Edit/Pipedrive → overflow menu. `h1` becomes `line-clamp-2 [overflow-wrap:anywhere]`, not `truncate`. Drop the 56px avatar below `md`. | `page.tsx:596–671` |
| 3 | `"Wetherby,"` trailing comma | `joinPlace(parts: (string\|null)[])` in `modules/companies/lib/format.ts` — `parts.map(s => s?.trim()).filter(Boolean).join(", ")`. Replace the three hand-rolled `{city}, {state}` templates. | `page.tsx:604, 1579`; new lib |
| 4 | "Search Google" wraps mid-phrase | Move to the overflow menu as a single item, "Search on Google". It is a fallback for missing-website prospects, not a header link. If kept inline, `whitespace-nowrap`. | `page.tsx:611–615` |
| 5 | Double breadcrumb | Delete the in-page breadcrumb outright. The global header already resolves the company name via `setOverride`. Add a ← icon-button in the ribbon that preserves `?filters`. | `page.tsx:584–591` |
| 6 | Lost/Won get top billing | Move both into the Log Outcome sheet, below the note field, as an outlined pair. Desktop: overflow menu. Replace `window.confirm` with a `Dialog` (E5). | `page.tsx:637–670` |
| 7 | Addresses render underlined | Add `formatDetection: { telephone: false, address: false, email: false }` to the `metadata` export in `src/app/layout.tsx`. Then make the phone an explicit authored `<a href="tel:">`, so the only underlined thing is a link we control. | `src/app/layout.tsx:15` |
| 8 | Address shown twice, differently | `resolveAddress(company, primaryStore)` — prefer the store's (it has the street line), fall back to the company's. Render **once**, in Contacts & locations. The ribbon shows city only. Delete the Company Info address row. | `page.tsx:1038, 1541` |
| 9 | Contact renders as "Unknown" + Primary | `contactLabel(c)`: `[first,last].filter(Boolean).join(" ")` → else `c.title` → else email local-part → else `"Unnamed contact"` in `italic text-muted-foreground`. Drop contacts with no name, email **and** phone from the list entirely — they're import residue. | `page.tsx:2392` |
| 10 | Raw style codes, "1 units" | **Diagnosis:** those rows are `ajm_order_items.category = 'no_detail'` — per `categorize.ts`, legacy lump-sum orders whose `product_name` is an invoice number, qty 1, no SKU (~$2.5M of AJM's Shopify wholesale). They are not products. **Fix (client, required):** in the topProducts map, partition rows matching `/^\d{4,}$/` out and render them as one line — `No line detail · $12,400 across 8 orders`. **Fix (lib, better):** add `AND COALESCE(i.category,'') <> 'no_detail'` to the `topProducts` query in `modules/sales/lib/ajm/history.ts` and return `noDetail: {orders, revenue}` alongside; additive, so nothing downstream breaks. Also group real products by `CATEGORY_LABEL[category]`. **Pluralisation:** `pluralize(n, "unit")` helper; also fixes `${o.units} units` on the order rows. | `page.tsx:1715, 1741`; `ajm/history.ts:46` |
| 11 | Five near-empty cards | Sections return `null` when their block is empty (this is exactly the consolidation doc's Phase 3 contract). Their actions collect in one shared button row (§7.4). Specifically: delete the Pipedrive "not in Pipedrive yet" card body, the Campaigns empty paragraph, the Notes "No notes yet", and render Lead Source only when it has a value. | `pipedrive-panel.tsx:189`; `page.tsx:1845, 2020, 2026` |
| 12 | No persistent way to call/email | `CompanyActionBar` — `fixed inset-x-0 bottom-0 z-40 md:hidden` with `pb-[max(0.5rem,env(safe-area-inset-bottom))]`, three `h-11` targets. Shell gets `pb-24 md:pb-0`. Desktop: the sticky right-rail `ContactCard`. | new component |
| 13 | `ICP — · 65` | `<IcpChip tier score />` with explicit branches: both → `ICP A · 65`; tier only → `ICP A`; score only → `ICP 65`; neither → **render nothing** (an em-dash chip is worse than no chip). Separately, fix E6: the editor's `min=0 max=10` "Score (0–10)" rejects the real 0–100 scale. | `page.tsx:687–696, 730–738` |
| 14 | Seven unsystematic accent colours | §7.1. All section icons → `text-muted-foreground`. Colour reserved for state: emerald/amber/destructive/primary. | throughout |

---

## 9. Priority order

Ordered by *perceived improvement per hour*, not by tidiness.

### P0 — half a day, and the page stops being embarrassing

These are surgical and mostly deletions. Do them in one commit; no new
components required.

1. **Delete the page's `p-4 md:p-6`** (line 528) → +64px of width on every
   phone. One line, biggest single win.
2. **Delete the in-page breadcrumb** (584–591) and the **Activity (legacy)
   block** (2068–2217) → −150 lines, −1 duplicated nav.
3. **`min-w-0` + `truncate` in `InfoRow`**, and every `grid-cols-2` →
   `grid-cols-1 sm:grid-cols-2` → defect 1 gone.
4. **`formatDetection`** in root metadata → defect 7 gone.
5. **`joinPlace` / `pluralize` / `contactLabel` / `IcpChip`** → defects 3, 9, 10
   (partially), 13 gone.
6. **Fix E1** (`setCompany(data.company)` at lines 778 and 798) — this is a live
   bug that blanks the page.
7. **Won/Lost out of the header** into a temporary `DropdownMenu` → defect 2 and
   6 largely gone even before the ribbon exists.

After P0 the page is still 15 cards, but nothing is broken, overlapping or
lying. **This is the ship-today milestone.**

### P1 — two days: the Brief

8. Build `CompanyBrief` (§5.3) and `CompanyActionBar` (§6.1). Insert the Brief
   above the existing card stack and leave everything below it alone.
9. Hoist the Google Maps closure alert and the Faire banner into the Brief's
   alert slot.
10. Merge the note composer into the Activity card header; delete the Notes card.

This is the change the owner will feel most. **The first screenful now answers
"should I call, and what do I say".** The junk below it is now junk *below the
fold*, which is a completely different experience even before it's cleaned up.

### P2 — three days: the Reference zone

11. Extract the remaining cards into `sections/` per the consolidation doc's
    Phase 3, each returning `null` on an empty block.
12. Wrap them in `<details>` on mobile / `<Tabs>` on desktop, driven by one
    `SECTIONS` array (§10).
13. Merge Orders + AJM into Buying history; apply the `no_detail` fix.
14. Delete everything in the "DELETE" column of §5.2.

Page height should land **under 1,600px collapsed** — roughly a third of today's
5,172px.

### P3 — one day: polish

15. Colour system pass (§7.1), dark-mode pass (§7.2), `tabular-nums`, touch
    targets, `rel="noopener noreferrer"`.
16. Replace `window.confirm`/`prompt` with `Dialog` (E5); make the contact edit
    button visible on touch (E4).
17. Delete dead code: `sourceColorMap`, unused imports, `focus:rows-3`.
18. Optional: replace the 5 sequential refetches (E12) with targeted state
    updates from mutation responses.

---

## 10. Fitting the consolidation plan

This proposal is deliberately shaped to be **Phase 3 of
`company-page-consolidation.md`**, not a competing effort.

- Every section here is a component under
  `src/modules/companies/components/sections/`, taking exactly one named block
  and returning `null` when it's absent — the contract that document already
  specifies.
- The **"render `null` when empty"** rule (defect 11) *is* the consolidation
  doc's "sections appear when they have something to say". Doing the UX work
  makes the architectural work visible rather than duplicating it.
- Ordering lives in one array, as the doc requires:

```ts
// src/modules/companies/components/sections/registry.ts
export const SECTIONS = [
  { key: "contacts", label: "Contacts & locations", icon: Users,       block: "identity" },
  { key: "buying",   label: "Buying history",       icon: ShoppingCart,block: "orders+ajm" },
  { key: "intel",    label: "Store intel",          icon: Store,       block: "firmographics" },
  { key: "listing",  label: "Google listing",       icon: MapPin,      block: "gmaps" },
  { key: "outreach", label: "Outreach",             icon: Send,        block: "campaigns+pipedrive" },
  { key: "admin",    label: "Admin",                icon: Settings2,   block: "meta" },
] as const;
```

  Mobile maps it to `<details>`, desktop to `<Tabs>`. **One array, two shells.**
- Nothing here requires a backend shape change. The Brief reads only fields the
  route already returns. The one lib touch — filtering `no_detail` out of
  `getAjmHistory().topProducts` — is additive and lives in the shared lib the
  consolidation work just created, so `/customers/[id]` gets the fix for free.
  That is the pattern the doc says to generalise.
- **Build order dependency:** P0 and P1 are safe on the current
  `/prospects/[id]`. Start P2 only once the doc's Phase 1 (one route) has landed
  — otherwise you extract sections into a page that's about to be replaced.

## 11. Non-goals

- No new dependencies. Stat tiles are `div`s; the accordion is `<details>`; no
  chart library, no animation library, no drag-and-drop.
- No virtualisation. 50 activities and 100 AJM rows are fine; the AJM list is
  already inside a `<details>` with `max-h-72 overflow-y-auto`.
- No route change here — that's the consolidation doc's Phase 1.
- No redesign of `/customers/[id]`. It converges by adopting these sections
  during Phase 3, not by a parallel effort.

---

# Revisions

Three review passes over the proposal above, before any code was written. Each
pass records what changed and why, so the reasoning survives the diff.

## Pass 1 — Verifying the proposal's own claims

Every mechanical claim was checked against the codebase rather than trusted.

**Confirmed:**

- The double padding is real: `src/app/(dashboard)/layout.tsx:26` is
  `<main className="min-w-0 flex-1 overflow-auto p-4 md:p-6">` and
  `page.tsx:528` opens `<div className="p-4 md:p-6 …">`.
- E1 is a real crash. `page.tsx:778` and `:798` do
  `setCompany(await cr.json())` where `:411` correctly does
  `setCompany(data.company)`. Saving an ICP edit assigns the whole envelope and
  the next render hits `company.name.charAt(0)` on `undefined`.
- `no_detail` is a real category (`ajm/categorize.ts:34,47,176`) and is exactly
  what the bare style codes are. The diagnosis holds.
- Button is **Base UI**, not Radix, so the proposal's `render={<Link/>}` prop is
  correct here — `asChild` would have been wrong.
- `sheet`, `dropdown-menu`, `tabs`, `select`, `dialog` all exist in
  `components/ui`. Tailwind is **v4**, so `line-clamp-*` and `size-*` are core.

**Corrected:**

- **§6.2 contradicts §10.** The desktop tab list is
  `Overview | Buying | Intel | Outreach | Admin`; the `SECTIONS` registry is
  `contacts | buying | intel | listing | outreach | admin`. There is no Overview
  block and `listing` is missing from the tabs. Resolved in Pass 2 by dropping
  tabs entirely.
- **`size="icon-sm"` is 28px**, and the default Button is `h-8` (32px). Both are
  well under the 44px iOS minimum the proposal itself cites. Every touch target
  in the mobile layout needs an explicit `h-11`/`min-h-11`; noted so it isn't
  quietly lost.
- **The Faire mapping banner contains inputs.** The proposal promotes it into
  the Brief's "alert slot", but an alert with two text inputs and a submit is
  not an alert. It stays a distinct block directly under the Brief.

## Pass 2 — Scope, and killing the accordion/tabs split

The proposal is ~4.5 days across P0–P3. Two changes to make it shippable in one
pass without leaving a half-built structure behind.

**Collapse by information value, not by viewport.** The proposal has
`<details>` on mobile and `<Tabs>` on desktop over one array. That needs a
media query in JS to decide a `<details open>` default, which either flashes
collapsed content on desktop or needs a CSS override of UA `display` rules.
Both are fragile, and the split is the source of the §6.2/§10 contradiction.

The better rule: **a section's default state is a property of the section, not
the screen.** Contacts and Buying history are always open. Store intel, Google
listing, Outreach and Admin are always collapsed, at every width, behind a
summary line that says what's inside. No media query, no hydration mismatch,
no second shell, and it is defensible on desktop too — nobody needs Tech Stack
expanded by default on a 27" monitor either.

Tabs are dropped. `?tab=` state, tab persistence and the sticky rail go with
them.

**Do the structural work in place.** The file-per-section extraction is
entangled with the route consolidation (that doc's Phase 1), and doing it now
means extracting sections into a page that is about to move. So: build the
Brief, the ribbon, the action bar and a shared `Section` wrapper, and wrap the
*existing* card bodies in it. The height win and the empty-state rule land now;
the file split lands with the route change, against a page whose sections are
already isolated behind one wrapper.

## Pass 3 — Product judgement

**The talking point is missing its best case.** The proposal's precedence is
`ai_opener → top_brand → gmaps category → description`. But the single most
useful sentence for this business is the one it never generates: *this shop
spent $38,531 with A.J. Morgan and has never ordered from Jaxy.* AJM ceased
trading, Jaxy employs the person who ran its wholesale book, and that gap is
the entire sales motion. Added as the **first** branch: when AJM revenue exists
and Jaxy orders are zero, the talking point is the gap, stated in money.

**Nothing was said about loading or failure.** A page whose first screenful is
now the whole point needs a skeleton for it, and a real error state instead of
a blank. Both added.

**Two more empty-state traps.** "Never contacted" is a *finding*, not a missing
value — it renders. And a stat tile showing `$0` for a shop with zero Jaxy
orders is information, whereas an em-dash is not; the rule is "omit when
unknown", not "omit when zero", which the original text conflated in the
Google-rating row (where 0 genuinely means unrated).

**Accessibility gaps.** Icon-only controls in the ribbon and action bar need
`aria-label`s; the `<details>` summaries need to stay real `<summary>`
elements so they keep their disclosure semantics; `tel:`/`mailto:` links need
`aria-label`s that include the company name.
