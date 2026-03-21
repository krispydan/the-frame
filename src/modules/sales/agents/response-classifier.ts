/**
 * F3-008: AI Response Classifier Agent
 * Rule-based classification of email replies for Phase 3.
 */
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

export type ReplyClassification =
  | "interested"
  | "not_interested"
  | "out_of_office"
  | "wrong_person"
  | "question"
  | "auto_reply";

interface ClassificationResult {
  classification: ReplyClassification;
  confidence: number;
  matchedKeywords: string[];
}

const RULES: Array<{ classification: ReplyClassification; keywords: string[]; priority: number }> = [
  {
    classification: "out_of_office",
    keywords: ["out of office", "ooo", "vacation", "on leave", "away from", "auto-reply", "automatic reply", "currently away", "limited access", "returning on"],
    priority: 10, // highest — check first
  },
  {
    classification: "auto_reply",
    keywords: ["auto reply", "automated response", "do not reply", "noreply", "this is an automated", "unmonitored mailbox", "auto-generated"],
    priority: 9,
  },
  {
    classification: "wrong_person",
    keywords: ["wrong person", "no longer", "left the company", "moved on", "try reaching", "not with us", "doesn't work here", "retired"],
    priority: 8,
  },
  {
    classification: "not_interested",
    keywords: ["not interested", "no thank", "no thanks", "remove me", "unsubscribe", "stop emailing", "take me off", "don't contact", "please remove", "not a fit", "we're good", "already have a supplier", "not looking"],
    priority: 7,
  },
  {
    classification: "interested",
    keywords: ["interested", "tell me more", "send info", "send me", "pricing", "catalog", "let's talk", "let's chat", "set up a call", "schedule a call", "love to learn", "sounds great", "sounds interesting", "minimum order", "moq", "wholesale price", "line sheet"],
    priority: 5,
  },
  {
    classification: "question",
    keywords: ["?", "what is", "how does", "can you", "do you", "where are", "when can", "how much"],
    priority: 3,
  },
];

export function classifyReply(text: string): ClassificationResult {
  const lower = text.toLowerCase().trim();

  // Sort by priority descending
  const sorted = [...RULES].sort((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    const matched = rule.keywords.filter((kw) => lower.includes(kw));
    if (matched.length > 0) {
      return {
        classification: rule.classification,
        confidence: Math.min(1, matched.length * 0.3 + 0.4),
        matchedKeywords: matched,
      };
    }
  }

  // Default: question (if short) or interested (if they bothered to reply)
  if (lower.length < 50) {
    return { classification: "question", confidence: 0.3, matchedKeywords: [] };
  }
  return { classification: "question", confidence: 0.2, matchedKeywords: [] };
}

// Deal stage mapping
const STAGE_MAP: Partial<Record<ReplyClassification, string>> = {
  interested: "interested",
  not_interested: "not_interested",
  question: "contact_made",
};

/**
 * Classify a reply and update campaign_lead + deal stage
 */
export function classifyAndUpdate(campaignLeadId: string, replyText: string): ClassificationResult {
  const result = classifyReply(replyText);

  // Update campaign lead
  sqlite.prepare(`
    UPDATE campaign_leads SET reply_classification = ?, reply_text = ? WHERE id = ?
  `).run(result.classification, replyText, campaignLeadId);

  // Update deal stage if applicable
  const newStage = STAGE_MAP[result.classification];
  if (newStage) {
    const lead = sqlite.prepare("SELECT company_id FROM campaign_leads WHERE id = ?").get(campaignLeadId) as { company_id: string } | undefined;
    if (lead) {
      sqlite.prepare(`
        UPDATE deals SET stage = ?, previous_stage = stage, updated_at = datetime('now')
        WHERE company_id = ? AND stage IN ('outreach', 'contact_made')
      `).run(newStage, lead.company_id);
    }
  }

  logger.logEvent("reply_classified", "sales", { campaignLeadId, classification: result.classification, confidence: result.confidence });
  return result;
}

/**
 * Process all unclassified replies (run during sync)
 */
export function classifyAllPendingReplies(): number {
  const pending = sqlite.prepare(`
    SELECT id, reply_text FROM campaign_leads
    WHERE status = 'replied' AND reply_text IS NOT NULL AND reply_classification IS NULL
  `).all() as Array<{ id: string; reply_text: string }>;

  for (const lead of pending) {
    classifyAndUpdate(lead.id, lead.reply_text);
  }
  return pending.length;
}
