# The Frame — Chrome Extension

Capture lead data from any website and save it directly to The Frame CRM.

## Installation (Development)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** and select this `chrome-extension/` directory
4. The extension icon appears in the toolbar

## Setup

1. Click the extension icon → **Settings** (or right-click → Options)
2. Enter your Frame URL: `https://theframe.getjaxy.com`
3. Enter your API key (generate one in The Frame → Settings → API Keys)
4. Click **Save & Test Connection**

## Usage

1. Browse to any business website
2. Click the extension icon (or press `Ctrl+Shift+F` / `MacCtrl+Shift+F`)
3. The sidebar slides in showing auto-extracted data (emails, phones, socials)
4. If the domain matches an existing prospect, it auto-links
5. Otherwise, search for a prospect or create a new one
6. Check/uncheck items, add an optional note, click **Save to Lead**

## Database Migration

Before first use, run the migration to add required columns:

```bash
cd app
npx tsx src/scripts/migrate-chrome-ext.ts
```

## API Endpoints

- `POST /api/v1/ext/auth` — validate API key
- `GET /api/v1/ext/match?domain=example.com` — find prospect by domain
- `GET /api/v1/ext/search?q=surf+shop` — search prospects by name
- `POST /api/v1/ext/capture` — create or update prospect with captured data
