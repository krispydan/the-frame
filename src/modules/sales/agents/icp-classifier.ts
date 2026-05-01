/**
 * ICP Classifier Agent — Rule-based classification of companies into ICP tiers.
 * Fast, deterministic, no LLM calls. Can classify 1000s of companies per second.
 */
import { sqlite } from "@/lib/db";
import { agentOrchestrator, type AgentInput, type AgentOutput, type AgentConfig } from "@/modules/core/lib/agent-orchestrator";

// ── Classification Rules ──

interface ClassificationResult {
  tier: "A" | "B" | "C" | "D" | "F";
  score: number;
  reasoning: string;
}

// Keywords for each tier (lowercase)
const TIER_A_KEYWORDS = [
  "boutique", "gift shop", "optical", "optician", "eyewear", "sunglass",
  "resort shop", "resort wear", "surf shop", "beach shop", "resort",
  "fashion boutique", "jewelry", "accessories", "luxury", "designer",
];

const TIER_B_KEYWORDS = [
  "specialty", "bookstore", "book shop", "museum shop", "pharmacy",
  "gift", "novelty", "souvenir", "toy store", "pet boutique",
  "spa", "salon", "wellness", "yoga", "fitness",
  "wine shop", "gourmet", "art gallery", "craft",
];

const TIER_C_KEYWORDS = [
  "retail", "general store", "department", "variety", "discount",
  "clothing", "apparel", "shoe store", "sports",
];

const TIER_D_KEYWORDS = [
  "convenience", "gas station", "liquor", "smoke shop", "vape",
  "pawn", "thrift", "dollar", "check cashing",
];

const TIER_F_KEYWORDS = [
  "auto parts", "auto repair", "laundromat", "laundry", "dry clean",
  "plumbing", "electric", "hvac", "roofing", "landscap",
  "dentist", "doctor", "medical", "veterinar", "funeral",
  "storage", "moving", "towing", "locksmith",
];

function classifyCompany(company: {
  name: string;
  tags: string | null;
  source: string | null;
  type: string | null;
  state: string | null;
  email: string | null;
  phone: string | null;
  google_rating: number | null;
  google_review_count: number | null;
}): ClassificationResult {
  const searchText = [
    company.name,
    company.tags,
    company.source,
    company.type,
  ].filter(Boolean).join(" ").toLowerCase();

  let score = 50; // Start neutral
  const reasons: string[] = [];

  // Check tier keywords (most specific first)
  const tierAMatch = TIER_A_KEYWORDS.filter(k => searchText.includes(k));
  const tierBMatch = TIER_B_KEYWORDS.filter(k => searchText.includes(k));
  const tierCMatch = TIER_C_KEYWORDS.filter(k => searchText.includes(k));
  const tierDMatch = TIER_D_KEYWORDS.filter(k => searchText.includes(k));
  const tierFMatch = TIER_F_KEYWORDS.filter(k => searchText.includes(k));

  if (tierAMatch.length > 0) {
    score += 30 + (tierAMatch.length * 5);
    reasons.push(`Matches A-tier keywords: ${tierAMatch.slice(0, 3).join(", ")}`);
  }
  if (tierBMatch.length > 0) {
    score += 15 + (tierBMatch.length * 3);
    reasons.push(`Matches B-tier keywords: ${tierBMatch.slice(0, 3).join(", ")}`);
  }
  if (tierCMatch.length > 0 && tierAMatch.length === 0 && tierBMatch.length === 0) {
    // Only neutral if no higher matches
    reasons.push(`General retail: ${tierCMatch.slice(0, 2).join(", ")}`);
  }
  if (tierDMatch.length > 0) {
    score -= 20;
    reasons.push(`Low-fit category: ${tierDMatch.slice(0, 2).join(", ")}`);
  }
  if (tierFMatch.length > 0) {
    score -= 40;
    reasons.push(`Irrelevant category: ${tierFMatch.slice(0, 2).join(", ")}`);
  }

  // Bonus: has contact info
  if (company.email) { score += 5; reasons.push("Has email"); }
  if (company.phone) { score += 3; }

  // Bonus: Google rating
  if (company.google_rating && company.google_rating >= 4.0) {
    score += 5;
    reasons.push(`Good rating: ${company.google_rating}★`);
  }
  if (company.google_review_count && company.google_review_count >= 50) {
    score += 3;
    reasons.push(`${company.google_review_count} reviews`);
  }

  // Type bonus
  if (company.type === "boutique") { score += 10; }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Determine tier from score
  let tier: ClassificationResult["tier"];
  if (score >= 80) tier = "A";
  else if (score >= 60) tier = "B";
  else if (score >= 40) tier = "C";
  else if (score >= 20) tier = "D";
  else tier = "F";

  return {
    tier,
    score,
    reasoning: reasons.join(". ") || "Default classification based on available data",
  };
}

// ── Agent Handler ──

async function icpClassifierHandler(input: AgentInput): Promise<AgentOutput> {
  const companyIds = input.companyIds as string[] | undefined;

  if (!companyIds || companyIds.length === 0) {
    return { success: false, error: "companyIds array required" };
  }

  const updateStmt = sqlite.prepare(`
    UPDATE companies SET icp_score = ?, icp_tier = ?, icp_reasoning = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const results: { id: string; tier: string; score: number }[] = [];
  let processed = 0;

  // Process in batches of 500 for efficiency
  const batchSize = 500;
  for (let i = 0; i < companyIds.length; i += batchSize) {
    const batch = companyIds.slice(i, i + batchSize);
    const placeholders = batch.map(() => "?").join(",");

    // Skip rows with icp_manual_override = 1 — the reviewer's tier/score
    // sticks until they explicitly hit "Reclassify".
    const companies = sqlite.prepare(`
      SELECT id, name, tags, source, type, state, email, phone, google_rating, google_review_count
      FROM companies
      WHERE id IN (${placeholders})
        AND COALESCE(icp_manual_override, 0) = 0
    `).all(...batch) as Array<{
      id: string; name: string; tags: string | null; source: string | null;
      type: string | null; state: string | null; email: string | null; phone: string | null;
      google_rating: number | null; google_review_count: number | null;
    }>;

    const transaction = sqlite.transaction(() => {
      for (const company of companies) {
        const result = classifyCompany(company);
        updateStmt.run(result.score, result.tier, result.reasoning, company.id);
        results.push({ id: company.id, tier: result.tier, score: result.score });
        processed++;
      }
    });
    transaction();
  }

  return {
    success: true,
    data: {
      processed,
      results: results.slice(0, 100), // Return first 100 for API response
      summary: {
        A: results.filter(r => r.tier === "A").length,
        B: results.filter(r => r.tier === "B").length,
        C: results.filter(r => r.tier === "C").length,
        D: results.filter(r => r.tier === "D").length,
        F: results.filter(r => r.tier === "F").length,
      },
    },
  };
}

// ── Register with orchestrator ──

export function registerIcpClassifier() {
  agentOrchestrator.registerAgent(
    "icp-classifier",
    "sales",
    icpClassifierHandler,
    {
      mode: "rules",
      timeoutMs: 60000, // 60s for large batches
    }
  );
}

// ── Convenience: classify all unscored companies ──

export function getUnscoredCompanyIds(): string[] {
  const rows = sqlite.prepare(
    "SELECT id FROM companies WHERE icp_score IS NULL LIMIT 50000"
  ).all() as { id: string }[];
  return rows.map(r => r.id);
}

// Auto-register on import
registerIcpClassifier();
