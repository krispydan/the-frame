/**
 * Generate per-lead AI opening lines for the eyewear cold-email
 * sequence. Uses Anthropic Claude (Sonnet) directly via REST.
 *
 * Writes two distinct openers per lead — one for email 1 (replaces
 * Christina's generic "I came across {{companyName}} while looking
 * for women's boutiques in {{city}}" line) and one for email 2
 * (different observation about the store so the follow-up reads
 * fresh, not copy-pasted).
 *
 * Scope: ONLY the pitchable eyewear cohort —
 *   source_query='eyewear_inventory_v1_2026-06'
 *   eyewear_cohort tag
 *   NOT eyewear_price_too_high (Premium/Luxury disqualified)
 *   ai_opener_email1 IS NULL OR ai_opener_model != current model
 *   has a top_brand (real, non-noise) — otherwise too generic to
 *   personalise
 *
 * Resumable: each successful batch persists immediately via
 * UPDATE. State-log fallback in ~/Downloads/eyewear-opener-state.jsonl
 * records failures for re-attempt.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... npx tsx scripts/generate-eyewear-openers.ts \
 *     [--limit 50] [--batch 10] [--concurrency 5] [--model claude-sonnet-4-20250514]
 *
 * Cost estimate (Claude Sonnet 4): ~$2-3 per 1,000 leads at 10
 * per batch + 1.5K total tokens per call. Full ~10K-lead pitchable
 * cohort: ~$20-30.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { sqlite } from "../src/lib/db";

// ── Config ─────────────────────────────────────────────────────────────────
const DEFAULT_MODEL = "claude-sonnet-4-20250514";
const STATE_LOG = path.join(os.homedir(), "Downloads", "eyewear-opener-state.jsonl");

interface Args {
  limit: number | null;
  batchSize: number;
  concurrency: number;
  model: string;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    limit: null, batchSize: 10, concurrency: 5,
    model: DEFAULT_MODEL, dryRun: false,
  };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--limit") args.limit = parseInt(process.argv[++i] || "0", 10) || null;
    else if (a === "--batch") args.batchSize = parseInt(process.argv[++i] || "10", 10) || 10;
    else if (a === "--concurrency") args.concurrency = parseInt(process.argv[++i] || "5", 10) || 5;
    else if (a === "--model") args.model = process.argv[++i] || DEFAULT_MODEL;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

// ── System prompt (Christina's voice) ──────────────────────────────────────
const SYSTEM_PROMPT = `You write opening lines for cold wholesale emails from Christina at Jaxy Eyewear. She's the Head of Sales — 30 years in eyewear (most recently at AJ Morgan before they closed in December 2025). She's writing peer-to-peer to boutique owners. Her tone is warm, knowledgeable, low-pressure, and specific — never salesy.

For each lead, write TWO openers:

  email1 (first touch): Replaces this generic line:
    "I came across {{companyName}} while looking for women's boutiques in {{city}}."
  Reference something SPECIFIC about the store's current eyewear shelf — the top brand they carry, a product they stock, or the breadth of their assortment. Make it sound like Christina actually clicked through their site.

  email2 (follow-up): A different angle than email 1 — don't rehash the same brand or observation. Could lean on Jaxy's fit ("our polarized line would slot right next to your [other brand] section"), seasonal ("summer rush coming"), or the experience-credibility hook from her AJ Morgan past. Should feel like she's adding new context, not nudging.

Style rules:
- 140-180 characters each
- One sentence, conversational
- Names brands/products in lowercase if the store uses them lowercase on their site, otherwise sentence case
- NEVER use exclamation marks
- NEVER use "I noticed", "I saw", "Hope this finds you well"
- DO use specifics: brand names, product types, price tiers

Jaxy positioning (background she can subtly invoke):
- $150 minimum order — boutique-friendly
- Packs of 4 pairs per SKU — low-risk testing
- Quick shipping
- All lenses polarized or UV400
- $8 wholesale / $28 MSRP — 3.5x markup, $20 unit margin

Examples:

  Bad (email1): "I came across your store while researching sunglasses retailers." (generic)
  Bad (email1): "You sell sunglasses — let's talk!" (too direct)

  Good (email1): "Walked through your Quay selection on the site — looks like you've built a strong polarized program in Brooklyn."
  Good (email2): "Heading into the summer rush — figured I'd send over our $28-retail polarized line in case there's room next to your Le Specs."

Output JSON only, no prose. Schema:
{
  "openers": [
    { "id": "<lead-id>", "email1": "<140-180 char opener for first email>", "email2": "<140-180 char opener for second email>" }
  ]
}`;

// ── Types ──────────────────────────────────────────────────────────────────
interface LeadInput {
  id: string;
  store_name: string;
  city: string | null;
  state: string | null;
  top_brand: string;
  competitor_brands: string[];   // top 3 co-occurring at this store
  price_range: string | null;
  categories: string | null;     // "sunglasses,reading_glasses"
  sample_titles: string[];       // top 3 product titles
}

interface OpenerResult {
  id: string;
  email1: string;
  email2: string;
}

// ── Anthropic call ─────────────────────────────────────────────────────────
async function callAnthropic(
  apiKey: string,
  model: string,
  leads: LeadInput[],
): Promise<OpenerResult[]> {
  const userPrompt = `Generate openers for these ${leads.length} leads:\n\n${JSON.stringify({ leads }, null, 2)}\n\nReturn ONLY the JSON object described in the system prompt.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json() as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text = data.content?.[0]?.text || "";
  if (!text) throw new Error("Empty Anthropic response");

  // Find the JSON object — Claude sometimes wraps in code fences
  // or prefixes with prose despite "no prose" instruction. Extract
  // the first {...} block.
  let jsonText = text.trim();
  const firstBrace = jsonText.indexOf("{");
  const lastBrace = jsonText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }
  let parsed: { openers?: OpenerResult[] };
  try {
    parsed = JSON.parse(jsonText) as { openers?: OpenerResult[] };
  } catch (e) {
    throw new Error(`JSON parse failed: ${e}. First 200 chars: ${text.slice(0, 200)}`);
  }
  const openers = parsed.openers;
  if (!Array.isArray(openers)) {
    throw new Error(`Response missing 'openers' array. Got: ${jsonText.slice(0, 200)}`);
  }
  return openers;
}

// ── Lead selection ─────────────────────────────────────────────────────────
function loadPitchableLeads(model: string, limit: number | null): LeadInput[] {
  const limitClause = limit ? `LIMIT ${limit}` : "";
  const rows = sqlite.prepare(`
    SELECT id, name, city, state, top_brand, eyewear_top_competitors,
           eyewear_price_range, eyewear_categories, eyewear_sample_titles
      FROM companies
     WHERE source_query = 'eyewear_inventory_v1_2026-06'
       AND tags LIKE '%eyewear_cohort%'
       AND (tags NOT LIKE '%eyewear_price_too_high%' OR tags IS NULL)
       AND top_brand IS NOT NULL
       AND TRIM(top_brand) != ''
       AND (ai_opener_email1 IS NULL OR ai_opener_model != ?)
     ORDER BY COALESCE(icp_score, -1) DESC, id
     ${limitClause}
  `).all(model) as Array<{
    id: string; name: string; city: string | null; state: string | null;
    top_brand: string;
    eyewear_top_competitors: string | null;
    eyewear_price_range: string | null;
    eyewear_categories: string | null;
    eyewear_sample_titles: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    store_name: r.name,
    city: r.city,
    state: r.state,
    top_brand: r.top_brand,
    competitor_brands: r.eyewear_top_competitors
      ? r.eyewear_top_competitors.split("|").map((s) => s.trim()).filter(Boolean)
      : [],
    price_range: r.eyewear_price_range,
    categories: r.eyewear_categories,
    sample_titles: r.eyewear_sample_titles
      ? r.eyewear_sample_titles.split("|").map((s) => s.trim()).filter(Boolean)
      : [],
  }));
}

// ── State log ──────────────────────────────────────────────────────────────
function recordState(line: Record<string, unknown>): void {
  fs.appendFileSync(STATE_LOG, JSON.stringify(line) + "\n");
}

// ── Persistence ────────────────────────────────────────────────────────────
const updateOpener = sqlite.prepare(`
  UPDATE companies
     SET ai_opener_email1 = ?,
         ai_opener_email2 = ?,
         ai_opener_generated_at = ?,
         ai_opener_model = ?,
         updated_at = datetime('now')
   WHERE id = ?
`);

function persistBatch(results: OpenerResult[], model: string): number {
  const now = new Date().toISOString();
  let n = 0;
  const txn = sqlite.transaction(() => {
    for (const r of results) {
      if (!r.id || !r.email1 || !r.email2) continue;
      updateOpener.run(r.email1, r.email2, now, model, r.id);
      n++;
    }
  });
  txn();
  return n;
}

// ── Concurrency loop ───────────────────────────────────────────────────────
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function loop() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => loop()));
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey && !args.dryRun) {
    console.error("ANTHROPIC_API_KEY env var required (or pass --dry-run for selection-only preview)");
    process.exit(1);
  }

  console.log(`Eyewear AI opener generator ${args.dryRun ? "(DRY RUN)" : ""}`);
  console.log(`  Model:        ${args.model}`);
  console.log(`  Batch size:   ${args.batchSize}`);
  console.log(`  Concurrency:  ${args.concurrency}`);
  console.log(`  Lead limit:   ${args.limit ?? "all pitchable"}\n`);

  console.log(`Selecting pitchable leads…`);
  const leads = loadPitchableLeads(args.model, args.limit);
  console.log(`  ${leads.length.toLocaleString()} leads pending opener generation`);

  if (leads.length === 0) {
    console.log(`Nothing to do.`);
    return;
  }

  if (args.dryRun) {
    console.log(`\nSample lead inputs (first 3):`);
    for (const l of leads.slice(0, 3)) {
      console.log(`  ${JSON.stringify(l, null, 2)}`);
    }
    return;
  }

  // Chunk into batches
  const batches: LeadInput[][] = [];
  for (let i = 0; i < leads.length; i += args.batchSize) {
    batches.push(leads.slice(i, i + args.batchSize));
  }

  const t0 = Date.now();
  let totalUpdated = 0;
  let totalFailed = 0;
  let batchesDone = 0;

  await runPool(batches, args.concurrency, async (batch, idx) => {
    try {
      const results = await callAnthropic(apiKey!, args.model, batch);
      const updated = persistBatch(results, args.model);
      totalUpdated += updated;
      recordState({
        batch_index: idx, batch_size: batch.length,
        success: true, updated, processed_at: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      totalFailed += batch.length;
      recordState({
        batch_index: idx, batch_size: batch.length,
        success: false, error: msg,
        lead_ids: batch.map((l) => l.id),
        processed_at: new Date().toISOString(),
      });
      console.warn(`  ✗ batch ${idx}: ${msg.slice(0, 100)}`);
    }
    batchesDone++;
    if (batchesDone % 5 === 0 || batchesDone === batches.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = totalUpdated / Math.max(1, elapsed);
      const eta = (leads.length - totalUpdated - totalFailed) / Math.max(0.1, rate);
      process.stdout.write(
        `\r  [${batchesDone}/${batches.length} batches]  ` +
        `updated=${totalUpdated}  failed=${totalFailed}  ` +
        `${rate.toFixed(1)}/s  ETA ${(eta / 60).toFixed(0)}m   `,
      );
    }
  });
  process.stdout.write("\n");

  console.log(`\nDone.`);
  console.log(`  Updated:      ${totalUpdated.toLocaleString()}`);
  console.log(`  Failed:       ${totalFailed.toLocaleString()} (see ${STATE_LOG})`);
  console.log(`  Elapsed:      ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
