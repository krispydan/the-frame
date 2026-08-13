<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scheduled jobs (cron)

**Always use the centralized scheduler**, not per-job Railway cron services.

- One Railway cron service hits `/api/v1/cron/tick` **every 5 minutes** (Railway's
  floor — not every minute, whatever its config says). Schedules are only
  evaluated on ticks, so `*/3` really means every 15 minutes. Write `*/5` when
  you want frequent.
- Add jobs by editing `src/modules/integrations/lib/cron/registry.ts` — one entry per job.
- Full guide: [`docs/scheduled-jobs.md`](docs/scheduled-jobs.md).

Don't create a new Railway cron service for a new scheduled job. Don't call `runJob` directly from feature code. Don't write a node-cron / setInterval scheduler.

# Deploy workflow

**Railway deploys from `main`.** Shipping a change means getting it onto `main` —
pushing to `main` is the normal, intended deploy step for this repo, not an
unexpected action.

Standard flow (develop on a feature branch, then deploy):

1. Commit your work on the feature branch.
2. `git fetch origin main`
3. `git checkout -B main origin/main`
4. `git merge --no-ff <feature-branch>`
5. `git push origin main`  ← this is the deploy
6. Fast-forward the feature branch back onto `main` so they don't diverge:
   `git checkout <feature-branch> && git merge --ff-only main && git push`

Note: the Claude Code permission gate still prompts on each `main` push unless
the user adds a `Bash(git push:*)` allow-rule to their settings. This doc records
the workflow; it does not (and cannot) disable that gate.

# Running things against production (ops endpoints)

Claude sessions can operate on **live production data** directly — running
recovery/diagnostic jobs (geocoding, address backfill, order lookup, etc.)
instead of asking the user to paste `fetch()` snippets into their browser.
This works through token-guarded HTTP endpoints, not direct DB access.

## The `/api/admin/ops/*` endpoints

- Live under `/api/admin/*`, which is **exempt from the login-session
  middleware** (`src/middleware.ts`), so they're callable without a browser
  cookie. They gate on a shared secret instead.
- Auth: send header `x-ops-key: $OPS_TOKEN` (constant-time check in
  `src/lib/ops-auth.ts`). **Mutations (POST) also require `?confirm=1`** — a
  write is never accidental. Read-only GETs need only the token.
- The heavy logic lives in libs (`src/modules/customers/lib/address-backfill.ts`,
  `geocoding.ts`, `src/modules/orders/lib/order-lookup.ts`) and is shared with
  the session-guarded `/api/v1/*` routes the UI calls — **one implementation,
  two front doors.** When adding a new ops action, put the logic in a lib and
  expose it from both.
- Full reference + endpoint table: [`docs/ops-endpoints.md`](docs/ops-endpoints.md).

## The token

`$OPS_TOKEN` is set as an **environment variable in the Claude Code
environment** (and matches the `OPS_TOKEN` env var on Railway that the server
checks against). It is available in your shell — reference it as `$OPS_TOKEN`;
**never print it, commit it, or paste it into chat.** If `echo -n "$OPS_TOKEN" |
wc -c` is 0, it isn't set for this session — ask the user to add it to the
environment's variables.

## Reachability (solved — Aug 2026)

The sandbox has open outbound internet. Production **is reachable** for
token-guarded ops endpoints, via either:

- **Preferred:** `https://the-frame-production.up.railway.app` — the service's
  Railway-generated domain. If you need to rediscover it, the `RAILWAY_TOKEN`
  in this environment is a **project token**: authenticate to
  `https://backboard.railway.app/graphql/v2` with a `Project-Access-Token`
  header (NOT `Bearer`, which returns "Not Authorized"), then query
  `domains(projectId:, serviceId:, environmentId:)`.
- `theframe.getjaxy.com` also responds now. It previously hung (TLS completed,
  zero response bytes); that has resolved. The Railway domain is still
  preferred since it skips the custom-domain path entirely.

**What this does NOT give you:** the production database. It lives on a Railway
volume as a SQLite file, so it is reachable only through deployed HTTP
endpoints — and only endpoints under `/api/admin/ops/*`, since everything under
`/api/v1/*` sits behind the login middleware. If you need to drive something
from tooling, it needs an ops endpoint.

**And note:** an ops endpoint only exists in production once the code is on
`main` and deployed. Railway deploys from `main`, so work sitting on a feature
branch is not reachable no matter what URL you use.

Always route curl through the agent proxy's CA bundle:
`curl --cacert /root/.ccr/ca-bundle.crt -H "x-ops-key: $OPS_TOKEN" <url>`.
Verify access with `GET /api/admin/ops` → `{ ok: true, ... }`.

## Never poll a POST endpoint to find out whether a deploy has landed

**This rule was written in blood: it cost $35 of Apify credit in 3½ minutes and
blew a monthly plan limit.** Read it before you write any waiting loop.

A Railway deploy takes ~5 minutes. During that window **production is running
OLDER code than the file you just edited** — so a new `action`, parameter, or
route you just wrote does not exist there yet. That version skew is the trap.

What went wrong: a loop polled `POST .../apify-qualifier-test?confirm=1` with
`{"action":"rescore"}` every 30s to detect when `rescore` had deployed. The
build then live did not know that action, and the handler's fall-through was
"start a full ten-cell scrape". Seven waves of ten runs fired before the deploy
landed. Two independent mistakes had to line up, so there are two rules:

1. **Readiness checks go on GET, always.** Probe for a marker in a read
   response (`| grep -q '<new field>'`). Never send a mutating request to find
   out whether the mutation exists.
2. **Mutating handlers fail CLOSED on anything unrecognised.** An unknown
   `action` returns 400. The expensive path requires its own explicit name
   (`{"action":"scrape"}`) and is never what an unlabelled, malformed, or
   truncated body falls through to. *The most expensive operation on an endpoint
   must never be what "I did not understand you" resolves to.*

Also: `?confirm=1` did not help here. It guards against an accidental single
call, not against a loop that includes it in every request. Treat `confirm` as
a speed bump, never as the budget control.

## Spending money from an ops endpoint

Any endpoint that calls a metered third-party API (Apify, NeverBounce,
Outscraper, an LLM) is a spending endpoint. For those:

- **Read the vendor's pricing model before the first call**, not after the
  bill. Apify's actors are pay-per-event, and the events are not obvious:
  `place-scraped` bills per result AND `filter-applied` bills per filter per
  place. Fetch it from the API rather than assuming:
  `GET https://api.apify.com/v2/acts/<user>~<actor>` → `pricingInfos`.
- **Do not ask the vendor to filter on data it already returns to you.** Rating
  and closed-status arrive on every Google Maps row, so `placeMinimumStars` and
  `skipClosedPlaces` in the actor input were billed 1660 `filter-applied`
  events — a third of that batch's cost — for two rules the scorer applies for
  free. Filter locally whenever the field is in the response.
- **Your own cost bookkeeping cannot explain a surprising bill**, because the
  spend you failed to account for is by definition the spend you did not
  record. Go to the account ledger:
  `GET /api/admin/ops/apify-usage?since=YYYY-MM-DD` — every run on the account
  by actor and by day, read-only, and it still answers while the account is
  locked out on its usage limit.
- **Check the plan headroom before starting a batch.** The Apify account is a
  **$29/month Starter plan**; at ~$0.004/place that is ~7,000 places a month
  total, shared with the customer backfill and prospect enrichment. Assume
  there is less room than you think.
- **Collect what you already paid for before spending again.** Runs bill
  whether or not anything reads their dataset back, so an uncollected batch is
  money spent for nothing. `{"action":"collect"}` on the bench ingests every
  uncollected batch and is deliberately incapable of starting a run
  (`pollBatch(..., { startQueued: false })`).
- **A 402'd account cannot read its own datasets.** Exceeding the monthly limit
  locks the whole account, not just actor starts: `GET /datasets/<id>/items`
  returns **HTTP 402** as well. So results you have already paid for become
  unreachable until the limit is raised — collect BEFORE you are near the
  ceiling, never after. What *does* still work at 402 is run and account
  metadata (`/actor-runs`, `/actor-runs/<id>`, `/users/me/usage/monthly`),
  which is why the spend ledger can still diagnose a locked-out account.

## Never swallow an error in a catch

Both failure paths in the bench's poll loop did `catch { console.error(...);
continue; }`. Seven batches then sat at "still running" with no way to see why,
because the reason existed only in logs nobody reads. That turned a
diagnosable problem into guesswork at the exact moment accuracy mattered.

**Record the reason where the caller will see it** — on the row, in the
response — not only in a log line. If a loop can silently make no progress,
it must be able to say why it made no progress.

## When you are wrong about production, get evidence

Three explanations for the Apify bill were offered from reasoning, and the
first two were wrong: "over-scraping from server-side filters" (billed places
exactly equalled kept places, 850/850) and "the month was already spent before
this ran" (the account had used $0.23 all month). The account ledger settled it
in one call.

When a production number is surprising: **build the read that answers it, then
answer.** Plain API reads (run history, usage, run records) keep working when
the account is rate-limited or locked out, so there is rarely an excuse to
theorise instead.
