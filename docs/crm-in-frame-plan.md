# Bringing the CRM into the Frame — FINAL (v4, three review rounds applied)

**Proposal:** the frame becomes the CRM — deals, tasks, sequences, and a
playbook layer that automatically creates the right outreach per customer and
prospect across email, Faire, calls, direct mail and (consent-gated) SMS.
Pipedrive drains in stages behind acceptance gates; **stopping after P1 with
Pipedrive kept as a dumb board is a legitimate planned outcome, not a
failure.** Supersedes crm-master-plan.md keystone #1.

Review history: three rounds × five seats (sales-rep, CEO, engineering,
migration/data-integrity, compliance/deliverability) — 62 + 47 + 22 findings.
Round-3 verdicts: rep YES-WITH · CEO APPROVE-WITH · engineering
BUILDABLE-WITH · migration SAFE-WITH · compliance COMPLIANT-WITH; every
round-3 item was a spec edit, all applied below (marked ◇).

---

## 0. Executive summary

1. **Finish what exists.** The frame already contains a complete sequence
   engine (dark behind `seq.engine_enabled=false`): review queue, task steps,
   completion-anchored delays, cooldowns, caps, shadow mode, six seeded
   sequences. compai/crm contributes trust architecture — proposal ledger,
   reasons-on-everything, autonomy gates — not features. All send-paths except
   Instantly are the real build.

2. **Cost: 10–14 weeks to full retirement; the ask lands in week 1.** ● P1 is
   split so at-risk/reorder playbooks produce visible proposals in the first
   shadow week. ● P1→P2 is an explicit go/no-go Daniel takes with data;
   everything through P1 pays off even if Pipedrive stays.

3. **Migration is mechanism, not intention** — ● redesigned around what
   Pipedrive's API actually exposes (no Sequences endpoint exists): a
   one-time in-flight export + conservative enrollment guard, an atomic
   authority flip with a replay runbook, completion write-back so PD
   sequences can actually drain, history import before seat cancellation, a
   reconciliation report, and a defect-triggered (not rate-triggered) canary.

4. **Compliance is load-bearing:** one `assertSendable()` gate in every
   dispatch path, ● suppression that *propagates outward* (Instantly
   blocklist, Shopify tag removal, PB folder eviction, task voiding) because
   external senders act autonomously after handoff, address-level suppression
   in one shared normalization, SMS strictly consent-recorded (scraped
   numbers ineligible), quiet hours for SMS *and* calls.

**Decision requested:** approve P0 + P1a/P1b scope; answer §14 (each
annotated with what it blocks and the default if unanswered).

---

## 1. Business case

**Pipedrive today:** [P0 ACTION: pull the invoice — still unchecked in the
master plan] est. $1.5–3k/yr for 3 seats, plus the real costs: ~3,200 lines
of sync code, a sync tax on every feature, rep tasks outside our transaction
boundary, and deal truth split across two tables that have already drifted.
● Plus, under this plan, one paid admin seat persists ~90 days post-drain
(history import needs a live token; see §10.6).

**The build:** 10–14 weeks of sessions; no new infra beyond Twilio if SMS
proceeds. **The honest justification is capability, not cost savings** — the
seats never pay for 12 weeks; per-customer automation with evidence-gated
autonomy is the product, and it cannot be hosted in Pipedrive.

**● The two-stage decision (CEO round 2):** P0–P1 stands on its own — playbooks,
tasks, suppression hardening, CEO digest all bank value even if Pipedrive
stays as the board forever (the fallback landing zone). **P2–P4 is a separate
go/no-go** taken after P1 with stated *proceed* criteria — ◇ the first two
required, the third advisory: (1) reps prefer frame tasks over PD activities
in practice; (2) the board rebuild scopes ≤2wk after rep input; (3,
advisory) sync drift caused ≥1 real incident during P1. Stopping at P1 is
written here, in advance, as a legitimate outcome. ◇ In the stop branch the
P1b union folder build and PD completion write-back run **permanently** (the
"until drain" condition never arrives) and reps keep two tools — frame for
tasks, PD for deals/sequences. Week-one training presents the union
accordingly, not as temporary scaffolding.

---

## 2. Gap analysis vs trycompai/crm (stable since v2)

**Adopt now:** A1-lite proposal ledger (`record_facts`, company+contact,
APPLIED/PROPOSED/DISMISSED/SUPERSEDED, never re-offer a dismissal, never
overwrite a human; MVP = persist existing gmaps-match verdicts with
Accept/Dismiss); A3 tasks as first-class rows; A6 required `reason` on every
automated action; A9/A10 as conventions (neighbour IDs in every agent read,
no fuzzy name matching, automated principals can't self-approve).

**Backlog:** evidence scoring bands; record briefs; capabilities module;
work-queue refactor (when it happens: extend `jobs`, never a third queue
table); agent chat panel.

**Don't copy:** EAV custom fields, full mailbox/calendar sync, their stack.
**Keep our moat:** channels, revenue truth, health/reorder/churn + rep ROI,
ICP audit trail, eyewear intel, the engine, Slack ops.

---

## 3. Architecture

```
 SIGNALS (state-scans, idempotent)   PLAYBOOKS (only non-manual enroller)   ENGINE (exists)
 order.created ──────────────►  trigger → guards → action ────────────► enroll → steps
 health drop (nightly)           + required reason                       email│faire│call│sms│mail
 reorder due / lapsed            + autonomy: propose→review→auto         send_mode auto│review│task
 status→interested               + budget (global + per-playbook)        exits·cooldowns·caps
 reply/disposition/bounce                    │                                  │
                                             ▼                                  ▼
                                  ┌── assertSendable() ──┐               TASKS (§4)
                                  │ every adapter's      │               → PB folders
                                  │ dispatch path +      │               → /tasks · My-day
                                  │ ● outward propagation│
                                  └──────────────────────┘
```

- **Playbooks replace the engine's auto-enrollment**: `findCandidates`
  T0/T1/T6 triggers migrate into playbook rows; seeded sequences flip to
  `enrollment_mode='manual'`. ● At cutover, leftover `proposed` rows with
  `enrolled_by='rule'` are **voided** (not adopted) so the engine's
  proposal-dedup can't block the playbooks' first proposals and shadow
  attribution stays clean.
- **Budgets:** ● the budget check lives in `enrollOne` (today uncapped) and
  counts by an explicit `enrolled_by` taxonomy (`playbook:{id}` / `manual` /
  `campaign:{id}`) — not the current `='rule'` filter. ● Cap set: global
  auto-action cap default **25/day** + per-rep folder target **40/day**;
  per-playbook budget slices deferred to backlog until starvation actually
  observed (CEO: one cap too many for a 2-rep shop).
- **Triggers are idempotent state-scans** — an outage backlog cannot
  mass-fire on recovery.
- **Autonomy:** `auto` only for system-fact triggers (order, disposition,
  reply). Model-derived triggers cap at `review`. Ghosted-revive = audited
  un-suppress + `reQualify()` (built here), never a bypass.
- ● **Suppression events cascade** — ◇ specified in two tiers because an
  HTTP call cannot live inside a better-sqlite3 transaction: **local effects
  are transactional** (void open tasks on that channel, mark today's PB
  folder entry for eviction, remove the PostPilot Shopify tag), **outward
  pushes go through intent rows drained by the same job** (Instantly
  blocklist, Twilio opt-out list, PD-cohort diff line during overlap). ◇ If
  the same-day PB API eviction fails, the queue banner is **blocking** (dial
  action disabled for that contact), not advisory. ◇ And enrollment exit for
  ANY reason (order, reply, suppression) voids **all** of that enrollment's
  open tasks across channels — otherwise an email unsubscribe exits the
  enrollment, an order then arrives, and a winback *call* task survives on a
  customer who just bought (migration R3's trace found exactly this).

Playbook set v1 (all ship `propose_only`): post-first-order welcome (T0,
→auto), reorder due (T1, →auto), review request (T4, →auto), at-risk save
(→review), lapsed winback (→review), interested follow-up (→review→auto
after parity), ghosted revive (→review + human-ack un-suppress),
stalled-deal nudge (auto task-creation, capped).

● **Graduation thresholds fit the base** (CEO R2): high-volume playbooks
(T0/T4) keep ≥20 proposals · ≥90% graded correct · ≥14 days; low-volume
playbooks (at-risk, lapsed, revive — 2–5 fires/wk) use **N=10**, and §8
names which are expected to live in review mode permanently — ◇ **at-risk
save, lapsed winback, ghosted revive** — their review UX is a 10-second
Slack action, designed for it.

---

## 4. Tasks — one system

`tasks`: company/contact/deal refs, type, title, note, due_at,
completed_at/by, assignee, priority, source, **reason**, snooze_until,
`sequence_message_id` FK, `pipedrive_activity_id` (migration).

- ● **Decided: `sequence_messages.task_open` stays as a projection** (the
  transactional-pair design only coheres that way). One `completeTask()`
  updates both in one better-sqlite3 transaction; the engine's exit-void
  cascades to open tasks (order arrives ⇒ the call task dies). ● Touchpoint
  migration is **~9 sites, not 5** (void, self-heal, creation, ACTIONABLE
  gating, counts, markDoNotContact, markTaskDone, queue page, API allowlist)
  — re-costed at ~1wk including UI. Tasks get their own staleness rule (the
  engine's only voids `queued_review`).
- **Call semantics ported in full** — ● *both* paths (rep R2): the staged
  retry/complete loop (`RETRY_DISPOSITIONS` reschedule → tomorrow; final
  dispositions complete + restore home folder + evict from today's folder)
  **and** the connected-call fallback close (`NOT_REACHED_DISPOSITIONS`
  complement): Sandra reaching a retailer during any session auto-closes
  their open call task — no zombie tasks.
- ● **Top-up model specified** (rep R2): one folder-level target (~40, per-rep
  setting); fill order = overdue + rep-dialed retries first, then manual
  tasks, then sequence steps, then playbook top-up; top-up runs once at
  morning folder build, **never mid-session**. ◇ Overdue and retries are
  never dropped — the folder may exceed the target; only top-up sources
  truncate, and truncated sequence steps surface in §8's skipped/stale
  count. Per-playbook mute/snooze per rep. ◇ Naming note for the
  implementer: `pb_call_queue`'s existing column is `activity_id`; the new
  tasks column is `pipedrive_activity_id` — they are different columns.
- `/tasks` + record panels + minimal My-day at P1 (today's tasks, queue
  count, overdue; ● with a "Faire batch" grouping if Christina prefers her
  weekly-batch rhythm — ask her, §14 Q5).

## 5. Deals — unification + the board build

1. **Board rebuild is a real workstream (1–2wk)** — the frame kanban was
   retired; `/pipeline` is analytics. Reps acceptance-test (drag, find, log)
   before any flip; table+filters is an acceptable alternative if reps
   choose it.
2. **`pipedrive_deals` has 22 readers** (verified) — enumerate with
   per-reader disposition; frame `deals` gains `pipeline` + `lost_reason`
   (raw + mapped; backfilled from PD before retirement); `runFullSync`'s
   destructive projection rebuild is disabled once the flip flag is on.
3. **Atomic flip + ● replay runbook** (migration R2): the deploy that enables
   the frame-writer flag also demotes inbound **deal** events to log-only and
   deletes the lost→status write (echo path verified: `mapLostReason("") →
   not_interested → suppression`). ● Scope the demotion to deal events only —
   `handleActivity` keeps running through the union period or PD-side
   completions stop clearing folders. ● Post-flip runbook step: replay deal
   events with PD `update_time` < flip timestamp from `pipedrive_webhook_
   events` (deploy=restart means PD retries deliveries after the flip), or
   one final full pull of open deals — then frame deals are authoritative.
4. At flip, PD board is reference-only for reps (● no true read-only
   permission exists in Pipedrive — enforced by convention + the P0
   walkthrough, and by deactivating rep seats at drain, §10.6). ● Flip on a
   Monday; same-day walkthrough; daily 15-min check-in with both reps for
   week one; named "undo my mistake" contact.

## 6. Suppression & consent

- **`assertSendable(companyId, channel, address)`** in every adapter
  dispatch path — Instantly pushes, PB folder builds (● both union sources:
  imported PD activities pass the same gate), catalog mail, Gmail, Twilio,
  Faire. No bypass parameter exists anywhere.
- ● **One shared `normalizeAddress(channel, raw)`** — E.164 via libphonenumber
  (US default) for phones; lowercased/trimmed emails (plus-addressing kept
  distinct, documented) — used by every writer AND the checker; a
  writer/checker mismatch silently un-suppresses.
- **`suppressed_contacts (channel, normalized_address, reason, source,
  created_at)`** fed by: Instantly unsubscribes, PB opt-out webhooks (today
  these only write feed rows), Twilio STOP, Gmail-reply opt-outs, hard
  bounces (email-scoped), ● and Pipedrive-side opt-outs during overlap
  (polled ≤hourly). ◇ The ≤4h sync SLA (a canary precondition) applies to
  the **automated PD→frame direction**; frame→PD propagation is the daily
  manual diff loop (§9 — no API exists), and any missed propagation found
  there counts as a **canary defect**.
- **Sticky channel-scoped DNC** (`do_not_call/email/sms`), surviving status
  transitions; ● suppression→task cascade per §3.
- **SMS:** prior-express-written consent per number, recorded (source, date,
  exact consent text ● + CTA screenshot/URL for 10DLC vetting); scraped
  numbers categorically ineligible; ● consent UX specified: unchecked-by-
  default checkbox, not a purchase condition, full disclosure set (program
  name, frequency, rates, STOP/HELP, privacy link); order-confirmation may
  only *invite* a keyword opt-in, not constitute consent. 10DLC kickoff at
  sign-off (weeks lead, ~$50 + ~$2–10/mo). Quiet hours 9am–8pm recipient-
  local — ● applied to calls too, ◇ mechanically: the morning folder build
  orders contacts by timezone (Eastern first, Pacific last), since a static
  folder dialed in order all day cannot rely on the rep as the enforcement
  layer.
- **Faire:** rung 2 (task + deep-link + rendered message) is the ceiling;
  rung 3 needs Daniel's written risk acknowledgment and never a rep login.
- **Gmail:** warm/known contacts only; 30–50/day/sender; Workspace domain
  with SPF/DKIM/DMARC (● verify Daniel's sending domain first — currently
  @gmail.com); ● CAN-SPAM footer injected at dispatch time *outside* the
  editable body region of the review queue; opt-out replies → suppression
  (immediate, satisfying the 10-business-day rule — stated).
- ● Continuity sheet export (§9) carries a DNC/suppressed column + "re-check
  on recovery" header + restricted access (customer PII).

## 7. Channels

| Channel | Plan | Phase |
|---|---|---|
| Cold email | Instantly unchanged; ● suppression pushes OUT to its blocklist in the same job (it sends steps 2–N autonomously after our gate) | — |
| Sequence 1:1 email | Gmail review-mode send P2 (OAuth per sender, rep clicks send; honest 1–2wk); auto + `send_as_reply` threading only where copy proven + reply capture exists (3–4wk, P3) | P2/P3 |
| Calls | folders ← frame tasks; ● overlap = union build with **`source` + `task_id` columns added to `pb_call_queue`** (single-slot schema can't dedupe today — verified), dedupe on `pipedrive_activity_id`, and on final disposition **close both sources** (extend the existing fallback closer); ● completed PD-stamped tasks write `updateActivity(done)` back until drain — otherwise PD sequences stall and drain never hits zero | P1b–P4 |
| Faire | task adapter (rung 2) | P1b |
| Direct mail | playbook/sequence step = tag write; ● suppression removes the tag + pre-campaign PostPilot audience scrub | P1b |
| SMS | per §6; pilot = reorder reminders to consented customers | P3+ |
| Nurture | Omnisend unchanged; ◇ **every email-channel suppression propagates to it** (simplest safe rule — CAN-SPAM opt-outs are honored across our sending, not per-system) | — |

**Adapter reliability:** `sending` intent row before any provider call — ●
written to `outreach_messages` as `sent_unverified` (that's the ledger
cooldowns actually read), flagged for human review, never auto-retried.
Staleness voiding extends to `approved`; N consecutive adapter failures
flips the channel's auto steps to review + Slack alert.

## 8. Governance & the CEO surface

- Graduation per §3 (volume-adjusted); review→auto requires Daniel's logged
  approval, per playbook per channel; no auto on a sends-as-rep channel
  without that rep's revocable opt-in + "sent as you" log.
- Two surfaces: send queue (reps) vs proposal grading (Daniel/manager).
- Observability: tick errors → Slack; dead-man alert (engine enabled, no
  tick 30min); per-playbook anomaly alert vs trailing baseline; every action
  emits `activity_feed` with reason.
- **CEO daily digest** (P0, grows through P1): actions taken by autonomy
  level · tomorrow's planned · approvals waiting · skipped/stale counts ·
  per-playbook proposed/sent/replied/exited/ordered with conservative
  revenue attribution; ● **at-risk proposals pinned at top of week 1's first
  digest** (the thing Daniel asked for, visible in 7 days); ● Friday edition
  carries the weekly cost-vs-revenue rollup (no second artifact); ● during
  overlap, a **migration-health section**: reconciliation diff count, PD
  in-flight remaining, mirror divergence, canary defects.
- ● Kill switches work from a phone: Slack-action or token-guarded ops
  endpoint (the frame UI sits behind login middleware — after this week's
  outage, 9pm-from-phone is the design case), plus global/per-playbook/
  per-channel flags.

## 9. Continuity, rollback, canary

- Nightly rep-readable export (call list + follow-ups due, DNC column);
  documented restore; tick dead-man; PD reference window ~90d post-drain
  (● one admin seat — see §10.6 — rep seats deactivate at drain).
- Rollback: PD Sequences **paused not deleted** (● P0 task verifies in the
  live account that pausing holds in-flight items resumable — not assumed);
  mirror contractually complete during overlap — ◇ enumerated: the frame
  emits `activity_feed` events for `deal_created`, `deal_stage_changed`,
  `deal_won`, `deal_lost`, `task_created`, `task_completed`, and
  `sequence_email_sent`, and each gets a `mapActivity` entry + inclusion in
  the mirror sweep's WHERE clause (today it matches only `instantly_%` /
  `phoneburner_%` — the claim is only as complete as this event list); revert switch =
  flag off + handler restored + folders from PD + divergence report.
- ● **Canary redesigned** (CEO + eng + migration R2): cohort assignment is
  deterministic and persisted (`companies.seq_cohort` by stable hash) so
  scans can't re-roll membership and reconciliation can partition.
  **Triggers are defects, not rates** — any double-touch, suppression miss,
  lost/duplicated call task, or send outside caps ⇒ auto re-point to PD.
  Rate comparison uses only mechanically-recorded-by-both metrics (orders,
  call dispositions); reply-rate comparison is explicitly excluded until
  reply capture exists (PD auto-detects replies; the frame's signal is a
  human click until P3 — the comparison would be biased by construction).
  Precondition: bidirectional opt-out sync ≤4h verified. ● Daily PD-cohort
  suppression diff is an explicit manual loop during overlap (no API exists
  to stop a PD sequence item programmatically).

## 10. Pipedrive migration mechanics (● §10.1 redesigned — no Sequences API)

1. **In-flight guard, two mechanisms** (replacing the impossible "daily
   sequence poll"): (a) **one-time CSV export** from each PD sequence's
   overview at flip day → `pd_inflight` table (company, sequence, expected
   end), decayed by observable artifacts (open sequence call activities via
   `listActivities`, per-deal mail spot-checks) and a weekly manual UI read;
   (b) **conservative superset guard**: `checkEnrollable()` (● the real
   function name) and `findCandidates` refuse any company with an open deal
   in the catalog pipelines — ◇ active from P1a's first real send (during
   P1a/P1b, live PD sequences coexist with frame playbook sends; the guard,
   not review-mode eyeballs, is the double-touch control) — until drain
   completes. ◇ Post-drain fatigue rule: `checkEnrollable` also refuses for
   14 days after that company's `pd_inflight.expected_end`, and review cards
   carry a "recently finished a Pipedrive sequence" badge — a contact who
   just absorbed a full no-reply PD sequence must not be instantly
   re-enrollable with zero cooldown (migration R3 trace). ● Synthetic
   `outreach_messages` rows are dropped from the design (cooldowns only bind
   nudge-class sequences; ledger semantics and dedup break — verified). New
   PD enrollments cease at flip, so the guard set shrinks to zero naturally.
   Reply-mirroring from PD is manual (queue banner from the weekly read).
2. **Task import:** open PD call activities → frame tasks stamped
   `pipedrive_activity_id`; union folder builds per §7; ● completion
   write-back to PD until drain.
3. **Authority flip** per §5.3 including the replay runbook.
4. **History import before seat cancellation:** notes, mail, activities,
   files via stamped IDs → frame timeline `source:'pipedrive_archive'`; ●
   budget the unwrapped API surface (listNotes, files, mail bodies via
   `body_url` — none wrapped today, all exist in PD v1); ● unmatched-org
   orphan archive pass (webhook-created projection rows can have NULL
   company_id) so count verification reconciles to zero rather than showing
   permanent unexplained diffs.
5. **Reconciliation ops endpoint** (lib + both front doors per AGENTS.md):
   open deals by pipeline×stage; open activities vs tasks due per rep;
   orders↔won. ● Honestly labeled: PD per-sequence in-progress is a human
   UI read (no API); "suppression equality" is redefined as frame
   `suppressed_contacts` vs Instantly blocklist + PB opt-out feeds (a PD
   suppression list doesn't exist). Rep switch gate: zero unexplained diffs,
   two consecutive days; re-run at retirement.
6. **Retirement ordering ●:** drain to zero → **history import verified
   (needs a live admin token)** → rep seats deactivated → ~90d reference on
   the one admin seat → webhook DELETEd (● the id was never persisted —
   store it now, or `GET /webhooks` to find it) + inbound creds cleared →
   `pipedrive_retired` flag set (makes `resetPipedriveSyncState()` refuse;
   `pipedrive_deals` frozen as archive, never dropped) → last seat
   cancelled.

## 11. Rep experience

Accounts + `rep` role (scoped away from finance/ROI) at P0; mobile audit at
P0 with ● a contingent 3–5-day phone-usable-My-day line reserved in P2
(dropped if the audit clears — the gate can't be waved through for schedule
reasons); training session + cheat sheet; ● flip-week support routine (§5.4).
Click-paths: ● record-level stop/pause + Slack interested-alert repoint to
frame records land **P1b** (reps live in the frame from P1b); PB deep-link
buttons on frame records P1b; PB contact-field repoint at the P2 flip. Gate
language everywhere is "reps sign off," not "time elapsed."

## 12. Ops constraints (unchanged)

Single container, sync SQLite, 5-min cron floor, 1 job/tick, deploy=restart:
state-scan triggers, budgets/caps, intent rows, batch-shaped handlers,
re-derive idempotency, no resident agent loop.

## 13. Phases (● resequenced per round 2; costs restated)

| Phase | Contents | Exit gate |
|---|---|---|
| **P0** (~1wk) | Engine on in shadow; shadow digest with at-risk pinned first; rep accounts/role; mobile audit; PD invoice; ● PD pause-behavior + seat-deactivation verification in the live account; ◇ verify every active PD sequence is deal-attached (the §10.1 open-deal guard is only a superset if so); consent/10DLC kickoff if SMS approved; ● webhook id captured | 7 days of sane shadow output read by Daniel; at-risk proposals visible in week 1 |
| **P1a** (~1wk) | ● Suppression enforcement FIRST (assertSendable + address table + sticky DNC + outward propagation + cascade); at-risk + reorder playbooks in review mode; ◇ interested-prospect follow-up playbook in review mode (its review form needs no reply capture — prospects were the other half of the ask and don't wait for P3); ◇ one-time backfill of ALL existing suppressions/DNC into the Instantly blocklist (outward propagation is forward-only; pre-existing suppressed contacts are otherwise still reachable by steps 2–N of running campaigns — Twilio equivalent repeats at SMS launch); CEO digest v1 | First real at-risk save queued for review; zero suppression misses in a seeded test |
| **P1b** (~2wk) | Tasks table + single-source refactor (~1wk); ● folder union ships **alone** mid-phase behind a build-source flag (the only P1 item touching live rep revenue flow — its own deploy window + dry-run oracle); Faire task adapter; direct-mail step; /tasks + My-day; Slack-alert repoint | ● Testable gate (rep R2), ◇ direction fixed: the **new union build runs in dryRun against the live legacy build** for 3 consecutive days (never the reverse — the untested build stays out of the dialer until it passes); "unexplained" diff is defined = any row NOT tagged with a frame-only `source` (Faire/playbook tasks are expected diffs); every PB disposition that day reflected in frame task state (counted mechanically); ≥1 retry verified reappearing next morning; exit-void verified once; both reps |
| **— go/no-go —** | ● Daniel decides P2 with P1 data (criteria in §1) | proceed / stop-and-keep-PD |
| **P2** (~2–3wk) | Board rebuild + rep acceptance; atomic flip + replay runbook (after board sign-off); Gmail review-mode adapter; six sequences migrated; canary starts (defect-triggered) | Board signed off; canary: zero defects for 2wks |
| **P3** (~2–3wk) | Reply capture + threading/auto where proven; prospect playbooks (interested, ghosted-revive + reQualify); evidence bands + provenance UI; SMS pilot if consent+10DLC landed | First frame-attributed order; ≥2 playbooks graduated |
| **P4** (~1–2wk) | Drain; history import; reconciliation; retirement checklist §10.6 | Checklist complete |

Sums: 8–11wk nominal + buffer = the honest 10–14wk band. ◇ Calendar
anchors on approval: if P0 starts the Monday after sign-off, at-risk
proposals appear in the digest by **day 7**, the first real at-risk save
queues by **~day 14**, the P1→P2 go/no-go lands **~week 5**, and retirement
(if pursued) completes **~week 10–14**.

## 14. Open questions for Daniel (blocks / default-if-silent)

1. **SMS** under §6's consent-only rule? *(blocks 10DLC kickoff / default:
   out of scope, all else proceeds)*
2. **Cold email stays on Instantly?** *(blocks nothing / default: yes)*
3. **Board: kanban rebuild vs table+filters?** Reps decide. *(blocks P2
   start / default: kanban lookalike)*
4. **Seats beyond Sandra/Christina/Daniel?** *(blocks role design / default:
   three)*
5. **Rep habits audit:** what do they use PD mobile for; ● does Christina
   prefer weekly Faire batching or a daily trickle? *(◇ blocks §11's mobile
   contingency line and §13's P1b/P2 gates + Faire scan cadence / default:
   mobile matters → contingent P2 line stays; Faire stays batched weekly)*
6. **Agent chat panel** in scope? *(blocks nothing / default: backlog)*
7. **Pipedrive invoice** — the number. *(blocks §1 finalization / default:
   estimate stands)*
