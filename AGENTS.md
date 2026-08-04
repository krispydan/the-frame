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

## Reachability (important)

The sandbox has open outbound internet (Shopify, Faire, Nominatim, Railway API,
GitHub all reachable). The **one** unreachable target is the app's **custom
domain** `theframe.getjaxy.com`: it resolves straight to Railway (69.46.46.67,
not Cloudflare) and requests to that Host **hang** (TLS completes, then zero
response bytes). The proxy IP is NOT edge-blocked — requests to a
`*.up.railway.app` Host on the same IP get a fast response — so the hang is
specific to how Railway routes that custom domain. To reach the ops endpoints,
use ONE of:

- **R2 (preferred):** the service's Railway-generated `*.up.railway.app` public
  domain (Railway → service → Settings → Networking → Public Networking; the
  correct one for THIS service — a stale/wrong one returns `{"message":"Application not found"}`).
  Hit that origin directly; it doesn't go through the custom-domain path that hangs.
- **R3:** a Railway project token for server-side execution (`railway run`),
  bypassing the edge entirely.

(There is no Cloudflare in front of this domain — a Cloudflare/WAF rule is NOT
the fix.)

Always route curl through the agent proxy's CA bundle:
`curl --cacert /root/.ccr/ca-bundle.crt -H "x-ops-key: $OPS_TOKEN" <url>`.
Verify access with `GET /api/admin/ops` → `{ ok: true, ... }`.
