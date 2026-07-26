/**
 * Idea Bank (engine #3, Viral Content Generator + #6 Sales Content).
 *
 * Stocks a shelf of short-form video CONCEPTS so ideation stops being the
 * bottleneck. Every idea is generated against the SAME vitality backbone
 * as the copy engine — the audience profile + content pillars — so each
 * concept is specific to a real person, lands in a deliberate pillar, and
 * ships with a scroll-stopping hook. Optionally scoped to one product
 * (engine #6) for shoppable, education-first concepts.
 *
 * Ideas are lightweight prompts for the team + a seed for a future
 * "make a video from this idea" flow — they don't render anything.
 */
import { sqlite } from "@/lib/db";
import { videoModel } from "../ai-model";
import { getDocContent } from "../prompt-store";
import { callClaude, extractPromptBody } from "../email-ai";
import { videoStrategyBlock } from "./video-ai";

export interface VideoIdea {
  id: string;
  angle: string;
  pillar: string;
  hook: string;
  concept: string;
  productId: string | null;
  productName: string | null;
  status: "new" | "used" | "dismissed";
  createdAt: string;
}

let ensured = false;
function ensureTable(): void {
  if (ensured) return;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS marketing_video_ideas (
      id TEXT PRIMARY KEY,
      angle TEXT NOT NULL,
      pillar TEXT,
      hook TEXT,
      concept TEXT,
      product_id TEXT,
      product_name TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  ensured = true;
}

export function listIdeas(status?: "new" | "used" | "dismissed"): VideoIdea[] {
  ensureTable();
  const rows = (status
    ? sqlite.prepare(`SELECT * FROM marketing_video_ideas WHERE status = ? ORDER BY created_at DESC LIMIT 200`).all(status)
    : sqlite.prepare(`SELECT * FROM marketing_video_ideas ORDER BY created_at DESC LIMIT 200`).all()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    angle: String(r.angle),
    pillar: r.pillar ? String(r.pillar) : "",
    hook: r.hook ? String(r.hook) : "",
    concept: r.concept ? String(r.concept) : "",
    productId: r.product_id ? String(r.product_id) : null,
    productName: r.product_name ? String(r.product_name) : null,
    status: (r.status as VideoIdea["status"]) ?? "new",
    createdAt: String(r.created_at),
  }));
}

export function setIdeaStatus(id: string, status: "new" | "used" | "dismissed"): boolean {
  ensureTable();
  const res = sqlite.prepare(`UPDATE marketing_video_ideas SET status = ? WHERE id = ?`).run(status, id);
  return res.changes > 0;
}

const SUBMIT_TOOL = {
  name: "submit_ideas",
  description: "Submit a batch of short-form video concepts.",
  input_schema: {
    type: "object",
    required: ["ideas"],
    properties: {
      ideas: {
        type: "array",
        items: {
          type: "object",
          required: ["angle", "pillar", "hook", "concept"],
          properties: {
            angle: { type: "string", description: "A short label for the idea (e.g. 'Myth: cheap = junk')." },
            pillar: { type: "string", description: "Which content pillar this sits in (name it from the pillars list)." },
            hook: { type: "string", description: "The scroll-stopping first line, ≤60 chars, written to the audience." },
            concept: { type: "string", description: "2–3 sentences: what happens in the video and why it lands." },
          },
        },
      },
    },
  },
};

interface GenerateOpts {
  count?: number;
  /** Scope every idea to this product (engine #6 — sales/education). */
  product?: { id: string; name: string } | null;
}

/**
 * Generate + persist a batch of ideas. Returns the fresh ideas (or an
 * error string when the AI is unavailable — no fallback, ideas are
 * optional). Uses the vitality backbone as the system context.
 */
export async function generateIdeas(opts: GenerateOpts = {}): Promise<{ ok: true; ideas: VideoIdea[] } | { ok: false; error: string }> {
  ensureTable();
  const count = Math.min(20, Math.max(1, opts.count ?? 10));

  const systemBase = extractPromptBody(getDocContent("system-prompt-base"))
    .replace(/\{\{?AUDIENCE\}?\}/g, "retail")
    .replace(/\{IF\s+audience[^}]*\}([\s\S]*?)\{(ELSE[^}]*|ENDIF)\}/g, "$1");

  const productLine = opts.product
    ? `Scope EVERY idea to this product (education-first, position it as the obvious solution — never a bare ad): ${opts.product.name}.`
    : `Spread the ideas across DIFFERENT pillars so the shelf is varied.`;

  const userPrompt = [
    `Generate ${count} short-form video concepts for Jaxy (TikTok/Instagram).`,
    productLine,
    "",
    "Draw on the strongest short-form angles: mistakes, myths, unpopular opinions, hot takes,",
    "POVs, transformations, hidden tips, and pain points. Every idea must be SPECIFIC to the",
    "audience and built for reach + shares — no generic 'check out our sunglasses'.",
    "",
    "For each: an angle label, the pillar it sits in, a scroll-stopping hook (≤60 chars,",
    "written to the audience), and a 2–3 sentence concept describing the video.",
  ].join("\n");

  const result = await callClaude({
    systemPrompt: systemBase + videoStrategyBlock(),
    userPrompt,
    tool: SUBMIT_TOOL,
    maxTokens: 3072,
    model: videoModel(),
  });
  if (!result.ok) return { ok: false, error: result.error };

  const ideas = (result.output as { ideas?: Array<{ angle?: string; pillar?: string; hook?: string; concept?: string }> }).ideas ?? [];
  const insert = sqlite.prepare(
    `INSERT INTO marketing_video_ideas (id, angle, pillar, hook, concept, product_id, product_name, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
  );
  const ids: string[] = [];
  for (const idea of ideas) {
    if (!idea.angle) continue;
    const id = crypto.randomUUID();
    ids.push(id);
    insert.run(
      id,
      idea.angle,
      idea.pillar ?? null,
      idea.hook ?? null,
      idea.concept ?? null,
      opts.product?.id ?? null,
      opts.product?.name ?? null,
    );
  }
  const fresh = listIdeas("new").filter((i) => ids.includes(i.id));
  return { ok: true, ideas: fresh };
}
