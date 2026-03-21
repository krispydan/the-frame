/**
 * Chat Commands — Sales Module
 * Pattern-matched natural language commands for the sales module.
 * Phase 1: Simple regex matching. Phase 10: LLM-powered.
 */
import { sqlite } from "@/lib/db";

export interface ChatCommand {
  name: string;
  patterns: RegExp[];
  description: string;
  handler: (match: RegExpMatchArray) => Promise<ChatResponse>;
}

export interface ChatResponse {
  type: "text" | "table" | "count" | "action" | "error";
  message: string;
  data?: Record<string, unknown>[] | Record<string, unknown>;
}

const commands: ChatCommand[] = [
  {
    name: "prospects_by_state",
    patterns: [
      /show\s+prospects?\s+in\s+(\w[\w\s]*)/i,
      /prospects?\s+in\s+(\w{2})\b/i,
      /list\s+(\w{2})\s+prospects?/i,
    ],
    description: "Show prospects in a specific state",
    handler: async (match) => {
      const state = match[1].trim().toUpperCase().slice(0, 2);
      const result = sqlite
        .prepare("SELECT COUNT(*) as count FROM companies WHERE UPPER(state) = ?")
        .get(state) as { count: number };
      return {
        type: "count",
        message: `Found **${result.count.toLocaleString()}** prospects in ${state}.`,
        data: { state, count: result.count },
      };
    },
  },
  {
    name: "count_by_category",
    patterns: [
      /how\s+many\s+(\w[\w\s]*?)(?:\s+do\s+we\s+have|\s+are\s+there|\?|$)/i,
      /count\s+(\w[\w\s]*)/i,
    ],
    description: "Count prospects by category",
    handler: async (match) => {
      const category = match[1].trim().toLowerCase();
      const result = sqlite
        .prepare("SELECT COUNT(*) as count FROM companies WHERE LOWER(type) LIKE ?")
        .get(`%${category}%`) as { count: number };
      return {
        type: "count",
        message: `Found **${result.count.toLocaleString()}** prospects matching "${category}".`,
        data: { category, count: result.count },
      };
    },
  },
  {
    name: "classify_prospects",
    patterns: [
      /classify\s+prospects?/i,
      /run\s+icp\s+classif/i,
      /score\s+prospects?/i,
    ],
    description: "Trigger ICP classification on unscored prospects",
    handler: async () => {
      const unscored = sqlite
        .prepare("SELECT COUNT(*) as count FROM companies WHERE icp_tier IS NULL OR icp_tier = ''")
        .get() as { count: number };
      return {
        type: "action",
        message: `${unscored.count.toLocaleString()} prospects need ICP classification. Use the "Run ICP Classifier" button on the dashboard to start.`,
        data: { unscored: unscored.count },
      };
    },
  },
  {
    name: "outreach_ready",
    patterns: [
      /show\s+outreach\s+ready/i,
      /outreach\s+ready\s+prospects?/i,
      /who\s+can\s+(?:we|i)\s+(?:contact|email|reach)/i,
    ],
    description: "Show prospects ready for outreach",
    handler: async () => {
      const result = sqlite
        .prepare(
          "SELECT COUNT(*) as count FROM companies WHERE status = 'qualified' AND id IN (SELECT company_id FROM contacts WHERE email IS NOT NULL AND email != '')"
        )
        .get() as { count: number };
      return {
        type: "count",
        message: `**${result.count.toLocaleString()}** prospects are outreach-ready (qualified + have email). Navigate to Prospects and apply the "Outreach Ready" smart list.`,
        data: { count: result.count },
      };
    },
  },
  {
    name: "icp_breakdown",
    patterns: [
      /icp\s+breakdown/i,
      /show\s+icp\s+(?:scores?|tiers?)/i,
      /prospect\s+quality/i,
    ],
    description: "Show ICP tier breakdown",
    handler: async () => {
      const tiers = sqlite
        .prepare(
          "SELECT icp_tier, COUNT(*) as count FROM companies WHERE icp_tier IS NOT NULL AND icp_tier != '' GROUP BY icp_tier ORDER BY icp_tier"
        )
        .all() as { icp_tier: string; count: number }[];
      const lines = tiers.map((t) => `  ${t.icp_tier}: ${t.count.toLocaleString()}`).join("\n");
      return {
        type: "text",
        message: `**ICP Breakdown:**\n${lines || "No prospects classified yet. Run the ICP classifier first."}`,
        data: { tiers },
      };
    },
  },
  {
    name: "total_stats",
    patterns: [
      /(?:total|how\s+many)\s+prospects?/i,
      /prospect\s+(?:count|stats|summary)/i,
      /dashboard\s+stats/i,
    ],
    description: "Show overall prospect stats",
    handler: async () => {
      const total = sqlite.prepare("SELECT COUNT(*) as c FROM companies").get() as { c: number };
      const withEmail = sqlite
        .prepare("SELECT COUNT(DISTINCT company_id) as c FROM contacts WHERE email IS NOT NULL AND email != ''")
        .get() as { c: number };
      const withPhone = sqlite
        .prepare("SELECT COUNT(DISTINCT company_id) as c FROM contacts WHERE phone IS NOT NULL AND phone != ''")
        .get() as { c: number };
      return {
        type: "text",
        message: `**Prospect Stats:**\n  Total: ${total.c.toLocaleString()}\n  With email: ${withEmail.c.toLocaleString()}\n  With phone: ${withPhone.c.toLocaleString()}`,
        data: { total: total.c, withEmail: withEmail.c, withPhone: withPhone.c },
      };
    },
  },
];

/**
 * Process a chat message and return a response if it matches a command.
 */
export async function processChatCommand(message: string): Promise<ChatResponse | null> {
  for (const cmd of commands) {
    for (const pattern of cmd.patterns) {
      const match = message.match(pattern);
      if (match) {
        try {
          return await cmd.handler(match);
        } catch (error) {
          return {
            type: "error",
            message: `Error running "${cmd.name}": ${error instanceof Error ? error.message : "Unknown error"}`,
          };
        }
      }
    }
  }
  return null; // No command matched
}

/**
 * Get all available chat commands (for help display).
 */
export function getAvailableCommands(): { name: string; description: string }[] {
  return commands.map((c) => ({ name: c.name, description: c.description }));
}
