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
