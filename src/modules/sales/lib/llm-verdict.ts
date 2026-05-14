/**
 * Deterministic verdict logic for LLM-classified prospects.
 *
 * Pure TS function so we can tune policy without re-running the LLM. The
 * LLM tells us WHAT something is + flags; this code decides whether
 * Jaxy WANTS them.
 *
 * Returns a verdict (approve/reject/needs_human) plus the suggested
 * `companies.status` to write and a short audit reason.
 */

import { INDUSTRY_DISPLAY, type Industry } from "./industry-mapping";
import type { LlmOutputRow } from "./llm-prompt";

export type Verdict = "approve" | "reject" | "needs_human";
export type ProspectStatus = "new" | "qualified" | "not_qualified";

export interface VerdictDecision {
  verdict: Verdict;
  status: ProspectStatus;
  reason: string;       // short, human-readable; goes into companies.disqualify_reason on reject
}

const HARD_REJECT_FLAGS = new Set([
  "kids_focused",
  "luxury_brand_focused",
  "non_retail_pharmacy",
  "outside_us",
]);

const HUMAN_REVIEW_FLAGS = new Set([
  "small_chain_likely",
  "low_traffic_signal",
  "weak_data",
]);

export interface VerdictInputs {
  llm: LlmOutputRow;
  country?: string | null;     // companies.country
  confidenceFloor?: number;    // default 0.6
}

export function decideVerdict(opts: VerdictInputs): VerdictDecision {
  const { llm, country, confidenceFloor = 0.6 } = opts;
  const flags = llm.flags ?? [];

  // 1. Hard non-US reject (the DB country wins over the LLM flag — LLM may not have seen it)
  if (country && country.trim().toUpperCase() !== "US") {
    return reject(`Non-US country: ${country}`);
  }

  // 2. Out-of-scope industry → reject
  if (llm.industry === "out_of_scope") {
    return reject(`Out of scope: ${llm.reasoning}`);
  }

  // 3. Chain → reject
  if (llm.is_chain) {
    return reject("Chain (>5 locations or known national/regional brand)");
  }

  // 4. Any hard-reject flag → reject
  for (const f of flags) {
    if (HARD_REJECT_FLAGS.has(f)) return reject(`Flagged: ${f}`);
  }

  // 5. Low confidence → human review
  if (llm.confidence < confidenceFloor) {
    return human(`Low confidence (${llm.confidence.toFixed(2)})`);
  }

  // 6. Any human-review flag → human review
  for (const f of flags) {
    if (HUMAN_REVIEW_FLAGS.has(f)) return human(`Needs review: ${f}`);
  }

  // 7. Tier-based routing
  const tier = INDUSTRY_DISPLAY[llm.industry as Industry]?.tier ?? "C";

  if (tier === "A" || tier === "B") {
    return approve(`Tier-${tier} fit (${llm.industry})`);
  }
  if (tier === "D") {
    return human(`D-tier industry (${llm.industry}) — confirm`);
  }
  // Tier C (general retail, unclassified) → human review by default
  return human(`Tier-${tier} (${llm.industry}) — confirm`);
}

function approve(reason: string): VerdictDecision {
  return { verdict: "approve", status: "qualified", reason };
}
function reject(reason: string): VerdictDecision {
  return { verdict: "reject", status: "not_qualified", reason };
}
function human(reason: string): VerdictDecision {
  return { verdict: "needs_human", status: "new", reason };
}
