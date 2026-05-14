/**
 * Single-row debug helper for the classifier pipeline. Pass either:
 *   --id=<company-id>        pull from the-frame by ID
 *   --name="..." --website="..."   make up a fake row on the spot
 *
 * Runs the FULL flow (enrich → LLM → verdict) but DOES NOT post back.
 * Prints everything so you can sanity-check a single classification.
 *
 * Examples:
 *   npx tsx scripts/classify-test-one.ts --id=abc-123
 *   npx tsx scripts/classify-test-one.ts --name="Sunset Surf Co" --website="sunsetsurf.com" --city="Encinitas" --state="CA"
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
  type CompanyForClassification,
} from "@/modules/sales/lib/llm-prompt";
import { decideVerdict } from "@/modules/sales/lib/llm-verdict";

const THE_FRAME_URL = process.env.THE_FRAME_URL ?? "https://theframe.getjaxy.com";
const CLASSIFIER_TOKEN = process.env.CLASSIFIER_TOKEN ?? "";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5:7b-instruct-q4_K_M";
const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY ?? null;

function getArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(`--${name}=`.length).replace(/^["']|["']$/g, "") : undefined;
}

async function loadFromFrame(id: string): Promise<CompanyForClassification> {
  if (!CLASSIFIER_TOKEN) throw new Error("CLASSIFIER_TOKEN required to load by id");
  const res = await fetch(`${THE_FRAME_URL}/api/v1/sales/prospects/${id}`, {
    headers: { "X-Classifier-Token": CLASSIFIER_TOKEN },
  });
  if (!res.ok) throw new Error(`Lookup HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as Record<string, unknown>;
  return {
    id: String(json.id),
    name: String(json.name),
    city: (json.city as string | null) ?? null,
    state: (json.state as string | null) ?? null,
    country: (json.country as string | null) ?? "US",
    website: (json.website as string | null) ?? null,
    tags: Array.isArray(json.tags) ? (json.tags as string[]) : [],
    category: (json.category as string | null) ?? null,
    google_rating: (json.googleRating as number | null) ?? null,
    google_review_count: (json.googleReviewCount as number | null) ?? null,
    instagram_url: (json.instagramUrl as string | null) ?? null,
    facebook_url: (json.facebookUrl as string | null) ?? null,
    industry: (json.industry as string | null) ?? null,
  };
}

function makeFake(): CompanyForClassification {
  return {
    id: "test-row-1",
    name: getArg("name") ?? "Sunset Surf Co",
    city: getArg("city") ?? null,
    state: getArg("state") ?? null,
    country: getArg("country") ?? "US",
    website: getArg("website") ?? null,
    tags: getArg("tags")?.split(",").map((t) => t.trim()) ?? [],
    category: getArg("category") ?? null,
    google_rating: parseFloat(getArg("rating") ?? "0") || null,
    google_review_count: parseInt(getArg("reviews") ?? "0") || null,
    instagram_url: getArg("instagram") ?? null,
    facebook_url: getArg("facebook") ?? null,
    industry: null,
  };
}

async function callOllama(input: CompanyForClassification, enrichment: EnrichmentResult) {
  const llmInput = toLlmInput(input, enrichment.text || null);
  const body = {
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt([llmInput]) },
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
  const parsed = JSON.parse(content) as LlmBatchOutput;
  return parsed.classifications[0];
}

async function main() {
  const id = getArg("id");
  const company = id ? await loadFromFrame(id) : makeFake();

  console.log("════════════════════════════════════════════════════════");
  console.log(`INPUT: ${company.name}`);
  console.log("════════════════════════════════════════════════════════");
  console.log(JSON.stringify(company, null, 2));

  console.log("\n→ Enriching...");
  const enrichment = await enrichProspect({
    name: company.name,
    website: company.website,
    city: company.city,
    state: company.state,
    braveApiKey: BRAVE_KEY,
  });
  console.log(`  source: ${enrichment.source}`);
  console.log(`  text:   ${enrichment.text.slice(0, 200)}${enrichment.text.length > 200 ? "..." : ""}`);
  console.log(`  contacts: ${JSON.stringify(enrichment.contacts, null, 2)}`);

  console.log("\n→ Calling Ollama...");
  const t0 = Date.now();
  const llm = await callOllama(company, enrichment);
  const dt = Date.now() - t0;
  console.log(`  (${dt}ms)`);
  console.log(JSON.stringify(llm, null, 2));

  if (!isKnownIndustry(llm.industry)) {
    console.log(`\n✗ LLM returned unknown industry: ${llm.industry}`);
    process.exit(1);
  }

  const decision = decideVerdict({ llm, country: company.country });
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`VERDICT: ${decision.verdict.toUpperCase()}`);
  console.log("════════════════════════════════════════════════════════");
  console.log(`  status:  ${decision.status}`);
  console.log(`  reason:  ${decision.reason}`);
  console.log(`  prompt:  ${PROMPT_VERSION}`);
  console.log(`  model:   ${OLLAMA_MODEL}`);
  console.log("\n(Dry run only — no DB writes. Use scripts/classify-worker.ts for the real run.)");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.stack : e}`);
  process.exit(1);
});
