/**
 * Mac-mini classifier worker.
 *
 * Runs in a loop:
 *   1. Pull a batch (50) of unclassified prospects from Railway
 *   2. For each, enrich (homepage scrape OR Brave Search), unless we
 *      have a fresh cached enrichment_text already
 *   3. Send the batch (broken into smaller LLM calls) to Ollama for
 *      classification
 *   4. POST the results back to Railway
 *   5. Sleep briefly, repeat. Sleep longer when queue is empty.
 *
 * Stateless — restart anytime. Crash mid-batch just re-pulls the same
 * cursor and retries. Idempotent thanks to (a) the audit table being
 * append-only and (b) industry-overwrite on each pass being deterministic.
 *
 * Run on a Mac mini behind any normal home/office network. Only needs
 * outbound HTTPS. See docs/MAC_MINI_SETUP.md for setup.
 *
 * Environment (all required unless noted):
 *   THE_FRAME_URL          https://theframe.getjaxy.com
 *   CLASSIFIER_TOKEN       shared secret, also set on Railway
 *   OLLAMA_URL             http://localhost:11434  (default)
 *   OLLAMA_MODEL           qwen2.5:7b-instruct-q4_K_M  (default)
 *   BRAVE_SEARCH_API_KEY   for the no-website fallback
 *   BATCH_SIZE             default 50 (rows pulled per loop)
 *   LLM_CHUNK_SIZE         default 10 (rows per LLM call inside a batch)
 *   SLEEP_BETWEEN_BATCHES  default 1000ms
 *   SLEEP_WHEN_EMPTY       default 3600000ms (1 hour)
 *
 * CLI flags:
 *   --dry-run        Don't post results back, just print them
 *   --once           Process one batch then exit (debug mode)
 *   --limit=N        Override BATCH_SIZE
 *   --include-stale  Pass include_stale_enrichment=true (refresh mode)
 */

import {
  enrichProspect,
  type EnrichmentResult,
} from "@/modules/sales/lib/prospect-enrichment";
import {
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildUserPrompt,
  toLlmInput,
  isKnownIndustry,
  type LlmBatchOutput,
  type LlmInputRow,
  type CompanyForClassification,
} from "@/modules/sales/lib/llm-prompt";

// ── Config ─────────────────────────────────────────────────────────────

const THE_FRAME_URL = requireEnv("THE_FRAME_URL");
const CLASSIFIER_TOKEN = requireEnv("CLASSIFIER_TOKEN");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct-q4_K_M";
const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY ?? null;

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? "50");
const LLM_CHUNK_SIZE = parseInt(process.env.LLM_CHUNK_SIZE ?? "10");
const SLEEP_BETWEEN_BATCHES = parseInt(process.env.SLEEP_BETWEEN_BATCHES ?? "1000");
const SLEEP_WHEN_EMPTY = parseInt(process.env.SLEEP_WHEN_EMPTY ?? "3600000");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONCE = args.includes("--once");
const INCLUDE_STALE = args.includes("--include-stale");
const limitArg = args.find((a) => a.startsWith("--limit="))?.slice("--limit=".length);
const LIMIT_OVERRIDE = limitArg ? parseInt(limitArg) : null;

const STALE_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days

// ── Types matching the unclassified endpoint's response shape ────────

interface UnclassifiedRow extends CompanyForClassification {
  enrichment_text: string | null;
  enrichment_source: string | null;
  enrichment_fetched_at: string | null;
}

interface UnclassifiedResponse {
  batch: UnclassifiedRow[];
  next_cursor: string | null;
  remaining: number;
}

interface ContactsPayload {
  emails: string[];
  phones: string[];
  contact_form_url: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
}

interface BatchPayloadItem {
  llm: {
    id: string;
    industry: string;
    is_chain: boolean;
    confidence: number;
    reasoning: string;
    flags?: string[];
  };
  enrichment_text: string | null;
  enrichment_source: "homepage" | "brave" | "none";
  contacts: ContactsPayload;
}

// ── Main loop ─────────────────────────────────────────────────────────

async function main() {
  log(`Worker starting`, {
    THE_FRAME_URL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    BATCH_SIZE: LIMIT_OVERRIDE ?? BATCH_SIZE,
    LLM_CHUNK_SIZE,
    DRY_RUN,
    ONCE,
    INCLUDE_STALE,
    BRAVE_KEY_set: !!BRAVE_KEY,
  });

  // Sanity check Ollama is reachable + model is pulled before we start
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const tags = (await r.json()) as { models: Array<{ name: string }> };
    const have = tags.models.map((m) => m.name);
    if (!have.some((n) => n.startsWith(OLLAMA_MODEL.split(":")[0]))) {
      log(`⚠ Model "${OLLAMA_MODEL}" not pulled. Run: ollama pull ${OLLAMA_MODEL}`);
      process.exit(2);
    }
    log(`✓ Ollama healthy, model present`);
  } catch (e) {
    log(`✗ Ollama unreachable at ${OLLAMA_URL}: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  let cursor: string | null = null;
  let processed = 0;
  const t0 = Date.now();

  while (true) {
    const { batch, next_cursor, remaining } = await fetchUnclassified(cursor);

    if (batch.length === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      log(`Queue empty. Processed ${processed} rows in ${elapsed}s.`);
      if (ONCE) break;
      log(`Sleeping ${(SLEEP_WHEN_EMPTY / 60_000).toFixed(0)}m before checking again...`);
      cursor = null;
      await sleep(SLEEP_WHEN_EMPTY);
      continue;
    }

    log(`Got batch of ${batch.length}, ${remaining} rows remain in queue`);

    // 1. Enrich (parallel, up to 5 concurrent fetches)
    const enriched = await enrichBatch(batch);

    // 2. Classify in LLM chunks
    const results: BatchPayloadItem[] = [];
    for (let i = 0; i < enriched.length; i += LLM_CHUNK_SIZE) {
      const chunk = enriched.slice(i, i + LLM_CHUNK_SIZE);
      try {
        const classifications = await classifyChunk(chunk);
        for (const c of classifications) results.push(c);
      } catch (e) {
        log(`  ✗ LLM chunk ${i / LLM_CHUNK_SIZE + 1} failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    log(`  Classified ${results.length}/${batch.length} successfully`);

    // 3. Post back
    if (DRY_RUN) {
      log(`  (dry run — would post ${results.length} results)`);
      for (const r of results.slice(0, 3)) {
        log(`    ${r.llm.id.slice(0, 8)} → ${r.llm.industry} (conf=${r.llm.confidence.toFixed(2)})`);
      }
    } else if (results.length > 0) {
      const ack = await postResults(results);
      log(`  ↑ accepted=${ack.accepted} approved=${ack.approved} rejected=${ack.rejected} needs_human=${ack.needs_human}`);
      if (ack.failed && ack.failed.length > 0) {
        log(`  ↑ ${ack.failed.length} failed: ${JSON.stringify(ack.failed.slice(0, 3))}`);
      }
    }

    processed += batch.length;
    cursor = next_cursor;

    if (ONCE) {
      log(`--once flag set, exiting after 1 batch`);
      break;
    }

    if (!next_cursor) {
      cursor = null;  // restart from beginning next pass
    }

    await sleep(SLEEP_BETWEEN_BATCHES);
  }
}

// ── Step 1: fetch unclassified batch from the-frame ──────────────────

async function fetchUnclassified(cursor: string | null): Promise<UnclassifiedResponse> {
  const params = new URLSearchParams();
  params.set("limit", String(LIMIT_OVERRIDE ?? BATCH_SIZE));
  if (cursor) params.set("cursor", cursor);
  if (INCLUDE_STALE) params.set("include_stale_enrichment", "true");

  const url = `${THE_FRAME_URL}/api/v1/sales/prospects/unclassified?${params.toString()}`;
  const res = await fetch(url, { headers: { "X-Classifier-Token": CLASSIFIER_TOKEN } });
  if (!res.ok) throw new Error(`fetchUnclassified HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<UnclassifiedResponse>;
}

// ── Step 2: enrich each row (homepage scrape or Brave Search) ─────────

interface EnrichedRow {
  row: UnclassifiedRow;
  enrichment: EnrichmentResult;
}

async function enrichBatch(batch: UnclassifiedRow[]): Promise<EnrichedRow[]> {
  const out: EnrichedRow[] = [];
  const POOL = 5;

  let idx = 0;
  async function worker() {
    while (idx < batch.length) {
      const i = idx++;
      const row = batch[i];

      // Use cached enrichment when fresh
      if (row.enrichment_text && row.enrichment_fetched_at) {
        const age = Date.now() - new Date(row.enrichment_fetched_at).getTime();
        if (age < STALE_THRESHOLD_MS) {
          out[i] = {
            row,
            enrichment: {
              text: row.enrichment_text,
              source: (row.enrichment_source as "homepage" | "brave" | "none") ?? "none",
              contacts: { emails: [], phones: [], contact_form_url: null, instagram_url: null, facebook_url: null },
            },
          };
          continue;
        }
      }

      const enrichment = await enrichProspect({
        name: row.name,
        website: row.website,
        city: row.city,
        state: row.state,
        braveApiKey: BRAVE_KEY,
      });
      out[i] = { row, enrichment };
    }
  }

  await Promise.all(Array.from({ length: POOL }, () => worker()));
  return out;
}

// ── Step 3: classify a chunk via Ollama ───────────────────────────────

async function classifyChunk(chunk: EnrichedRow[]): Promise<BatchPayloadItem[]> {
  const inputs: LlmInputRow[] = chunk.map(({ row, enrichment }) =>
    toLlmInput(row, enrichment.text || null),
  );

  const body = {
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(inputs) },
    ],
    stream: false,
    format: "json",
    options: { temperature: 0.1 },
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { message?: { content?: string } };
  const content = json.message?.content ?? "";
  let parsed: LlmBatchOutput;
  try {
    parsed = JSON.parse(content) as LlmBatchOutput;
  } catch (e) {
    throw new Error(`LLM response not valid JSON: ${content.slice(0, 200)}`);
  }

  const classifications = parsed.classifications ?? [];
  const byId = new Map(classifications.map((c) => [c.id, c]));

  const out: BatchPayloadItem[] = [];
  for (const { row, enrichment } of chunk) {
    const llm = byId.get(row.id);
    if (!llm) continue;  // skipped by LLM
    if (!isKnownIndustry(llm.industry)) continue;

    out.push({
      llm: {
        id: llm.id,
        industry: llm.industry,
        is_chain: !!llm.is_chain,
        confidence: clamp01(llm.confidence ?? 0),
        reasoning: llm.reasoning ?? "",
        flags: llm.flags ?? [],
      },
      enrichment_text: enrichment.text || null,
      enrichment_source: enrichment.source,
      contacts: enrichment.contacts,
    });
  }
  return out;
}

// ── Step 4: post results back ─────────────────────────────────────────

interface BatchAck {
  accepted: number;
  approved: number;
  rejected: number;
  needs_human: number;
  failed?: Array<{ id: string; error: string }>;
}

async function postResults(results: BatchPayloadItem[]): Promise<BatchAck> {
  const url = `${THE_FRAME_URL}/api/v1/sales/prospects/llm-classify-batch`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Classifier-Token": CLASSIFIER_TOKEN,
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt_version: PROMPT_VERSION,
      results,
    }),
  });
  if (!res.ok) throw new Error(`postResults HTTP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<BatchAck>;
}

// ── Helpers ────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}
function log(msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  if (extra !== undefined) console.log(`[${ts}] ${msg}`, extra);
  else console.log(`[${ts}] ${msg}`);
}

main().catch((e) => {
  log(`✗ Worker crashed: ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
