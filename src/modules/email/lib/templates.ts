/**
 * Saved messages ("macros") — reusable subject + body a rep drops into the
 * composer.
 *
 * Two decisions worth knowing:
 *
 *  1. ONE MERGE-FIELD VOCABULARY. Templates render through the sequence
 *     engine's `renderTemplate` (src/modules/sequences/lib/render.ts), so
 *     `{first_name}` means the same thing in a saved message as it does in an
 *     automated sequence. New fields get added there once and both surfaces
 *     gain them.
 *  2. TEMPLATES DO NOT FAIL CLOSED. The sequence engine refuses to send a
 *     message with an unresolved token — correct, because nobody is looking.
 *     Here a human IS looking: an unfilled token is left visibly in the body
 *     and reported as `missing` so the composer can highlight it. Blocking the
 *     paste would just make the feature annoying for the (common) case of
 *     composing to an address with no company record yet.
 *
 * Visibility: 'private' (owner only) or 'team' (everyone). Anyone can publish
 * their own template to the team; only the owner or an owner/sales_manager
 * role can edit or archive one. Archive rather than delete — a template that
 * shaped past correspondence stays explicable.
 */

import { randomUUID } from "crypto";
import { sqlite } from "@/lib/db";
import { renderTemplate, lintTemplate } from "@/modules/sequences/lib/render";
import { stripHtml } from "./mime";

export type TemplateVisibility = "private" | "team";

export interface EmailTemplate {
  id: string;
  name: string;
  category: string | null;
  subject: string | null;
  body_html: string | null;
  body_text: string | null;
  owner_id: string;
  owner_name: string | null;
  visibility: TemplateVisibility;
  usage_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateInput {
  name: string;
  category?: string | null;
  subject?: string | null;
  bodyHtml?: string | null;
  visibility?: TemplateVisibility;
}

const MANAGER_ROLES = new Set(["owner", "sales_manager"]);

/** Templates this user may use: their own plus everything shared to the team. */
export function listTemplates(userId: string, opts: { includeArchived?: boolean } = {}): EmailTemplate[] {
  const archived = opts.includeArchived ? "" : "AND archived_at IS NULL";
  return sqlite
    .prepare(
      `SELECT * FROM email_templates
        WHERE (owner_id = ? OR visibility = 'team') ${archived}
        ORDER BY usage_count DESC, name COLLATE NOCASE ASC`,
    )
    .all(userId) as EmailTemplate[];
}

export function getTemplate(id: string, userId: string): EmailTemplate | null {
  const row = sqlite
    .prepare("SELECT * FROM email_templates WHERE id = ? AND (owner_id = ? OR visibility = 'team')")
    .get(id, userId) as EmailTemplate | undefined;
  return row ?? null;
}

export function canEdit(t: EmailTemplate, userId: string, role: string): boolean {
  return t.owner_id === userId || MANAGER_ROLES.has(role);
}

/**
 * Create or update. `id` present = update (caller must have already checked
 * edit rights via canEdit — this function trusts that decision).
 */
export function saveTemplate(
  input: TemplateInput,
  actor: { id: string; name: string },
  id?: string,
): string {
  const name = input.name.trim();
  const bodyHtml = input.bodyHtml ?? "";
  const bodyText = stripHtml(bodyHtml);
  const visibility: TemplateVisibility = input.visibility === "team" ? "team" : "private";
  const now = new Date().toISOString();

  if (id) {
    sqlite
      .prepare(
        `UPDATE email_templates
            SET name=?, category=?, subject=?, body_html=?, body_text=?, visibility=?, updated_at=?
          WHERE id=?`,
      )
      .run(name, input.category ?? null, input.subject ?? null, bodyHtml, bodyText, visibility, now, id);
    return id;
  }

  const newId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO email_templates
         (id, name, category, subject, body_html, body_text, owner_id, owner_name, visibility, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      newId, name, input.category ?? null, input.subject ?? null, bodyHtml, bodyText,
      actor.id, actor.name || null, visibility, now, now,
    );
  return newId;
}

export function archiveTemplate(id: string): void {
  sqlite
    .prepare("UPDATE email_templates SET archived_at = ?, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), new Date().toISOString(), id);
}

export function restoreTemplate(id: string): void {
  sqlite
    .prepare("UPDATE email_templates SET archived_at = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

/** Ranks the picker — the templates a rep actually reaches for float up. */
export function markUsed(id: string): void {
  sqlite
    .prepare("UPDATE email_templates SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export interface RenderedTemplate {
  subject: string;
  bodyHtml: string;
  /** Tokens we could not resolve — left visible in the body for the human. */
  missing: string[];
  /** House-style lint (em dashes, contractions, missing sign-off). */
  warnings: string[];
}

/**
 * Resolve merge fields against a company. With no companyId the tokens are
 * reported as missing and left in place — the rep sees exactly what needs
 * filling in rather than a body with silent holes.
 */
export function renderForCompany(
  t: EmailTemplate,
  companyId: string | null,
  extra: Record<string, string | null | undefined> = {},
): RenderedTemplate {
  const subject = t.subject ?? "";
  const bodyHtml = t.body_html ?? "";

  if (!companyId) {
    const tokens = new Set<string>();
    for (const src of [subject, bodyHtml]) {
      for (const m of src.matchAll(/\{(\w+)\}/g)) tokens.add(m[1]);
    }
    return {
      subject,
      bodyHtml,
      missing: [...tokens],
      warnings: tokens.size ? ["no store selected, merge fields left unresolved"] : [],
    };
  }

  // renderTemplate is text-oriented but operates purely on {token} substitution
  // and dash normalisation, both of which are safe over an HTML string: it
  // never touches angle brackets or entities.
  const s = renderTemplate(subject, { companyId, extra });
  const b = renderTemplate(bodyHtml, { companyId, extra });

  return {
    subject: s.text,
    bodyHtml: b.text,
    missing: [...new Set([...s.missing, ...b.missing])],
    // Lint the readable text, not the markup — otherwise every <a href> reads
    // as a contraction-free run-on sentence.
    warnings: lintTemplate(stripHtml(b.text)),
  };
}

/** The token palette shown in the template editor, so fields are discoverable. */
export const MERGE_FIELDS: Array<{ token: string; description: string }> = [
  { token: "first_name", description: "Contact first name (falls back to \"there\")" },
  { token: "account_name", description: "Store / company name" },
  { token: "city", description: "Store city" },
  { token: "state", description: "Store state" },
  { token: "store_count", description: "How many locations they have" },
  { token: "last_order_date", description: "Date of their most recent order" },
  { token: "n_months_lapsed", description: "Months since that order" },
  { token: "best_seller", description: "Their most-ordered product" },
  { token: "product_line", description: "Same as best_seller" },
  { token: "date", description: "Today's date" },
  { token: "my_first_name", description: "Your first name" },
  { token: "my_name", description: "Your full name" },
  { token: "my_email", description: "Your email address" },
];
