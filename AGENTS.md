<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Scheduled jobs (cron)

**Always use the centralized scheduler**, not per-job Railway cron services.

- One Railway cron service hits `/api/v1/cron/tick` every minute.
- Add jobs by editing `src/modules/integrations/lib/cron/registry.ts` — one entry per job.
- Full guide: [`docs/scheduled-jobs.md`](docs/scheduled-jobs.md).

Don't create a new Railway cron service for a new scheduled job. Don't call `runJob` directly from feature code. Don't write a node-cron / setInterval scheduler.
