# Scheduled jobs (centralized cron)

The-frame uses **one** Railway cron service that pings an internal endpoint every minute. The endpoint reads a code-defined registry of jobs and runs whatever's due. Do **not** create per-job Railway cron services — they're disabled / superseded.

## Architecture

```
Railway cron service (every minute)
    │
    ▼
POST /api/v1/cron/tick
    │
    ▼
src/modules/integrations/lib/cron/scheduler.ts
    │
    ▼
src/modules/integrations/lib/cron/registry.ts  ← edit this to add jobs
```

State + history live in `cron_job_state` and `cron_runs` tables. The dashboard at `/settings/cron` shows last run / status / "Run now" per job.

## Adding a new cron job

1. **Add an entry to `CRON_JOBS` in [`src/modules/integrations/lib/cron/registry.ts`](../src/modules/integrations/lib/cron/registry.ts):**

   ```ts
   {
     id: "your-new-job",          // stable kebab-case
     schedule: "0 14 * * *",       // standard 5-field cron, in UTC
     description: "What this job does, plain English",
     handler: async () => {
       // call a lib function or fetch an internal route
       const result = await syncSomething();
       return result;              // returned value is JSON-stored in cron_runs.result
     },
   },
   ```

2. **Optional — gate by condition:**

   ```ts
   {
     id: "...",
     schedule: "*/15 * * * *",
     handler: doThing,
     guard: () => isDuringBusinessHours(),  // returns false → run logged as "skipped"
   },
   ```

3. **Push and deploy.** No Railway dashboard work. Job appears on `/settings/cron` and starts running on the next matching tick.

## Cron expression cheat sheet

5-field UTC. PT comments below assume PST (UTC-8); during PDT (UTC-7) jobs run 1 hour earlier in local time. We accept this drift for digest-class jobs.

| Schedule | Meaning |
|---|---|
| `* * * * *` | Every minute |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Top of every hour |
| `0 14 * * *` | 14:00 UTC daily (~7am PT) |
| `0 15 * * 1` | 15:00 UTC Mondays (~8am PT Monday) |
| `0 9 1 * *` | 09:00 UTC on the 1st of every month |

Day-of-week: 0=Sunday, 1=Monday, ..., 6=Saturday (and 7=Sunday too). When both day-of-month and day-of-week are explicit, cron's quirky OR rule applies — implemented in `expression.ts:matches()`.

## Concurrency / idempotency

- Each job acquires `cron_job_state.in_progress` before running. A second tick landing while the job is still running cleanly skips it.
- Stale locks (>15 min) are auto-released — the next tick treats them as crashed runs.
- Idempotency of the *work* is the job's responsibility (e.g. `xero-payout-sync` uses `xero_payout_syncs` to skip already-synced payouts; `shopify-orders-sync` skips orders already in DB).

## Disabling a job

Two ways:

- **Permanently** → remove the entry from `CRON_JOBS` (PR-reviewed, version-controlled). Job stops appearing in the UI immediately.
- **Temporarily** → toggle the **Enabled** switch on `/settings/cron`. Writes to `cron_job_state.enabled`. Survives deploys; flip back any time.

## The Railway cron service

Exactly one service, named **`cron-scheduler`** (or similar). Configuration:

| Setting | Value |
|---|---|
| Source | Docker Image: `curlimages/curl:latest` |
| Start command | `curl -fsS -X POST https://theframe.getjaxy.com/api/v1/cron/tick` |
| Cron schedule | `* * * * *` (every minute) |
| Restart policy | None (auto-disabled by Railway for cron services) |

Total compute: ~1 second per minute. Negligible cost.

## Don'ts

- ❌ **Do not** create a separate Railway cron service per job. The old `shopify-health-cron` style is deprecated.
- ❌ **Do not** call `runJob` from anywhere except the scheduler (`tick`) or the manual-trigger API endpoint. Direct calls bypass the lock and audit log.
- ❌ **Do not** put long-running work (>10 minutes) in a single job — Railway free tier has request timeouts. Break large work into per-tick chunks (process N items per run, mark progress in DB).
- ❌ **Do not** read `cron_job_state` directly from feature code. Use `listJobs()` or `setJobEnabled()` from `scheduler.ts` so the lock semantics stay consistent.

## Files

| File | Purpose |
|---|---|
| `src/modules/integrations/lib/cron/registry.ts` | **Edit this** to add/remove jobs |
| `src/modules/integrations/lib/cron/scheduler.ts` | tick(), runJob(), listJobs() |
| `src/modules/integrations/lib/cron/expression.ts` | 5-field cron parser/matcher (no deps) |
| `src/modules/integrations/schema/cron.ts` | Drizzle schema for state + runs |
| `src/app/api/v1/cron/tick/route.ts` | Hit by the Railway cron |
| `src/app/api/v1/cron/jobs/route.ts` | UI feed |
| `src/app/api/v1/cron/jobs/[id]/route.ts` | PATCH (enable) / POST (run now) |
| `src/app/(dashboard)/settings/cron/page.tsx` | Dashboard at `/settings/cron` |
