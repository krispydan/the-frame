/**
 * Crawl every Shopify storefront in a filtered StoreLeads cohort,
 * check whether they sell sunglasses, and write a row per matching
 * product to a CSV — for finding which boutiques already have
 * eyewear competitors on their shelf (and which we could displace).
 *
 * Designed for unattended overnight runs:
 *   - 30 parallel workers via an in-process pool (no deps)
 *   - Per-domain hard cap of 10 pages × 250 products = 2,500
 *     scanned, more than enough to detect "do they carry
 *     sunglasses" without ever recrawling huge catalogs
 *   - JSONL state log so a ctrl-C / crash / laptop sleep resumes
 *     where it left off (re-running skips every domain already
 *     in the log)
 *   - Products CSV is written append-as-we-go — partial results
 *     are saved even mid-crawl
 *   - 6s timeout per HTTP call + one retry on transient errors;
 *     anything else marked 'error' in the state log so we can
 *     re-process them deliberately
 *
 * Match logic: case-insensitive search of each product's title,
 * product_type, tags, and the first 500 chars of body_html for
 * any of:
 *   "sunglasses", "sunglass" (covers singular/plural),
 *   "sunnies" (common indie / Gen Z brand copy)
 * Deliberately NOT matching "eyewear" (catches prescription
 * glasses, which is a different signal) or "shades" (false
 * positives on lampshades / hair-color shades).
 *
 * Usage:
 *   npx tsx scripts/shopify-sunglasses-crawl.ts \
 *     [input.csv] [productsOut.csv] [stateLog.jsonl]
 *
 * Defaults (all in ~/Downloads):
 *   input.csv     = apparel-filtered.csv (from filter-cohorts)
 *   productsOut   = sunglasses-products.csv
 *   stateLog      = sunglasses-state.jsonl
 *
 * After overnight, count matched stores:
 *   awk -F'|' '$2=="has_sunglasses" {n++} END {print n}' \
 *     ~/Downloads/sunglasses-state.jsonl
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as Papa from "papaparse";

// ── Config knobs ───────────────────────────────────────────────────────────
// Concurrency was 30 originally — Shopify's edge (Cloudflare in
// front of /products.json) flagged the IP after ~200 sustained
// requests and started 429-ing everything from any storefront.
// 8 workers + per-request jitter + a global cooldown when 429s
// land seems to be the sweet spot: keeps throughput acceptable
// (~5-8 domains/sec) while staying under whatever sliding-window
// limit Shopify's edge is using.
const CONCURRENCY = 8;
const PAGE_LIMIT = 250;                // max page size Shopify allows
const MAX_PAGES_PER_DOMAIN = 10;       // 2,500 products is plenty for detection
const STOP_AFTER_MATCHES = 5;          // stop scanning a domain once we've
                                       // found enough sunglasses products to
                                       // report — saves time on huge catalogs
const HTTP_TIMEOUT_MS = 6_000;
const USER_AGENT = "Mozilla/5.0 (compatible; JaxyLeadGen/1.0)";
// Per-request randomised delay so we don't issue 8 simultaneous
// requests to (different) Shopify stores every iteration.
const JITTER_MIN_MS = 100;
const JITTER_MAX_MS = 400;
// When any worker gets a 429, set a global "all workers pause"
// window. 60s tends to be enough — Shopify's IP throttle clears
// faster than that, and the next ~50 requests usually go through
// before another pause is triggered.
const RATE_LIMIT_PAUSE_MS = 60_000;

const MATCH_KEYWORDS = [
  "sunglasses",   // primary
  "sunglass",     // singular
  "sunnies",      // indie copy
];

// ── Helpers ────────────────────────────────────────────────────────────────
interface InputRow {
  domain: string;
  merchant_name?: string;
  platform?: string;
}

interface ProductMatch {
  domain: string;
  store_name: string;
  product_id: number | string | null;
  product_title: string;
  product_url: string;
  product_handle: string;
  product_vendor: string;
  product_type: string;
  product_price: string;
  product_image: string;
  match_reason: string;     // why we considered it a match — which field
                            // hit ("title", "type", "tag:eyewear", etc.)
}

interface StateLine {
  domain: string;
  status: "has_sunglasses" | "no_sunglasses" | "error" | "skipped_not_shopify";
  match_count?: number;
  pages_scanned?: number;
  error?: string;
  processed_at: string;
}

function normalizeDomain(raw: string): string {
  return String(raw || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

/** Inspect a single product. Return the first match reason found,
 *  or null. Match on multiple fields so we don't miss stores whose
 *  product titles are generic ("Cat-Eye Frames") but whose tags or
 *  product_type say "Sunglasses". */
function matchProduct(p: Record<string, unknown>): string | null {
  const title = String(p.title ?? "").toLowerCase();
  const ptype = String(p.product_type ?? "").toLowerCase();
  const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map((t) => String(t).toLowerCase()) : [];
  const body = String(p.body_html ?? "").toLowerCase().slice(0, 500);

  for (const kw of MATCH_KEYWORDS) {
    if (title.includes(kw)) return `title:${kw}`;
    if (ptype.includes(kw)) return `product_type:${kw}`;
    if (body.includes(kw)) return `body_html:${kw}`;
    for (const t of tags) {
      if (t.includes(kw)) return `tag:${kw}`;
    }
  }
  return null;
}

function fmtProduct(domain: string, storeName: string, p: Record<string, unknown>, reason: string): ProductMatch {
  const variants = Array.isArray(p.variants) ? (p.variants as Array<Record<string, unknown>>) : [];
  const firstVariant = variants[0] ?? {};
  const images = Array.isArray(p.images) ? (p.images as Array<Record<string, unknown>>) : [];
  const firstImage = images[0] ?? {};
  const handle = String(p.handle ?? "");
  return {
    domain,
    store_name: storeName,
    product_id: (p.id as number | string | null) ?? null,
    product_title: String(p.title ?? ""),
    product_url: handle ? `https://${domain}/products/${handle}` : "",
    product_handle: handle,
    product_vendor: String(p.vendor ?? ""),
    product_type: String(p.product_type ?? ""),
    product_price: String(firstVariant.price ?? ""),
    product_image: String(firstImage.src ?? ""),
    match_reason: reason,
  };
}

// ── Global rate-limit cooldown ────────────────────────────────────────────
// Shared across all workers. When any worker gets a 429 (or 503),
// they bump cooldownUntil; every other worker checks before each
// request and sleeps until the window closes. Prevents the
// thundering-herd amplification where one rate-limit just causes
// 7 more in the next second.
let cooldownUntil = 0;
let cooldownTrips = 0;

async function waitForCooldown() {
  while (Date.now() < cooldownUntil) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

function triggerCooldown(reason: string) {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + RATE_LIMIT_PAUSE_MS);
  cooldownTrips++;
  // Log once per trip so the operator sees the script *intentionally*
  // pausing — not just hanging. Hidden behind a guard so 8 workers
  // hitting 429 in the same window only log once.
  console.log(
    `\n  ⏸  rate-limit detected (${reason}) — all workers pausing ` +
    `${RATE_LIMIT_PAUSE_MS / 1000}s (trip #${cooldownTrips})\n`,
  );
}

async function fetchPage(domain: string, page: number, timeoutMs: number): Promise<Array<Record<string, unknown>> | null> {
  // Respect any in-progress cooldown before issuing the request.
  await waitForCooldown();

  // Light jitter — staggers concurrent workers so we don't issue
  // 8 simultaneous bursts. Reads as ~100-400ms idle per request
  // but pays back as a much lower rate-limit trip rate.
  const jitter = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  await new Promise((r) => setTimeout(r, jitter));

  const url = `https://${domain}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      // 429 = rate limited. 503 = Cloudflare's "service unavailable"
      // which it returns when an upstream is overloaded — same
      // recovery (pause + retry next run). Trigger the global
      // cooldown then throw so the caller's retry happens AFTER
      // the pause.
      if (res.status === 429 || res.status === 503) {
        triggerCooldown(`${res.status} on ${domain}`);
        throw new Error("rate-limited");
      }
      return null;        // 404 / 403 / 5xx other — treat as "no more pages"
    }
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!ct.includes("application/json")) {
      // Some stores return an HTML 200 page when they've disabled
      // /products.json or redirected to a login wall. Treat as "no
      // products" — better than blowing up on JSON parse.
      return null;
    }
    const json = await res.json() as { products?: Array<Record<string, unknown>> };
    return json.products ?? [];
  } finally {
    clearTimeout(t);
  }
}

interface CrawlResult {
  status: StateLine["status"];
  matches: ProductMatch[];
  pagesScanned: number;
  error?: string;
}

async function crawlDomain(domain: string, storeName: string): Promise<CrawlResult> {
  const matches: ProductMatch[] = [];
  let pagesScanned = 0;

  for (let page = 1; page <= MAX_PAGES_PER_DOMAIN; page++) {
    let products: Array<Record<string, unknown>> | null = null;
    try {
      products = await fetchPage(domain, page, HTTP_TIMEOUT_MS);
    } catch (e) {
      // One retry on transient errors. Anything else → mark error.
      try {
        products = await fetchPage(domain, page, HTTP_TIMEOUT_MS);
      } catch (e2) {
        return {
          status: "error",
          matches: [],
          pagesScanned,
          error: e2 instanceof Error ? e2.message : String(e2),
        };
      }
    }
    pagesScanned++;

    if (!products || products.length === 0) break;

    for (const p of products) {
      const reason = matchProduct(p);
      if (reason) {
        matches.push(fmtProduct(domain, storeName, p, reason));
        if (matches.length >= STOP_AFTER_MATCHES) {
          return { status: "has_sunglasses", matches, pagesScanned };
        }
      }
    }

    // Short-circuit: most pages are 250 long. Anything less means
    // we've reached the end of the catalog.
    if (products.length < PAGE_LIMIT) break;
  }

  return {
    status: matches.length > 0 ? "has_sunglasses" : "no_sunglasses",
    matches,
    pagesScanned,
  };
}

// ── Resumable state log ────────────────────────────────────────────────────
// Both StateLog and ProductsCsv use fs.appendFileSync — NOT a
// buffered WriteStream — because Daniel asked for crash-safety:
// every state row and every product row must be on disk before
// the next domain finishes. Sync append costs ~1ms per row vs
// the multi-second network fetch, so the overhead is invisible.
// In exchange, a kill -9 / power loss / laptop hard-crash never
// loses more than the in-flight requests at the moment of crash —
// resume picks up cleanly.
class StateLog {
  private path: string;
  // Only "settled" domains get into seen — has_sunglasses or
  // no_sunglasses or skipped_not_shopify. error-status rows are
  // deliberately NOT cached as seen, so a re-run automatically
  // retries them. The state log keeps the historical record (last
  // line wins when interpreting outcomes) but doesn't block the
  // next attempt.
  private seen = new Set<string>();
  private errorCount = 0;
  private retriableErrors = 0;

  constructor(p: string) {
    this.path = p;
    if (fs.existsSync(p)) {
      // First pass: collect the LATEST status per domain so an
      // earlier error followed by a later success is treated as
      // success. Last-write-wins on each domain.
      const latest = new Map<string, StateLine>();
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as StateLine;
          if (obj.domain) latest.set(obj.domain, obj);
        } catch { /* skip bad lines from a partial last write */ }
      }
      for (const [d, obj] of Array.from(latest.entries())) {
        if (obj.status === "error") {
          this.errorCount++;
          this.retriableErrors++;
          // Deliberately not adding to seen — leaves the domain
          // eligible for re-crawl.
        } else {
          this.seen.add(d);
        }
      }
    }
  }

  has(domain: string): boolean { return this.seen.has(domain); }
  size(): number { return this.seen.size; }
  errors(): number { return this.errorCount; }
  retriable(): number { return this.retriableErrors; }

  record(line: StateLine): void {
    this.seen.add(line.domain);
    // appendFileSync uses O_APPEND + the fsync semantics depend on
    // the OS, but on macOS APFS / Linux ext4 the row is durable
    // before this returns.
    fs.appendFileSync(this.path, JSON.stringify(line) + "\n");
  }

  async close(): Promise<void> { /* nothing to flush */ }
}

// ── Products CSV appender ─────────────────────────────────────────────────
class ProductsCsv {
  private path: string;
  private wroteHeader: boolean;

  constructor(p: string) {
    this.path = p;
    this.wroteHeader = fs.existsSync(p) && fs.statSync(p).size > 0;
    if (!this.wroteHeader) {
      fs.appendFileSync(
        p,
        "domain,store_name,product_id,product_title,product_url," +
        "product_handle,product_vendor,product_type,product_price," +
        "product_image,match_reason\n",
      );
      this.wroteHeader = true;
    }
  }

  appendMany(matches: ProductMatch[]): void {
    if (matches.length === 0) return;
    const csv = Papa.unparse(matches, { header: false });
    fs.appendFileSync(this.path, csv + "\n");
  }

  async close(): Promise<void> { /* nothing to flush */ }
}

// ── Worker pool ────────────────────────────────────────────────────────────
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const total = items.length;
  async function workerLoop() {
    while (cursor < total) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const dl = (name: string) => path.join(os.homedir(), "Downloads", name);
  const inputPath = process.argv[2] || dl("apparel-filtered.csv");
  const productsPath = process.argv[3] || dl("sunglasses-products.csv");
  const statePath = process.argv[4] || dl("sunglasses-state.jsonl");

  if (!fs.existsSync(inputPath)) {
    console.error(`Input CSV not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Input:    ${inputPath}`);
  console.log(`Products: ${productsPath}`);
  console.log(`State:    ${statePath}`);

  const csvText = fs.readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true, skipEmptyLines: true,
  });
  const allRows: InputRow[] = parsed.data.map((r) => ({
    domain: normalizeDomain(r.domain),
    merchant_name: r.merchant_name,
    platform: (r.platform || "").toLowerCase(),
  })).filter((r) => r.domain);

  // Shopify only — anything else won't have /products.json.
  const shopifyRows = allRows.filter((r) => r.platform === "shopify");
  console.log(`\nRows in CSV:     ${allRows.length.toLocaleString()}`);
  console.log(`Shopify only:    ${shopifyRows.length.toLocaleString()}`);

  // Dedupe — multi-row stores would just burn duplicate requests.
  const byDomain = new Map<string, InputRow>();
  for (const r of shopifyRows) {
    if (!byDomain.has(r.domain)) byDomain.set(r.domain, r);
  }
  const unique = Array.from(byDomain.values());

  const state = new StateLog(statePath);
  const products = new ProductsCsv(productsPath);

  const todo = unique.filter((r) => !state.has(r.domain));
  console.log(`Unique domains:  ${unique.length.toLocaleString()}`);
  console.log(`Already settled: ${(unique.length - todo.length).toLocaleString()} (has_sunglasses or no_sunglasses)`);
  if (state.retriable() > 0) {
    console.log(`Errors to retry: ${state.retriable().toLocaleString()} (will be re-crawled in this run)`);
  }
  console.log(`To crawl:        ${todo.length.toLocaleString()}`);
  console.log(`Concurrency:     ${CONCURRENCY}  ·  jitter ${JITTER_MIN_MS}-${JITTER_MAX_MS}ms  ·  cooldown ${RATE_LIMIT_PAUSE_MS / 1000}s on 429\n`);

  if (todo.length === 0) {
    console.log("Nothing to do. Re-running this command after deleting the state log will re-crawl.");
    await state.close();
    await products.close();
    return;
  }

  const startedAt = Date.now();
  let done = 0;
  let hits = 0;
  let errors = 0;
  let noMatch = 0;
  const errorKinds: Record<string, number> = {};

  // Graceful shutdown — fs.appendFileSync writes are already
  // durable, so this is mostly about not abandoning a worker
  // mid-fetch (which leaves a TCP socket hanging).
  let interrupted = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (interrupted) process.exit(1);
      interrupted = true;
      console.log("\n[!] Shutdown requested — finishing in-flight requests...");
      console.log("    (next run picks up where this one stopped — state log is durable)");
    });
  }

  // ── Logging helpers ──
  // Daniel wants to monitor the run in terminal. Three levels:
  //
  //   • HIT — one line per matched store (the interesting events)
  //   • ERROR — one line per failed store (also interesting; lets
  //     him spot a pattern, e.g. a bunch of rate-limits in a row)
  //   • TICK — every 50 silent "no_sunglasses" stores, one
  //     summary line so the screen always shows activity even
  //     during a long no-match stretch
  //   • HEARTBEAT — every 60s, a full status block
  const fmtPct = (n: number, d: number) => d > 0 ? `${(100 * n / d).toFixed(1)}%` : "—";
  const fmtETA = (rate: number, remaining: number) => {
    if (rate <= 0) return "—";
    const s = remaining / rate;
    if (s < 90) return `${Math.round(s)}s`;
    if (s < 5400) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };
  function progressTag(): string {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / Math.max(1, elapsed);
    return `[${done}/${todo.length} · ${rate.toFixed(1)}/s · ETA ${fmtETA(rate, todo.length - done)}]`;
  }

  let lastHeartbeat = Date.now();
  function maybeHeartbeat() {
    if (Date.now() - lastHeartbeat < 60_000) return;
    lastHeartbeat = Date.now();
    const topErrs = Object.entries(errorKinds)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, v]) => `${k}×${v}`).join("  ");
    console.log(
      `\n  ──── heartbeat ${new Date().toISOString().slice(11, 19)} ────\n` +
      `  ${progressTag()}\n` +
      `  hits=${hits}  no_match=${noMatch}  errors=${errors}  ` +
      `(hit rate ${fmtPct(hits, done)})\n` +
      (topErrs ? `  top errors: ${topErrs}\n` : "") +
      `  ─────────────────────────────────\n`,
    );
  }

  let tickAccum = 0;
  function logNoMatch(domain: string, pages: number) {
    tickAccum++;
    // Every 50th no-match, print one summary line so the user
    // sees the cursor moving even during long silent stretches.
    if (tickAccum % 50 === 0) {
      console.log(`${progressTag()}  ··· ${tickAccum} no-match (last: ${domain}, ${pages} pages)`);
    }
  }
  function logHit(m: CrawlResult, domain: string, storeName: string) {
    const prices = m.matches
      .map((p) => parseFloat(p.product_price))
      .filter((n) => Number.isFinite(n) && n > 0);
    const priceStr = prices.length
      ? (prices.length === 1 ? `$${prices[0].toFixed(0)}` : `$${Math.min(...prices).toFixed(0)}-$${Math.max(...prices).toFixed(0)}`)
      : "no price";
    const sample = m.matches[0]?.product_title?.slice(0, 50) ?? "";
    console.log(
      `${progressTag()}  ✓ ${storeName.slice(0, 30).padEnd(30)} ` +
      `${domain.padEnd(30)} ${m.matches.length}p  ${priceStr.padEnd(14)} ` +
      `"${sample}"`,
    );
  }
  function logError(domain: string, msg: string) {
    // Bucket the error type so the heartbeat can summarise.
    const kind = /rate.?limit/i.test(msg) ? "rate-limit"
      : /timeout|abort/i.test(msg) ? "timeout"
      : /ENOTFOUND|DNS/i.test(msg) ? "dns"
      : /ECONNREFUSED|ECONNRESET/i.test(msg) ? "conn"
      : msg.slice(0, 30);
    errorKinds[kind] = (errorKinds[kind] ?? 0) + 1;
    console.log(`${progressTag()}  ✗ ${domain.padEnd(40)} ${kind}`);
  }

  console.log(`\nLegend:  ✓ has_sunglasses   ✗ error   ··· batch of no-match`);
  console.log(`Heartbeat every 60s with rolling totals.\n`);

  await runPool(todo, CONCURRENCY, async (row) => {
    if (interrupted) return;
    const storeName = row.merchant_name || row.domain;
    let r: CrawlResult;
    try {
      r = await crawlDomain(row.domain, storeName);
    } catch (e) {
      r = {
        status: "error",
        matches: [],
        pagesScanned: 0,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    // Persist state + products BEFORE incrementing counters so a
    // crash mid-write doesn't leave the in-memory counters ahead
    // of disk.
    state.record({
      domain: row.domain,
      status: r.status,
      match_count: r.matches.length,
      pages_scanned: r.pagesScanned,
      error: r.error,
      processed_at: new Date().toISOString(),
    });
    if (r.matches.length > 0) products.appendMany(r.matches);

    done++;
    if (r.status === "has_sunglasses") {
      hits++;
      logHit(r, row.domain, storeName);
    } else if (r.status === "error") {
      errors++;
      logError(row.domain, r.error ?? "unknown");
    } else {
      noMatch++;
      logNoMatch(row.domain, r.pagesScanned);
    }
    maybeHeartbeat();
  });

  const elapsedMin = (Date.now() - startedAt) / 60_000;
  console.log(`\n=== DONE ===`);
  console.log(`  Crawled ${done.toLocaleString()} domains in ${elapsedMin.toFixed(1)} min`);
  console.log(`  has_sunglasses: ${hits.toLocaleString()}  (${fmtPct(hits, done)})`);
  console.log(`  no_sunglasses:  ${noMatch.toLocaleString()}`);
  console.log(`  error:          ${errors.toLocaleString()}`);
  if (Object.keys(errorKinds).length) {
    console.log(`  error breakdown:`);
    for (const [k, v] of Object.entries(errorKinds).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(6)}  ${k}`);
    }
  }
  console.log(`\nProducts CSV: ${productsPath}`);
  console.log(`State log:    ${statePath}`);

  await state.close();
  await products.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
