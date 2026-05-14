# Mac mini setup: Jaxy prospect classifier worker

This is a self-contained setup guide for installing the LLM-driven prospect
classifier on a Mac mini. The worker:

1. Pulls unclassified prospects (~107K backlog) from the-frame on Railway
2. Enriches each by scraping the homepage OR querying Brave Search
3. Classifies via local Ollama running Qwen 2.5 7B
4. Posts results back to the-frame (industry, contacts, verdict)

Mac mini doesn't need any inbound network. Only outbound HTTPS.

## Prereqs

- Mac mini with Apple Silicon (M1 or newer)
- **At least 16GB unified memory** (Qwen 7B Q4 needs ~5GB at runtime; 16GB Mac handles it comfortably)
- ~10GB free disk for the model + repo
- macOS up to date
- Outbound HTTPS to: `theframe.getjaxy.com`, `api.search.brave.com`, `ollama.com`, prospect websites
- A user account that can run launchd/pm2 services

## Required credentials (have these handy)

You need three values set up *before* running the worker:

| Env var | What | Where to get it |
|---|---|---|
| `THE_FRAME_URL` | Production URL of the-frame | `https://theframe.getjaxy.com` |
| `CLASSIFIER_TOKEN` | Shared secret — must match Railway env | Generate with `openssl rand -hex 32`, set on **both** Mac mini AND Railway |
| `BRAVE_SEARCH_API_KEY` | Brave Search API key | https://brave.com/search/api/ (you have this already) |

Optional overrides:
- `OLLAMA_URL` (default `http://localhost:11434`)
- `OLLAMA_MODEL` (default `qwen2.5:7b-instruct-q4_K_M`)
- `BATCH_SIZE`, `LLM_CHUNK_SIZE`, etc. (see `scripts/classify-worker.ts` header)

## Step-by-step setup

### 1. Install Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

This sets up a launchd service that keeps Ollama running. Verify:

```bash
curl http://localhost:11434/api/tags
# {"models":[]}
```

### 2. Pull the Qwen 2.5 7B model

```bash
ollama pull qwen2.5:7b-instruct-q4_K_M
```

~4.5GB download. Verify it works:

```bash
ollama run qwen2.5:7b-instruct-q4_K_M "Reply with 'ok' if you can hear me."
# ok
```

### 3. Install Node + pnpm (if not already)

```bash
# Check
node --version    # need 20.x or later
pnpm --version    # any recent version

# Install if missing
brew install node@22 pnpm
```

### 4. Clone the-frame repo

```bash
cd ~
git clone <the-frame-git-url> the-frame
cd the-frame
pnpm install
```

The worker is `scripts/classify-worker.ts` — it imports from `src/modules/sales/lib/*` so the entire repo needs to be present.

### 5. Set environment variables

Create `~/.classifier.env` (chmod 600 — contains a secret):

```bash
cat > ~/.classifier.env <<'EOF'
export THE_FRAME_URL="https://theframe.getjaxy.com"
export CLASSIFIER_TOKEN="<the secret you also set on Railway>"
export BRAVE_SEARCH_API_KEY="<your Brave API key>"
export OLLAMA_URL="http://localhost:11434"
export OLLAMA_MODEL="qwen2.5:7b-instruct-q4_K_M"
EOF
chmod 600 ~/.classifier.env
```

### 6. Smoke-test with a single row (no DB writes)

```bash
cd ~/the-frame
source ~/.classifier.env
npx tsx scripts/classify-test-one.ts \
  --name="Sunset Surf Co" \
  --website="sunsetsurf.com" \
  --city="Encinitas" \
  --state="CA" \
  --tags="Surf shop"
```

Expected output (will vary slightly): industry=`resort_beach`, is_chain=false,
verdict=APPROVE.

If you see `✗ Ollama unreachable` → confirm `ollama serve` is running.
If you see `✗ LLM response not valid JSON` → the model might not be pulled
correctly. Try `ollama pull qwen2.5:7b-instruct-q4_K_M` again.

### 7. Smoke-test the full worker on a 1-batch dry run

```bash
source ~/.classifier.env
npx tsx scripts/classify-worker.ts --once --dry-run --limit=5
```

Should pull 5 rows from Railway, classify them, print results, exit. Nothing
written to the DB. This verifies:
- the `CLASSIFIER_TOKEN` matches between Mac mini and Railway
- the worker can reach `theframe.getjaxy.com`
- Ollama returns valid JSON
- the verdict logic runs without errors

### 8. Real first run (live, but small)

```bash
source ~/.classifier.env
npx tsx scripts/classify-worker.ts --once --limit=20
```

Processes 20 rows for real (writes to Railway DB) and exits. Check
`/prospects` in the-frame UI — you should see classifications appearing.

### 9. Run it 24/7 with pm2

```bash
# Install pm2 (only once)
sudo npm install -g pm2

# Start the worker as a managed service
cd ~/the-frame
pm2 start "npx tsx scripts/classify-worker.ts" \
  --name jaxy-classifier \
  --env-file ~/.classifier.env \
  --max-memory-restart 4G

# Save current process list, install launchd auto-start
pm2 save
pm2 startup
# (run the sudo command pm2 prints)
```

Monitor with:

```bash
pm2 logs jaxy-classifier --lines 100
pm2 status
```

To stop / restart:

```bash
pm2 stop jaxy-classifier
pm2 restart jaxy-classifier
pm2 delete jaxy-classifier   # full uninstall
```

### 10. Prevent Mac mini from sleeping

System Settings → Energy → uncheck **Put hard disks to sleep when possible**
and set **Prevent automatic sleeping when the display is off** to **always**.

If you don't want to change system settings, prefix the pm2 start command with
`caffeinate -i` instead.

## Monitoring

While running, you can watch progress on the Mac mini:

```bash
pm2 logs jaxy-classifier
```

Or from anywhere via the-frame UI:
- `/prospects?industry=` (industries fill in as classification proceeds)
- `/prospects/review` (manual review queue)

Expected throughput on a base M2 Mac mini: ~3-5 rows/minute when scraping
homepages, ~6-8/minute when Brave snippets only. For the full 107K backlog
plan on **3-5 days of continuous runtime**.

## Common issues

**"Missing required env var: THE_FRAME_URL"**
You forgot `source ~/.classifier.env` before running. With pm2, make sure
`--env-file` points at the right file.

**"Ollama HTTP 500" mid-run**
Out-of-memory. The model might have been partially evicted. Stop the worker,
`ollama ps` to verify, `pm2 restart jaxy-classifier`.

**"fetchUnclassified HTTP 401: Invalid X-Classifier-Token"**
Mismatch between the Mac mini's `CLASSIFIER_TOKEN` and Railway's. Both must
be set to the same value. After updating either side, restart that side
(redeploy on Railway, `pm2 restart` on Mac mini).

**Brave Search 429**
You're being rate-limited. Brave Search free tier = 1 req/sec, paid = 20/sec.
The worker hits Brave one row at a time so should stay under the free limit.
If you upgraded, you can increase the enrichment pool size in
`scripts/classify-worker.ts` (the `POOL = 5` constant).

**"LLM response not valid JSON"**
Qwen occasionally goes off-format. The worker will skip those rows and they'll
be picked up next loop. If it's happening on >20% of calls, the model is
probably too small for the prompt — try `qwen2.5:14b-instruct-q4_K_M`.

## Updating the worker

The prompt and verdict logic live in the the-frame repo. To pick up changes:

```bash
cd ~/the-frame
git pull
pnpm install        # only if package.json changed
pm2 restart jaxy-classifier
```

## Verifying it's working

After a few minutes of running, query the production DB to confirm
classifications are landing:

```sql
SELECT industry, COUNT(*)
FROM companies
WHERE industry IS NOT NULL
GROUP BY industry
ORDER BY 2 DESC;
```

The numbers should grow batch-by-batch.

For audit detail:

```sql
SELECT model_name, prompt_version, COUNT(*),
       date(classified_at) AS day
FROM prospect_llm_classifications
GROUP BY model_name, prompt_version, day
ORDER BY day DESC;
```
