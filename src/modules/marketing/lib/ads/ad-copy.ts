/**
 * Ad copy variants — the small shared pool (C01, C02, …) the naming
 * convention encodes. Variants are Meta's three text slots (primary
 * text / headline / description); an ad references one by code so
 * performance in Ads Manager can be sliced by copy.
 *
 * AI generation rides the same stack as video captions: brand voice
 * from the prompt store, forced tool-use JSON via callClaude.
 */
import { sqlite } from "@/lib/db";
import { videoModel } from "../ai-model";
import { getDocContent } from "../prompt-store";
import { callClaude, extractPromptBody } from "../email-ai";

export interface AdCopyInput {
  primaryText: string;
  headline?: string | null;
  description?: string | null;
  notes?: string | null;
}

/** Next free code: max existing C## + 1 (C00 is reserved for "no copy"). */
export function nextCopyCode(): string {
  const max = (sqlite.prepare(
    `SELECT MAX(CAST(SUBSTR(code, 2) AS INTEGER)) n FROM marketing_ad_copy`,
  ).get() as { n: number | null }).n ?? 0;
  return `C${String(max + 1).padStart(2, "0")}`;
}

export function insertCopyVariant(input: AdCopyInput): { code: string } {
  const code = nextCopyCode();
  sqlite.prepare(
    `INSERT INTO marketing_ad_copy (id, code, primary_text, headline, description, notes)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?)`,
  ).run(code, input.primaryText.trim(), input.headline?.trim() || null,
        input.description?.trim() || null, input.notes?.trim() || null);
  return { code };
}

const SUBMIT_TOOL = {
  name: "submit_ad_copy",
  description: "Submit the generated Meta ad copy variants.",
  input_schema: {
    type: "object" as const,
    properties: {
      variants: {
        type: "array",
        items: {
          type: "object",
          properties: {
            primaryText: { type: "string", description: "Meta primary text, ≤125 chars ideal, hook first" },
            headline: { type: "string", description: "Meta headline, ≤40 chars" },
            description: { type: "string", description: "Meta description, ≤30 chars, optional angle" },
            angle: { type: "string", description: "One-word label for the angle (e.g. price, style, protection)" },
          },
          required: ["primaryText", "headline"],
        },
      },
    },
    required: ["variants"],
  },
};

/**
 * Generate `count` distinct copy variants (different angles, not
 * rewordings) and store each under the next codes. Product context is
 * optional — brand-level copy works for any ad.
 */
export async function generateAdCopy(opts: {
  count?: number;
  productName?: string;
  direction?: string;
}): Promise<{ ok: true; created: Array<{ code: string; primaryText: string; headline: string | null }> } | { ok: false; error: string }> {
  const count = Math.min(5, Math.max(1, opts.count ?? 3));
  const systemBase = extractPromptBody(getDocContent("system-prompt-base"))
    .replace(/\{\{?AUDIENCE\}?\}/g, "retail")
    .replace(/\{IF\s+audience[^}]*\}([\s\S]*?)\{(ELSE[^}]*|ENDIF)\}/g, "$1");

  const userPrompt = [
    `Write ${count} DISTINCT Meta (Facebook/Instagram) ad copy variants — each a different angle, not rewordings of one idea.`,
    "Slots per variant: primary text (hook first, ≤125 chars ideal), headline (≤40 chars), description (≤30 chars, optional).",
    opts.productName ? `The ad creative features the product "${opts.productName}" — but the copy should work for the brand's ads generally, so don't hard-code the product name into every slot.` : "",
    opts.direction ? `OPERATOR DIRECTION: ${opts.direction}` : "",
    "No emojis in headlines. No ALL CAPS. No fake urgency (\"last chance\").",
  ].filter(Boolean).join("\n");

  const result = await callClaude({
    systemPrompt: systemBase,
    userPrompt,
    tool: SUBMIT_TOOL,
    maxTokens: 2048,
    model: videoModel(),
  });
  if (!result.ok) return { ok: false, error: result.error };

  const variants = Array.isArray(result.output.variants) ? result.output.variants : [];
  if (!variants.length) return { ok: false, error: "Model returned no variants" };

  const created: Array<{ code: string; primaryText: string; headline: string | null }> = [];
  for (const v of variants.slice(0, count) as Array<Record<string, unknown>>) {
    if (typeof v.primaryText !== "string" || !v.primaryText.trim()) continue;
    const { code } = insertCopyVariant({
      primaryText: v.primaryText,
      headline: typeof v.headline === "string" ? v.headline : null,
      description: typeof v.description === "string" ? v.description : null,
      notes: typeof v.angle === "string" ? `AI · angle: ${v.angle}` : "AI",
    });
    created.push({ code, primaryText: v.primaryText.trim(), headline: typeof v.headline === "string" ? v.headline : null });
  }
  if (!created.length) return { ok: false, error: "Model returned no usable variants" };
  return { ok: true, created };
}
