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
const CONCURRENCY = 30;
const PAGE_LIMIT = 250;                // max page size Shopify allows
const MAX_PAGES_PER_DOMAIN = 10;       // 2,500 products is plenty for detection
const STOP_AFTER_MATCHES = 5;          // stop scanning a domain once we've
                                       // found enough sunglasses products to
                                       // report — saves time on huge catalogs
const HTTP_TIMEOUT_MS = 6_000;
const USER_AGENT = "Mozilla/5.0 (compatible; JaxyLeadGen/1.0)";

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

async function fetchPage(domain: string, page: number, timeoutMs: number): Promise<Array<Record<string, unknown>> | null> {
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
      if (res.status === 429) throw new Error("rate-limited");
      return null;        // 404 / 403 / 5xx — treat as "no more pages"
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
class StateLog {
  private path: string;
  private seen = new Set<string>();
  private stream: fs.WriteStream;

  constructor(p: string) {
    this.path = p;
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as StateLine;
          if (obj.domain) this.seen.add(obj.domain);
        } catch { /* skip bad lines */ }
      }
    }
    this.stream = fs.createWriteStream(p, { flags: "a" });
  }

  has(domain: string): boolean { return this.seen.has(domain); }
  size(): number { return this.seen.size; }

  record(line: StateLine): void {
    this.seen.add(line.domain);
    this.stream.write(JSON.stringify(line) + "\n");
  }

  close(): Promise<void> {
    return new Promise((res) => this.stream.end(res));
  }
}

// ── Products CSV appender ─────────────────────────────────────────────────
class ProductsCsv {
  private path: string;
  private stream: fs.WriteStream;
  private wroteHeader: boolean;

  constructor(p: string) {
    this.path = p;
    this.wroteHeader = fs.existsSync(p) && fs.statSync(p).size > 0;
    this.stream = fs.createWriteStream(p, { flags: "a" });
    if (!this.wroteHeader) {
      // Match the ProductMatch field order verbatim
      this.stream.write(
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
    this.stream.write(csv + "\n");
  }

  close(): Promise<void> {
    return new Promise((res) => this.stream.end(res));
  }
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
  console.log(`Already in log:  ${(unique.length - todo.length).toLocaleString()}`);
  console.log(`To crawl:        ${todo.length.toLocaleString()}\n`);

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
  let skippedNotShopify = 0;

  // Graceful shutdown — flush streams so partial progress isn't lost.
  let interrupted = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (interrupted) process.exit(1);
      interrupted = true;
      console.log("\nShutdown requested — finishing in-flight requests, then flushing state...");
    });
  }

  await runPool(todo, CONCURRENCY, async (row) => {
    if (interrupted) return;
    const storeName = row.merchant_name || row.domain;
    try {
      const r = await crawlDomain(row.domain, storeName);
      state.record({
        domain: row.domain,
        status: r.status,
        match_count: r.matches.length,
        pages_scanned: r.pagesScanned,
        error: r.error,
        processed_at: new Date().toISOString(),
      });
      if (r.status === "has_sunglasses") {
        hits++;
        products.appendMany(r.matches);
      } else if (r.status === "error") {
        errors++;
      }
    } catch (e) {
      errors++;
      state.record({
        domain: row.domain,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        processed_at: new Date().toISOString(),
      });
    }
    done++;
    if (done % 100 === 0 || done === todo.length) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = done / elapsed;
      const eta = (todo.length - done) / rate;
      process.stdout.write(
        `\r  ${done}/${todo.length}  hits=${hits}  errors=${errors}  ` +
        `${rate.toFixed(1)}/s  ETA ${(eta / 60).toFixed(0)}m   `,
      );
    }
  });

  process.stdout.write("\n\n");
  console.log(`Done. Crawled ${done} domains in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min.`);
  console.log(`  has_sunglasses: ${hits}`);
  console.log(`  no_sunglasses:  ${done - hits - errors - skippedNotShopify}`);
  console.log(`  error:          ${errors}`);
  console.log(`\nProducts CSV: ${productsPath}`);
  console.log(`State log:    ${statePath}`);

  await state.close();
  await products.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
