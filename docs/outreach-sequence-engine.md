# Outreach Sequence Engine — build spec v0.4

Reviewed against the actual codebase (2026-08-05). v0.2's shape survives intact —
sequence/touchpoint objects, three send modes, channel adapters, the trigger set,
Christina's voice rules all hold. What changes is *where it plugs in*: about half
of what v0.2 assumed we'd need to build already exists in the-frame, and three of
its assumptions are wrong in ways that would have hurt.

*(v0.4 adds §9 Failure modes — the robustness pass. Every mitigation there is
either a lesson already paid for in the faire_dm campaign or a fail-closed
default. Also: outreach-history import in Phase 0, send-window and A/B
mechanics pinned down, kill switches, and propose-only graduation criteria.)*

---

## 0. What the three review passes found

### Pass 1 — product & logic

1. **v0.2 §7 is backwards, per Daniel's direction.** It says the engine should
   read/write Pipedrive as the source of truth. Daniel wants to *migrate off*
   Pipedrive toward the-frame. So: **the-frame owns all sequence state** (it
   already owns orders, accounts, reorder predictions, health, LTV — none of
   which Pipedrive has). During the transition, sequence touches are *mirrored
   into* Pipedrive as logged activities via the existing `runActivitySweep()`
   pattern, so Christina's Pipedrive view stays complete. Pipedrive is a display,
   not a dependency.
2. **Enrollment conflicts need a priority order, not just "one at a time."**
   When two rules match the same account in the same tick, the winner must be
   deterministic: **T0 > T3 > T1 > T6 > T2 > T5** (welcome beats everything;
   an open cart beats a scheduled nudge; win-back beats promo blast).
3. **Reorder prediction confidence gates T1.** The existing engine
   (`reorder-engine.ts`) is a plain mean of order gaps, needs only 2 orders, and
   stores one date. A 2-order account with a 200-day gap would get a "fill-in due"
   message on a meaningless date. Gate: auto-enroll in T1 only when
   `total_orders >= 3` **and** gap coefficient of variation < 0.5. Below that,
   the account routes to a generic quarterly check-in instead (or manual).
4. **"They reply" as an exit condition is the hard one on Faire** — no API for
   messages. Solved with what we already built: the local Playwright runner
   (`faire_dm`'s `readThread`/`lastMessageInfo`, calibrated selectors) scans
   active-enrollment threads once daily and posts reply status back. Until that
   runs, the review queue has a "they replied" button — Christina sees the thread
   when she sends anyway.
5. **Multi-location detection is already derivable** — `stores` has multiple rows
   per company. `store_count > 1` triggers the "Hi Guys!" opener variant
   automatically; no new field.
6. **Voice rules become a template lint, not documentation.** We already enforce
   "no em dashes" in `faire_dm` with a `noDash()` guard. Same idea, expanded: a
   `lintTemplate()` that flags contractions, em/en dashes, >4 sentences, missing
   "Thanks again," sign-off. Runs on template save and again at render time.
   House style stops depending on whoever edits the template remembering.
7. **GET10 on touch 2, agreed** — and make offer placement a per-step template
   field so it's testable, not hardcoded.

### Pass 2 — data model & technical reality

8. **Faire retailer tokens are currently thrown away.** `faire-sync.ts` matches
   companies by name/email and discards `retailer.id` (`r_…`). That token is the
   key to everything messenger-side: `faire.com/brand-portal/messages?retailerToken=r_x`
   is a direct deep link into the right thread (proven in `faire_dm`). **Add
   `companies.faire_retailer_id`, populate on sync, backfill from the payouts
   API** (it already returns `retailer_id` on every order). Without this, the
   review queue can't even link Christina to the right conversation.
9. **There is no Faire order-sync cron.** `syncFaireOrders()` exists but is only
   manually triggered; Faire orders otherwise arrive via the *Shopify* daily sync
   at 14:00 UTC — up to 24h latency. T0 (welcome after first order) and T4
   (review request) are only as timely as ingestion. **Add a `faire-orders-sync`
   cron (hourly)** — the function is written, it just needs a registry entry.
10. **Don't overload `campaigns`/`campaign_leads`.** They're single-shot,
    channel-array, one-row-per-lead. Sequences need per-step scheduling and a
    per-message ledger. New tables (§2), linked to campaigns only by convention
    (a T2 blast can reference a campaign for reporting).
11. **No suppression flag exists anywhere.** Not on `companies`, not on
    `customer_accounts`. Before any engine runs: `companies.do_not_contact`
    (+ reason, at) and a single `isSuppressed(companyId)` check that also covers
    open disputes/tickets and unsubscribes. This is a prerequisite, not a feature.
12. **Trigger evaluation = idempotent cron scans, not event listeners.** The
    event bus (`order.created`, `order.shipped`, `order.delivered`) exists but is
    in-process and non-durable — a missed emit is lost forever. The engine's tick
    re-derives eligibility from the DB every 5 minutes (the platform cron floor),
    so it self-heals. Events can accelerate later; correctness never depends on them.
13. **No template/merge-field system exists** (Instantly holds its own bodies).
    We need `renderTemplate()` — and it must **fail closed**: any unresolvable
    token forces the message to Review mode. `"Hi {first_name},"` with the token
    unfilled must be unsendable.

### Pass 3 — operations & scale

14. **The Faire send mechanism is already proven, in production, with guards.**
    `faire_dm` (now its own repo) sent ~1,100 messages through the brand portal
    with: calibrated selectors, PDF attachment upload, **brand guard** (never
    sends unless the active brand is A.J. Morgan — same guard, target flipped to
    Jaxy where appropriate), **7-day fail-safe recency guard** (skip unless the
    last our-message is provably old), and a measured rate limit (**blocked at
    ~14/hr; 12/hr safe**). The Faire adapter's auto-send mode is a port of this
    runner, pointed at the-frame's queue — not new invention. Every hard lesson
    (fail-open date parsing, `left_unsent` false negatives, stale-session churn)
    is already paid for.
15. **Review-and-send volume math says don't rush auto-send.** Steady-state
    sequences are tens of messages/day, not the 1,248-blast. At 10-15/day,
    Christina's queue time is ~10 minutes. Auto-send matters only for T4 and
    for scale later; everything else can stay human-read for months.
16. **The daily queue is the product.** If clearing it is slow, the whole engine
    stalls. It needs: message + context + thread deep link per row, inline edit,
    one keystroke to approve, skip, or mark-replied, and "approve all" per step
    once copy is proven.

---

## 1. Architecture

```
the-frame (Railway) — the brain                     Mac runner — the Faire hand
┌──────────────────────────────────────┐            ┌──────────────────────────┐
│ sequences / steps / enrollments      │            │ faire-runner (from       │
│ engine tick (cron */5):              │  ops API   │  faire_dm codebase):     │
│   scan triggers → enroll             │◄──────────►│  - poll approved queue   │
│   advance steps → render → queue     │  x-ops-key │  - send via brand portal │
│ review queue UI (approve/edit/send)  │            │  - brand+recency guards  │
│ adapters: faire / email / task       │            │  - daily reply scan      │
│ metrics + Pipedrive activity mirror  │            │  - post results back     │
└──────────────────────────────────────┘            └──────────────────────────┘
```

- **Send modes** decide who acts: `review` items surface in the queue UI with a
  deep link (Christina sends in the portal, clicks Sent); `auto` items are picked
  up by the runner; `task` items create a task row (calls, direct mail) and never
  touch a send path.
- **Channel adapters** implement one interface (§4). Faire ships first; email
  (Omnisend) is adapter two; call/direct-mail are task-only adapters — zero
  integration needed, exactly as v0.2 intended.
- The runner talks to production through token-guarded `/api/admin/ops/*`
  endpoints (existing pattern: shared logic in libs, exposed via both `/api/v1`
  for the UI and ops routes for tooling).

## 2. Data model (new tables + two column adds)

```sql
-- Column adds
ALTER TABLE companies ADD COLUMN faire_retailer_id TEXT;      -- r_… token; index it
ALTER TABLE companies ADD COLUMN do_not_contact INTEGER DEFAULT 0;
ALTER TABLE companies ADD COLUMN do_not_contact_reason TEXT;

CREATE TABLE sequences (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  trigger TEXT NOT NULL,               -- T0|T1|T2|T3|T4|T5|T6|manual
  class TEXT NOT NULL,                 -- 'relationship' | 'nudge'  (cooldown exemption, v0.2 §3)
  goal TEXT, status TEXT DEFAULT 'draft',  -- draft|active|paused|archived
  enrollment_mode TEXT DEFAULT 'manual',   -- auto|manual|segment
  enrollment_rule TEXT,                -- JSON: conditions for auto mode
  propose_only INTEGER DEFAULT 1,      -- new auto rules log what they WOULD do
  priority INTEGER NOT NULL,           -- conflict ordering (T0=100 … T5=10)
  max_touches INTEGER DEFAULT 3,
  owner TEXT DEFAULT 'christina',
  created_at TEXT, updated_at TEXT
);

CREATE TABLE sequence_steps (
  id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL REFERENCES sequences(id),
  step_no INTEGER NOT NULL,
  delay_days INTEGER NOT NULL,         -- from trigger (step 1) or previous step
  channel TEXT NOT NULL,               -- faire|email|call|direct_mail
  send_mode TEXT NOT NULL DEFAULT 'review',  -- auto|review|task
  template_body TEXT NOT NULL,         -- with {merge_fields}
  template_variant_b TEXT,             -- optional A/B
  attachment_key TEXT,                 -- versioned asset key (§6)
  conditions TEXT,                     -- JSON skip/only-if rules
  offer_code TEXT,                     -- e.g. GET10 — placement testable per step
  UNIQUE(sequence_id, step_no)
);

CREATE TABLE sequence_enrollments (
  id TEXT PRIMARY KEY, sequence_id TEXT NOT NULL, company_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  -- active | completed | exited_reply | exited_order | exited_cart
  -- | suppressed | paused_t0 | proposed
  current_step INTEGER DEFAULT 0,
  next_step_due_at TEXT,               -- when the tick should act
  trigger_context TEXT,                -- JSON: order_id, predicted_date, cart info…
  enrolled_by TEXT,                    -- 'rule' | user id
  enrolled_at TEXT, exited_at TEXT, exit_reason TEXT
);
-- one live enrollment per account, ever:
CREATE UNIQUE INDEX idx_enroll_one_active ON sequence_enrollments(company_id)
  WHERE status IN ('active','paused_t0');
-- never re-enroll the same sequence twice in 90d: enforced in code at enroll time.

CREATE TABLE sequence_messages (        -- the per-message ledger (audit + metrics)
  id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, step_id TEXT NOT NULL,
  company_id TEXT NOT NULL, channel TEXT NOT NULL,
  status TEXT NOT NULL,                -- queued_review|approved|sent|skipped
                                       -- |failed|task_open|task_done
  rendered_body TEXT NOT NULL,         -- exact final text (what Christina saw/edited)
  edited INTEGER DEFAULT 0,            -- she changed it → feedback for copy
  attachment_key TEXT, variant TEXT,   -- a|b
  queued_at TEXT, approved_at TEXT, sent_at TEXT, sent_by TEXT,  -- 'runner'|user
  reply_detected_at TEXT, error TEXT,
  UNIQUE(enrollment_id, step_id)       -- idempotency: a step renders once
);
```

`customer_accounts` (tier, LTV, health, `next_reorder_estimate`) and `stores`
(multi-location) are read as-is. No changes to `campaigns`.

**Cadence config lives in `settings`** (keys `seq.cooldown_days=14`,
`seq.send_window=Tue-Thu 9-16 local`, `seq.review_daily_cap`,
`seq.faire_hourly_cap=12`…) — config values, not hardcoded, per v0.2 §3. Local
time from `companies.state` → timezone map (state is populated; lat/lng exists
for edge cases).

## 3. The engine tick (cron `sequence-engine-tick`, `*/5`, in registry.ts)

Single idempotent pass, four stages, each a pure DB scan:

1. **Suppress & exit.** For every active enrollment: exit on new order since
   enrollment (`orders.placed_at > enrolled_at`), on detected reply, or on
   suppression (`do_not_contact`, open dispute). T1/T5 → exit-to-T3 when cart
   signal exists (phase 2).
2. **Enroll.** Evaluate each active sequence's rule against eligible accounts:
   - T0: first order (`customer_accounts.total_orders = 1`) with no prior T0.
   - T1: `next_reorder_estimate` within 5 days, confidence gate (§0.3) passed.
   - T4: order shipped 8+ days ago (delivered+3 when `delivered_at` exists —
     ShipHero tracking populates it), no open return/dispute on that order.
   - T6: days since `last_order_at` > 1.5 × avg gap.
   Apply, in order: suppression → one-active-enrollment (priority decides) →
   class-aware 14-day cooldown → T0-pause (any T0 in last 7d pauses nudges).
   Sequences with `propose_only=1` write enrollments as `proposed` and touch
   nothing — the two-week shadow mode from v0.2, visible in the UI.
3. **Advance.** Enrollments with `next_step_due_at <= now` (auto steps
   additionally deferred to the next valid send slot and smeared under the
   hourly/daily caps — §8): render the step template (fail-closed merge, voice
   lint), resolve the attachment, write `sequence_messages` as `queued_review`
   (or `approved` if the step is `auto`, or `task_open` if `task`), bump
   `current_step`, schedule the next. One transaction per enrollment advance.
4. **Mirror & notify.** Slack digest of today's queue size (existing
   `postToSlack` topic); Pipedrive activity mirror piggybacks the existing
   `pipedrive-activity-sweep`.

## 4. Channel adapter interface

```ts
interface ChannelAdapter {
  channel: "faire" | "email" | "call" | "direct_mail";
  capabilities: { autoSend: boolean; attachments: boolean; replyDetection: boolean };
  // Resolve a deep link / destination for a company (null = can't reach → fallback)
  destination(companyId: string): Promise<{ url?: string; address?: string } | null>;
  // Auto-send path only. Review mode never calls this — the human is the sender.
  send?(msg: RenderedMessage): Promise<{ ok: boolean; error?: string }>;
}
```

- **faire**: `destination` = `messagesUrl(companies.faire_retailer_id)`;
  `send` = the Mac runner (poll `/api/admin/ops/sequences/queue?mode=auto`,
  send with brand + recency + rate guards, POST result back). Review mode needs
  no runner at all — the queue UI deep-links Christina into the thread.
- **email**: Omnisend/Klaviyo transactional send; fully autoSend-capable;
  the **fallback channel** when `faire_retailer_id` is null but a verified email
  exists (`companies.email_verification_status='ok'`), per v0.2's routing rule.
- **call / direct_mail**: task-only. `send` undefined; advancing the step creates
  the task (surfaced in queue UI under a Tasks tab; call tasks can also push into
  the existing PhoneBurner folder flow later).

Frequency caps live on the **contact**: the cooldown check in stage 2 reads
`sequence_messages.sent_at` across *all* channels, exactly so three polite
sequences can't triple-touch one retailer in a week (v0.2's rule, enforced in
one place).

## 5. Merge fields & voice lint

Deliberately light, per v0.2: `{first_name}` (contacts.is_primary, title-cased —
port `cleanFirstName()` from faire_dm, which already handles ALL-CAPS names and
acronym stores), `{account_name}`, `{product_line}` / `{best_seller}` (top SKU
from order_items), `{last_order_date}`, `{n_months_lapsed}`, `{date}`, `{offer}`,
`{offer_code}`. Unresolvable token → message forced to `queued_review` with the
gap highlighted. `lintTemplate()` (no contractions, no em/en dashes, ≤4 sentences,
sign-off present) runs on save and render.

Christina's edits are signal: `edited=1` rows per step are the copy-improvement
feedback loop — review weekly, fold her phrasing back into the template.

## 6. Attachments

Assets live in R2 under versioned keys (`outreach/linesheet` →
`outreach/linesheet/v7.pdf`), managed on a small settings page; steps reference
the logical key so every send grabs current, never stale (v0.2 §5). The runner
already knows how to upload attachments to Faire messages (2.3MB PDF proven);
the per-touchpoint asset map from v0.2 carries over unchanged.

## 7. Answers to v0.2's open questions

| # | Question | Answer |
|---|---|---|
| 1 | Who sends? | Christina, personally — `owner` field exists on sequences for later reps. Reply routing is her Faire inbox either way. |
| 2 | Reorder prediction today? | Mean of gaps, ≥2 orders, `customer_accounts.next_reorder_estimate`, daily cron. Good enough for T1 **with** the confidence gate (§0.3). Improve later (median, seasonality). |
| 3 | Cart visibility? | None — no table, no API field. T3 needs the runner to scrape portal cart state (phase 2) or stays manual-enroll ("I saw your cart" → Christina enrolls them). |
| 4 | GET10 placement? | Touch 2 (agreed). `offer_code` is per-step, so testing placement is config. Keep it out of T1/T6 defaults — accounts learn to wait for discounts. |
| 5 | 3-touch cap? | Per-sequence cap, config (`max_touches`). Good accounts get more touches across the year via multiple sequences — that's fine; the 14-day cross-sequence cooldown is the real annoyance guard. |
| 6 | Volume ceiling? | `seq.review_daily_cap` throttles stage-2 enrollment. Start 20/day; the queue UI shows actual clear-time so the number is set from data. |
| 7 | Faire → direct? | Policy call for Daniel. Engine-wise it's just a template — but flag: doing it *inside Faire Messenger* is the riskiest place to have that conversation. Recommend keeping it out of v1. |
| 8 | Success metrics? | Per sequence/step/variant: reply rate, order-within-30d of enrollment (attributable via `sequence_messages` ledger joined to orders), revenue. Weekly first month. |
| 9 | Ship+8 vs delivery? | `orders.delivered_at` is populated by ShipHero tracking — use **delivery+3, fall back ship+8** when delivery is missing. Better than v0.2 hoped. |
| 10 | T0 at scale? | Stays personal (review, photo attached) below `seq.t0_auto_threshold` new accounts/week (default 15); above it, revisit. Config, not code. |
| 11 | Second channel? | **Email** — it's the fallback channel anyway (§4), Omnisend is integrated, fully automatable. Calls are third via task adapter (zero integration, immediately useful). |

## 8. Mechanics pinned down (v0.4)

- **Send window applies to AUTO sends only.** Review-mode items just land in the
  daily queue — Christina sends when she works, which is inherently human-timed.
  For auto: a step due Friday 5pm defers to the **next valid slot** (Tue-Thu
  9-16 local), computed by a `nextSendSlot(due, tz)` helper. Timezone from
  `country + state` (US/CA mapped; international or unknown → the account's auto
  steps degrade to review mode rather than guess — fail closed, and Faire has UK/
  CA/AU retailers so this is not hypothetical).
- **Queue smearing.** When a batch of steps becomes due at once (Tuesday 9am
  pile-up after a weekend), stage 3 releases at most `seq.review_daily_cap` into
  the queue and `seq.faire_hourly_cap` (12, the measured limit) to the runner,
  oldest-due first. The rest stay scheduled — no thundering herd.
- **A/B assignment is deterministic**: djb2 hash of `company_id` picks variant
  (the proven faire_dm pattern) — stable on re-render, unbiased, and reportable
  without storing an assignment table.
- **Attribution rule**: an order attributes to an enrollment if placed within 30
  days of that enrollment's **last sent touch**; within an enrollment, credit
  the last touch before the order. One rule, applied everywhere metrics appear.
- **Kill switches** (settings, mirroring `pipedrive-sync`'s `isSyncEnabled`
  pattern): `seq.engine_enabled` — master, **default off**; nothing enrolls or
  renders until flipped. `seq.autosend_enabled` — separate; flipping it off
  degrades every auto step to review without touching the engine. Two levers:
  "stop everything" and "humans only," both instant, both one setting.
- **Propose-only graduation is a checklist, not a vibe**: an auto-enrollment
  rule flips live only after ≥14 days in shadow **and** ≥20 proposed
  enrollments **and** a human has marked ≥90% of them "would have been
  correct" in the review UI. The flip is logged (who, when) to `activity_feed`.
- **Tick crash-safety**: each enrollment's advance (render → message row →
  step bump → next schedule) is one SQLite transaction; the tick is re-entrant
  and the cron scheduler's existing per-job lock (15-min stale timeout)
  prevents overlap. A crash mid-tick loses nothing and duplicates nothing —
  `UNIQUE(enrollment_id, step_id)` is the backstop.
- **Runner postbacks are idempotent**: keyed on `sequence_messages.id`; a
  retried postback can't double-record. One runner instance max (lock file,
  the faire_dm pattern).

## 9. Failure modes — and how the design absorbs them

The engine's job is outbound messages to real customers from Christina's name.
The failure analysis assumes everything that *can* go stale *will*: sessions
expire, scans miss, humans forget, Faire changes their DOM. Each row below is
either a lesson already paid for in the faire_dm campaign or a fail-closed rule.

| Failure | Consequence if unhandled | Mitigation (layered) |
|---|---|---|
| **Double-touch: ledger says clean, reality isn't** (mislogged send, manual send outside the system, pre-engine history) | Same retailer messaged twice — the exact Taylor G. incident from faire_dm | **Two-layer rule, non-negotiable:** (1) ledger cooldown check at schedule time; (2) **live thread check at send time** — the Faire adapter reads the thread and refuses to send if the last message is ours and not provably older than `seq.cooldown_days`. Unknown date ⇒ skip (fail closed — the fail-open version of this guard is precisely what caused Taylor G.). Review mode gets layer 2 for free: Christina sees the thread. |
| **Empty ledger at launch** | The ~1,100 accounts just messaged in the market campaign get re-touched immediately | Phase 0 imports faire_dm's `send_log` + `assist_log` as historical `sequence_messages` rows, and its skiplist (declines, dead tokens) into `do_not_contact`. The engine is born knowing what's already been said. |
| **Reply scan down** (runner session expired — has happened) | Touch 2/3 fire at accounts that already replied: the single worst UX failure available | (1) The live thread check also detects *their* reply and exits the enrollment at send time; (2) **runner heartbeat**: if the reply scan hasn't reported in 48h, the engine auto-degrades all Faire auto steps to review and Slack-alerts (`postToSlack`). Auto-send is a privilege the runner keeps only while provably alive. |
| **Wrong-brand send** | Messages from Jaxy/AJM when the other was intended | Port the faire_dm brand guard verbatim: assert the active brand token before *every* send; abort the run on mismatch. Already proven. |
| **Faire rate limit / soft block** | Account restriction escalation | Hourly cap 12 (measured), randomized gaps, stop-on-block with an alert file that halts subsequent runs until cleared — all ported, all proven. |
| **Queue neglect** (Christina away, items rot) | "Urgent" messages sent two weeks late read as broken | Queue items carry `queued_at`; items older than `seq.queue_stale_days` (default 5) are auto-skipped with status `skipped` + Slack digest note — a stale nudge is worse than no nudge. T0 is the exception: it waits (a late welcome still beats none). |
| **Merge-field gap** (`Hi {first_name}` unresolved) | Template artifacts reach a customer | Render fails closed to review with the gap highlighted; the lint blocks *saving* templates with unknown tokens in the first place. |
| **Stale attachment** | Old linesheet goes out for weeks | Versioned asset keys resolve at send time, not queue time; the asset page shows which sequences reference each key. |
| **Faire DOM change** | Runner sends fail or, worse, misfire | Runner verifies each send (compose box cleared + thread re-read) and posts `failed` rather than guessing; 3 consecutive failures ⇒ runner pauses + alerts. The `left_unsent` false-negative lesson: **unverified ⇒ counted as sent** for cooldown purposes (a duplicate is worse than a missed send). |
| **Crash mid-tick / overlapping ticks** | Skipped or duplicated steps | Transaction-per-advance, re-entrant scans, cron lock, uniqueness constraints (§8). |
| **Runaway enrollment rule** (bad filter enrolls 800 accounts) | Mass mis-send | New rules are born `propose_only`; live rules respect `seq.review_daily_cap` at enroll time, so even a bad rule can only queue a day's cap; the master switch stops the world in one setting. |

Design stance behind all of it: **the ledger is the plan, the live thread is
the truth, and wherever they disagree the system must do less, not more.**

## 10. Build phases

**Phase 0 — prerequisites (do first, small but load-bearing):**
1. `companies.faire_retailer_id` + populate in `faire-sync.ts`; backfill from
   **two** sources: the payouts API (buyers — `retailer_id` is on every order)
   and faire_dm's `contacts.csv` (**1,248 non-buyer prospects with retailer
   tokens + names + cities** — coverage the API can't give us).
2. `do_not_contact` columns + `isSuppressed()`; **import faire_dm's skiplist**
   (declines, dead tokens) as the first suppression entries.
3. **Import outreach history**: faire_dm `send_log` + `assist_log` →
   historical `sequence_messages` rows, so cooldowns work from day one and the
   ~1,100 accounts just messaged aren't immediately re-touched (§9).
4. Register `faire-orders-sync` cron (hourly — function already written).

**Phase 1 — engine + T0/T4/T1 at review-and-send (~1-2 weeks):**
Tables (§2) in `db.ts`; `src/modules/sequences/` module: `lib/engine.ts` (tick),
`lib/render.ts` (merge + lint), `lib/adapters/{faire,task}.ts`; cron registry
entry; `/api/v1/sequences/*` routes; UI at `src/app/(dashboard)/sequences/`
(clone the campaigns list/detail pattern) + the **queue page** (§0.16 — this is
where the polish goes); seed T0/T1/T4 with v0.2's copy; MCP tools
(`sequences.list/enroll/queue/approve`) so this session can drive it. Everything
review-mode; T1 auto-enrollment starts `propose_only`.

**Phase 2 — reach (~1 week):**
Email adapter (Omnisend) + channel fallback; T2 segment/bulk enrollment (reuse
smart_lists); attachment library page; runner v1 (port faire_dm: approved-queue
poll, guarded send, result post-back, daily reply scan); Pipedrive activity
mirror for sequence touches.

**Phase 3 — depth:**
T5, T6 (both propose-only first); per-step auto-send flips where copy is proven
(T4 first); call/direct-mail task adapters; cart scrape for T3 auto-trigger;
metrics dashboard; A/B reporting.

---

*Superseded: v0.2 §7 (Pipedrive as source of truth). Sources: codebase inventory
2026-08-05; faire_dm production learnings (rate limits, guards, selectors) —
see that repo's README.*
