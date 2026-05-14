# Project: Mac mini LLM prospect classifier

**Owner:** Daniel
**Type:** Infrastructure / Sales ops automation
**Status:** Code complete, awaiting Mac mini setup
**Estimated wall-clock to backlog complete:** 3–5 days continuous runtime

---

## TL;DR

We have ~107,000 prospects in the-frame that are missing industry
classifications and contact info. Hiring or outsourcing this would cost
thousands of dollars and weeks of calendar time. Instead, we're using a
Mac mini in the office to run a free open-source AI model (Qwen 2.5) that
classifies + enriches every prospect on autopilot, in about 3–5 days.

The setup is one-time: install Ollama, pull the model, clone the repo,
set three environment variables, start the worker as a service. After
that it runs 24/7 with no human attention until the backlog is done. New
prospects added to the system get picked up automatically.

---

## Why this exists

**The problem.** Our prospect list has 125K rows scraped from Google Places,
Storemapper, and CSV imports. About 78% have NO industry tag at all, and
another 7% have only an internal "manual_review" placeholder. That means
our sales team can't filter cleanly ("show me independent bookstores in
the Northeast"), and we can't run targeted email campaigns by store type.

**Why we can't just use the API of a cloud LLM provider.**
- Cost would be $5–15 per 100K rows on Groq or similar — manageable, but
- We'd be sending the names, websites, and locations of every prospect to
  a third party
- The free local model is genuinely good enough for this classification
  task — the cloud models pull ahead on complex reasoning, not on
  "is this a bookstore or a pharmacy"

**Why a Mac mini.**
- An M2 (or newer) Mac mini with 16 GB unified memory runs the Qwen 2.5 7B
  model just fine — about 40 tokens/second
- No subscription, no per-row cost
- Office hardware, no procurement
- Quiet, low-power, can sit on a shelf for years

---

## What this thing actually does

For each prospect on our list, the Mac mini will:

1. **Visit the prospect's website** (if they have one) and read the
   homepage to figure out what kind of business they are
2. **Or, if they don't have a website**, run a Brave Search for their name
   and location and read the first 3 result snippets
3. **Extract their contact details** from the same page — email, phone,
   contact-us form URL, Instagram, Facebook
4. **Ask the local AI model** to classify the business into one of 16
   industry buckets (bookstore, pharmacy, car wash, boutique, etc.) and
   decide whether it's a fit for Jaxy's wholesale program
5. **Send the result back to the-frame** which:
   - Updates the prospect's industry column
   - Marks them as "qualified", "not_qualified", or leaves them for human review
   - Fills in any contact info that was missing
   - Records the full AI verdict in an audit log

The AI model never makes the final decision on its own when it's uncertain.
Cases like "this might be a small regional chain" or "data is too thin to
be sure" go into a human review queue accessible at
`https://theframe.getjaxy.com/prospects/review`.

---

## What the PM owns

### Before setup

- [ ] Confirm the Mac mini's specs (chip + RAM). Minimum: Apple Silicon M1/M2/M3/M4 with 16 GB unified memory.
- [ ] Confirm the Mac mini has stable wifi/ethernet and won't be moved during the backfill.
- [ ] Get the Brave Search API key from Daniel (or wherever it's stored).
- [ ] Get the GitHub repo clone URL for the-frame.
- [ ] Get the shared secret token (Daniel will generate one — same value goes on Mac mini AND Railway).

### During setup

- [ ] Pass the setup guide (`docs/MAC_MINI_SETUP.md` in the the-frame repo)
      to whoever will physically work on the Mac mini. The guide is
      step-by-step and assumes basic Terminal comfort. If they're using
      Claude Code on the Mac mini, just point Claude at the guide and it
      can follow it autonomously.
- [ ] Confirm the smoke tests pass (the guide includes one fake-row test
      and one 5-row real test).
- [ ] Confirm the worker is running as a managed service (`pm2 status`
      should show `jaxy-classifier` as "online").

### During backfill (days 1–5)

- [ ] Check `/prospects` in the-frame every day or two — the Industry
      counts should be climbing. Reasonable targets after 24 hours:
      - 10–20K rows classified
      - ~2K showing up in human review queue
- [ ] If the Mac mini reboots or loses power, the worker auto-restarts
      via pm2 + launchd. No action needed unless it's been more than
      30 minutes since the last classification batch (check via pm2 logs).

### After backfill

- [ ] Daniel + team start working through `/prospects/review` —
      typically ~5K rows that need human judgment. Each takes 5–15
      seconds with the LLM verdict card showing the suggestion.
- [ ] Mac mini stays on indefinitely. New prospects imported nightly get
      picked up the next morning.

### Ongoing

- [ ] Watch for the rare anomaly:
      - If many rows get rejected by mistake → tweak the AI prompt
        (Daniel handles this)
      - If the Mac mini stops processing → restart pm2
      - If Brave Search starts returning errors → check API quota

---

## What the engineer / Claude Code on the Mac mini does

There's a self-contained setup guide at `docs/MAC_MINI_SETUP.md` in the
the-frame repo. It covers:

1. Install Ollama (the local AI runtime)
2. Pull the Qwen 2.5 7B model (~4.5 GB one-time download)
3. Install Node.js if not present
4. Clone the the-frame repo
5. Set up environment variables in `~/.classifier.env`
6. Run a smoke test with a fake row (no DB writes)
7. Run a smoke test with 5 real rows (writes to production DB)
8. Start the worker as a pm2-managed service
9. Configure macOS not to sleep
10. Set up monitoring

About 30–45 minutes of setup if done end-to-end. The Mac mini doesn't
need any inbound network access — it only makes outbound HTTPS calls.

---

## Architecture (one-paragraph version)

The Mac mini pulls batches of unclassified prospects from the-frame's API,
visits each prospect's website (or runs a Brave Search if they don't have
one) to gather context, sends the data to the locally-running Qwen 2.5 AI
model for classification, then posts the results back to the-frame's API,
which updates the prospect's industry + status + contact info. All
classifications are also logged to an audit table so we can review them
later, change the prompt, and re-run if needed. The worker runs on a loop
24/7 — when it processes everything, it sleeps an hour and checks for new
prospects. Restart-safe and stateless.

---

## Architecture (diagram)

```
┌──────────────────────────────────────┐         ┌────────────────────────────┐
│        Mac mini (your office)        │         │  Railway (the-frame)        │
│                                      │         │                            │
│  ┌────────────────────────┐          │         │  Database                  │
│  │  Ollama @ :11434       │          │         │  • prospects               │
│  │  Qwen 2.5 7B (4.5 GB)  │          │         │  • LLM classifications log │
│  └────────────┬───────────┘          │         │                            │
│               ▲                      │         │  API endpoints             │
│               │                      │  HTTPS  │  • GET unclassified prosp. │
│  ┌────────────┴───────────┐    ─────▶│         │  • POST batch results     │
│  │  classify-worker.ts    │          │         │                            │
│  │  Loop:                 │          │         │  Web UI                    │
│  │   1. Fetch 50 prosp.   │          │         │  • /prospects (filtered)   │
│  │   2. Visit websites    │ ◀────────│         │  • /prospects/review       │
│  │   3. Classify (Qwen)   │          │         │    (human review queue)    │
│  │   4. Post results      │          │         │                            │
│  └────────────────────────┘          │         └────────────────────────────┘
│            │                         │
│            │ scrapes prospect site    │
│            │ OR queries Brave Search  │
│            ▼                         │
│        Public internet               │
└──────────────────────────────────────┘
```

---

## Cost / time / scale

| Item | Estimate |
|---|---|
| One-time setup (engineer time) | 30–45 minutes |
| Brave Search API spend (107K backlog) | ~$210 one-time, mostly billed in cents |
| Electricity to run Mac mini for 5 days | ~$0.50 |
| Cost per ongoing prospect classification | Effectively $0 |
| Wall-clock to clear 107K backlog | 3–5 days on M2 base; 2–3 days on M2 Pro / M4 |
| Throughput steady-state | 5–8 prospects/minute |
| Human review queue after backfill | ~5,000 rows (estimated 5–10% of input) |

---

## What success looks like

After 5 days, you should see roughly:

- ~100K prospects with an `industry` value set (out of 125K — the rest are
  rows with truly no signal, like an Outscraper row that only has a phone
  number)
- ~50K marked `qualified` (automatically approved)
- ~50K marked `not_qualified` (chains, out-of-scope industries, kids
  stores, etc. — auto-rejected)
- ~5K in human review queue (industries we're uncertain about, or rows
  flagged for chain-likely / weak-data)
- Substantial contact-info backfill: tens of thousands of new emails,
  phone numbers, and contact-form URLs harvested from homepage scrapes
- An audit table (`prospect_llm_classifications`) with one row per
  classification — full history of which prompt version produced which
  verdict

---

## Risks + failure modes

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mac mini loses power / network | Medium | Pauses progress | pm2 auto-restarts on boot; worker resumes from where it left off |
| Ollama crashes mid-batch | Low | Wasted time on that batch | pm2 detects + restarts; next batch retries |
| Brave Search rate-limits us | Low | Slows enrichment | Free tier is 1 req/s, we stay under it; can upgrade if needed |
| Prompt produces bad classifications | Medium | Bad sales targeting | Audit table preserves history; tweak prompt + re-run with `--include-stale` |
| AI flat-out rejects too many good prospects | Low | Lost opportunities | Human review queue catches the borderline cases; auto-rejected can be batch-overridden later |
| Mac mini sleeps mid-run | Medium → 0 with config | Pauses progress silently | Setup guide step 10: System Settings → Energy → never sleep |
| Disk fills up | Very low | Process dies | Model + repo + logs total ~6 GB; trivial |
| GitHub repo updates break things | Low | Worker may stop processing | `git pull` not automatic — must be intentional |

---

## What the PM needs to flag back to Daniel

- **Setup blockers:** any step in MAC_MINI_SETUP.md that's confusing,
  fails, or needs clarification
- **Slower than expected throughput** (sustained < 3 rows/min would
  suggest either a hardware problem or a network issue)
- **Reject-rate above 60%** after first 10K rows — could mean the AI is
  being too aggressive; Daniel can tune the prompt
- **Anything weird in the human review queue** — if 80% of rows are
  flagged "small_chain_likely", the chain-detection heuristic needs
  adjusting

---

## Useful links

- the-frame production: <https://theframe.getjaxy.com>
- Prospects list: <https://theframe.getjaxy.com/prospects>
- Review queue: <https://theframe.getjaxy.com/prospects/review>
- Setup guide (engineer): in the the-frame repo at `docs/MAC_MINI_SETUP.md`
- Ollama: <https://ollama.com>
- Brave Search API: <https://brave.com/search/api/>

---

## Glossary

- **the-frame**: our internal dashboard (the Next.js app on Railway).
- **Ollama**: open-source software that runs AI models locally.
- **Qwen 2.5 7B**: the AI model. Made by Alibaba's Qwen team, 7 billion
  parameters, free + open source. Roughly comparable quality to
  GPT-3.5 for classification tasks.
- **Brave Search**: search engine API used as a fallback when a
  prospect has no website. Cheap (~$3 per 1,000 queries).
- **Classifier worker**: the script (`scripts/classify-worker.ts`) that
  runs on the Mac mini in a loop.
- **Industry bucket**: the curated category each prospect is sorted into.
  16 total, e.g. "eyewear_optical", "bookstore", "car_wash".
- **Verdict**: the system's decision per row — `approve`, `reject`, or
  `needs_human`.
- **pm2**: a Node.js process manager. Keeps the worker running, restarts
  it on crash, runs it as a system service so it auto-starts at boot.
