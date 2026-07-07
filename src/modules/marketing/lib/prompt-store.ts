/**
 * AI document store — makes every prompt + brand-voice doc the email
 * system uses a LIVING, in-app-editable document.
 *
 * Source of truth model:
 *   - The .md files in prompts/ + brand-context/ are the canonical
 *     DEFAULTS (shipped with the deploy, version-controlled).
 *   - The marketing_ai_documents table holds the LIVE edits operators
 *     make in the app. Generation reads the live version.
 *   - "Reset to default" re-reads the current file, so the repo file is
 *     always the baseline you can fall back to.
 *
 * The table is created + seeded lazily on first access (no migration in
 * db.ts needed). Every read falls back to the file if the DB/table/row
 * is unavailable — so dev, tests, and a pre-seed boot all keep working.
 */
import fs from "fs";
import path from "path";
import { sqlite } from "@/lib/db";

const PROMPTS_DIR = path.join(process.cwd(), "src", "modules", "marketing", "prompts");
const BRAND_DIR = path.join(process.cwd(), "src", "modules", "marketing", "brand-context");

export type DocCategory = "prompt" | "brand";

export interface DocMeta {
  slug: string;
  category: DocCategory;
  title: string;
  description: string;
  /** Absolute file path — server-only; never sent to the client. */
  file: string;
}

/**
 * The full set of editable AI documents. Order = display order.
 * Adding a new prompt? Register it here (and reference it via
 * getDocContent in email-ai) — it becomes editable automatically.
 */
export const AI_DOCS: DocMeta[] = [
  { slug: "system-prompt-base", category: "prompt", title: "System prompt (base)", description: "Core instructions + brand framing prepended to every generation.", file: path.join(PROMPTS_DIR, "system-prompt-base.md") },
  { slug: "copy-generation-prompt", category: "prompt", title: "Copy generation", description: "Fills every text field of an email — subject, hero, sections, CTAs.", file: path.join(PROMPTS_DIR, "copy-generation-prompt.md") },
  { slug: "image-prompt-generation", category: "prompt", title: "Image briefs (Higgsfield)", description: "Generates the hero + secondary image briefs for the designer.", file: path.join(PROMPTS_DIR, "image-prompt-generation.md") },
  { slug: "theme-generation-prompt", category: "prompt", title: "Theme generation", description: "Proposes weekly content themes for an audience.", file: path.join(PROMPTS_DIR, "theme-generation-prompt.md") },
  { slug: "month-plan-prompt", category: "prompt", title: "Month planner", description: "Proposes one brief per slot across a planning window.", file: path.join(PROMPTS_DIR, "month-plan-prompt.md") },
  { slug: "video-caption-prompt", category: "prompt", title: "Video captions (Remix Studio)", description: "Caption + hashtags + manual posting checklist for generated TikTok/IG videos.", file: path.join(PROMPTS_DIR, "video-caption-prompt.md") },
  { slug: "brand-bible", category: "brand", title: "Brand bible", description: "The full brand voice + rules (drives retail voice).", file: path.join(BRAND_DIR, "brand-bible.md") },
  { slug: "wholesale-voice", category: "brand", title: "Wholesale voice", description: "Voice + rules for wholesale (Christina) emails.", file: path.join(BRAND_DIR, "wholesale-voice.md") },
  { slug: "visual-guidelines", category: "brand", title: "Visual guidelines", description: "Brand visual system reference.", file: path.join(BRAND_DIR, "visual-guidelines.md") },
  { slug: "photography-aesthetic", category: "brand", title: "Photography aesthetic", description: "Locked into every image brief so renders stay on-brand.", file: path.join(BRAND_DIR, "photography-aesthetic.md") },
];

const BY_SLUG = new Map(AI_DOCS.map((d) => [d.slug, d]));

/** Current on-disk default for a doc (empty string if missing). */
export function fileDefault(slug: string): string {
  const meta = BY_SLUG.get(slug);
  if (!meta) return "";
  try {
    return fs.readFileSync(meta.file, "utf-8");
  } catch {
    return "";
  }
}

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS marketing_ai_documents (
        slug TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        updated_by TEXT
      )
    `);
    const ins = sqlite.prepare(`INSERT OR IGNORE INTO marketing_ai_documents (slug, content) VALUES (?, ?)`);
    for (const d of AI_DOCS) ins.run(d.slug, fileDefault(d.slug));
    seeded = true;
  } catch (e) {
    // DB unavailable (e.g. during a build phase) — callers fall back to
    // file reads, so generation still works.
    console.warn("[prompt-store] seed skipped (will fall back to files):", e instanceof Error ? e.message : e);
  }
}

/**
 * The LIVE content for a doc: the DB edit if present, else the file
 * default. This is what every generator reads — so an in-app edit takes
 * effect on the next generation, no redeploy.
 */
export function getDocContent(slug: string): string {
  ensureSeeded();
  try {
    const row = sqlite.prepare(`SELECT content FROM marketing_ai_documents WHERE slug = ?`).get(slug) as
      | { content?: string }
      | undefined;
    if (row && row.content != null && row.content !== "") return row.content;
  } catch {
    /* table/row missing — fall back to file */
  }
  return fileDefault(slug);
}

export interface DocView {
  slug: string;
  category: DocCategory;
  title: string;
  description: string;
  content: string;
  /** The current on-disk baseline (for "reset to default" + diffing). */
  defaultContent: string;
  isEdited: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

function rowFor(slug: string): { content?: string; updated_at?: string; updated_by?: string } | undefined {
  try {
    return sqlite.prepare(`SELECT content, updated_at, updated_by FROM marketing_ai_documents WHERE slug = ?`).get(slug) as
      | { content?: string; updated_at?: string; updated_by?: string }
      | undefined;
  } catch {
    return undefined;
  }
}

/** Full editor view of one document (null if the slug is unknown). */
export function getDoc(slug: string): DocView | null {
  const meta = BY_SLUG.get(slug);
  if (!meta) return null;
  ensureSeeded();
  const def = fileDefault(slug);
  const row = rowFor(slug);
  const content = row?.content && row.content !== "" ? row.content : def;
  return {
    slug: meta.slug,
    category: meta.category,
    title: meta.title,
    description: meta.description,
    content,
    defaultContent: def,
    isEdited: content !== def,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Metadata + edited-status for every doc (no file paths leaked). */
export function listDocs(): Array<Omit<DocView, "content" | "defaultContent">> {
  ensureSeeded();
  return AI_DOCS.map((meta) => {
    const def = fileDefault(meta.slug);
    const row = rowFor(meta.slug);
    const content = row?.content && row.content !== "" ? row.content : def;
    return {
      slug: meta.slug,
      category: meta.category,
      title: meta.title,
      description: meta.description,
      isEdited: content !== def,
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
    };
  });
}

/** Save an edited document. Returns false for an unknown slug. */
export function updateDoc(slug: string, content: string, updatedBy = "admin"): boolean {
  if (!BY_SLUG.has(slug)) return false;
  ensureSeeded();
  sqlite
    .prepare(
      `INSERT INTO marketing_ai_documents (slug, content, updated_at, updated_by)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(slug) DO UPDATE SET
         content = excluded.content,
         updated_at = datetime('now'),
         updated_by = excluded.updated_by`,
    )
    .run(slug, content, updatedBy);
  return true;
}

/** Reset a document to the current on-disk default. */
export function resetDoc(slug: string): boolean {
  if (!BY_SLUG.has(slug)) return false;
  return updateDoc(slug, fileDefault(slug), "reset-to-default");
}

export function isKnownDoc(slug: string): boolean {
  return BY_SLUG.has(slug);
}
