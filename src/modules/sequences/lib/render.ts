/**
 * Template rendering + voice lint for outreach sequences.
 *
 * Two rules drive the design:
 *
 *  1. FAIL CLOSED. If a merge field can't be resolved, the message does not
 *     quietly go out with a hole in it — render reports what's missing and the
 *     engine forces the message to review. "Hi {first_name}," with the token
 *     unfilled must be unsendable.
 *  2. HOUSE STYLE IS ENFORCED, NOT DOCUMENTED. Christina's voice has a
 *     consistent shape (no contractions, no em dashes, short, specific
 *     sign-off). Encoding it as a lint means it survives whoever edits the
 *     template next — the same trick that kept em dashes out of the Faire
 *     Market campaign.
 *
 * See docs/outreach-sequence-engine.md §5.
 */

import { sqlite } from "@/lib/db";

export interface RenderContext {
  companyId: string;
  offerCode?: string | null;
  extra?: Record<string, string | null | undefined>;
}

export interface RenderResult {
  text: string;
  missing: string[];      // tokens we could not resolve — forces review
  warnings: string[];     // voice-lint findings
}

/** Strip em/en dashes — house style, and they read as machine-written. */
export const noDash = (s: string): string =>
  s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");

/**
 * Title-case a first name, and drop ones that aren't really names.
 * Ported from the Faire campaign, where the source data had ALL-CAPS names,
 * store acronyms in the name field, and digits.
 */
export function cleanFirstName(raw: string | null | undefined, retailer = ""): string {
  const n = String(raw || "").trim();
  if (!n || n.length > 20) return "";
  if (/\d/.test(n) || !/[aeiou]/i.test(n)) return "";
  const up = n.toUpperCase();
  const retWords = String(retailer || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (n === up && n.length <= 4 && retWords.includes(up)) return "";
  return n.toLowerCase().split(/([ \-'])/)
    .map((p) => (/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join("");
}

/** Everything the templates may reference, resolved from the DB. */
export function buildMergeFields(ctx: RenderContext): Record<string, string> {
  const f: Record<string, string> = {};
  const company = sqlite
    .prepare("SELECT id, name, city, state FROM companies WHERE id = ?")
    .get(ctx.companyId) as { id: string; name: string | null; city: string | null; state: string | null } | undefined;
  if (company) {
    f.account_name = company.name || "";
    f.city = company.city || "";
    f.state = company.state || "";
  }

  // Primary contact first name (contacts is the canonical people store).
  const contact = sqlite
    .prepare(
      `SELECT first_name, last_name FROM contacts WHERE company_id = ?
        ORDER BY is_primary DESC, created_at ASC LIMIT 1`,
    )
    .get(ctx.companyId) as { first_name?: string | null; last_name?: string | null } | undefined;
  // "there" is a deliberate fallback, not a blank. Faire prospects frequently
  // have no contact row, and cleanFirstName also (correctly) rejects store
  // acronyms and junk — without this, "Hi {first_name}," is the common case
  // rather than the rare one, and a literal token is far worse than "Hi there".
  f.first_name = cleanFirstName(contact?.first_name, company?.name || "") || "there";

  // Multi-location shops get a different opener ("Hi Guys!").
  const stores = sqlite
    .prepare("SELECT COUNT(*) n FROM stores WHERE company_id = ?")
    .get(ctx.companyId) as { n: number } | undefined;
  f.store_count = String(stores?.n ?? 0);

  // Order-derived fields.
  const lastOrder = sqlite
    .prepare(
      `SELECT placed_at, total FROM orders
        WHERE company_id = ? AND status NOT IN ('cancelled','returned')
        ORDER BY placed_at DESC LIMIT 1`,
    )
    .get(ctx.companyId) as { placed_at: string | null; total: number | null } | undefined;
  if (lastOrder?.placed_at) {
    f.last_order_date = new Date(lastOrder.placed_at).toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const months = Math.floor((Date.now() - Date.parse(lastOrder.placed_at)) / (30.44 * 86400000));
    f.n_months_lapsed = String(Math.max(0, months));
  }

  // Best seller for this account = most-ordered product across their orders.
  const best = sqlite
    .prepare(
      `SELECT oi.product_name, SUM(oi.quantity) q FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE o.company_id = ? AND oi.product_name IS NOT NULL
        GROUP BY oi.product_name ORDER BY q DESC LIMIT 1`,
    )
    .get(ctx.companyId) as { product_name: string | null } | undefined;
  if (best?.product_name) {
    f.best_seller = best.product_name;
    f.product_line = best.product_name;
  }

  if (ctx.offerCode) f.offer_code = ctx.offerCode;
  f.date = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });
  for (const [k, v] of Object.entries(ctx.extra || {})) if (v) f[k] = String(v);
  return f;
}

/** Replace {tokens}; report any that could not be filled. */
export function renderTemplate(body: string, ctx: RenderContext): RenderResult {
  const fields = buildMergeFields(ctx);
  const missing: string[] = [];
  const text = noDash(
    body.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = fields[key];
      if (v === undefined || v === "") { missing.push(key); return `{${key}}`; }
      return v;
    }),
  );
  return { text, missing, warnings: lintTemplate(text) };
}

/**
 * Christina's house style, as checks. Warnings never block a send on their own
 * (a human may have deliberately written something), but they surface in the
 * builder and the queue so drift is visible.
 */
export function lintTemplate(body: string): string[] {
  const w: string[] = [];
  if (/[—–]/.test(body)) w.push("contains an em/en dash (house style: never)");
  const contractions = body.match(/\b\w+'(s|re|ll|ve|t|d|m)\b/gi);
  if (contractions?.length) w.push(`contractions used (${[...new Set(contractions)].slice(0, 4).join(", ")}) — her voice spells them out`);
  const sentences = body.replace(/\n+/g, " ").split(/[.!?]+\s/).filter((s) => s.trim().length > 12);
  if (sentences.length > 5) w.push(`${sentences.length} sentences — keep to three or four`);
  if (!/thanks again/i.test(body)) w.push('missing the "Thanks again," sign-off');
  if (/\brestock|replenish/i.test(body)) w.push('says restock/replenishment — the word is "fill-in"');
  if (/\{(\w+)\}/.test(body)) w.push("unresolved merge field left in the text");
  return w;
}
