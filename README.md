# The Frame

Jaxy's internal business operations platform — modular ERP for eyewear brand management.

## Tech Stack

- **Framework:** Next.js 16 (App Router, TypeScript)
- **UI:** shadcn/ui + Tailwind CSS v4
- **Database:** SQLite (better-sqlite3) + Drizzle ORM
- **Auth:** NextAuth v5 (credentials + JWT)
- **Deployment:** Railway

## Local Development

```bash
npm install
npm run dev        # http://localhost:3000
```

Default login: `daniel@getjaxy.com` / `jaxy2026`

## Project Structure

```
src/
├── app/              # Next.js pages & API routes
├── components/ui/    # shadcn/ui components
├── lib/              # Shared utilities (db, middleware)
├── modules/          # Feature modules
│   ├── core/         # Auth, logging, events, jobs, webhooks
│   ├── catalog/      # Product catalog (migrated from catalog-tool)
│   ├── sales/        # CRM & pipeline
│   ├── orders/       # Order management
│   ├── inventory/    # Stock tracking
│   ├── finance/      # Xero integration
│   ├── customers/    # Customer health
│   ├── marketing/    # Campaigns
│   └── intelligence/ # AI agents
└── scripts/          # Migration & utility scripts
```

## Railway Deployment

1. Create a Railway project and link this repo
2. Set environment variables:
   - `NEXTAUTH_SECRET` — generate with `openssl rand -base64 32`
   - `NEXTAUTH_URL` — your Railway URL
   - `DATABASE_URL` — path to SQLite on Railway volume (e.g., `/data/the-frame.db`)
3. Attach a volume mounted at `/data`
4. Deploy — Railway uses `railway.toml` config automatically

### Health Check

```
GET /api/health → { status: "ok", version, uptime, modules, database }
```

### Webhooks

```
POST /api/webhooks/{provider}  # provider: shopify, faire, instantly, xero, test
```

## Database

SQLite with WAL mode. The `data/` directory is gitignored — the DB lives on Railway's persistent volume in production.

To migrate catalog data from the old catalog tool:
```bash
npx tsx src/scripts/migrate-catalog.ts
```
