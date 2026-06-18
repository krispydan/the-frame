export const dynamic = "force-dynamic";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * POST /api/admin/eyewear-seed-smart-lists
 *
 * Idempotent server-side mirror of scripts/seed-eyewear-smart-lists.ts.
 * Insert-or-refresh the 8 canned Smart Lists for the eyewear cohorts
 * so the Prospects UI surfaces them after the import endpoint
 * populates the new rows.
 *
 * Auth: `x-admin-key: jaxy2026`.
 */

interface SmartListDef {
  name: string;
  description: string;
  filters: Record<string, unknown>;
}

// Filters use tag_and (NOT source_query) for cohort discrimination.
// Reason: the importer's selectByDomain match is source-agnostic, so a
// store that already exists in companies as source_type='storeleads'
// (or any other source) gets the eyewear data merged in via COALESCE
// — but the row's source_query stays as the original "storeleads_csv:..."
// label. If we filtered by source_query='eyewear_inventory_v1_2026-06'
// here, those merged rows would silently fall out of every smart list.
// Tag-based filtering catches them — the importer always appends
// `eyewear_cohort` to companies.tags, regardless of which source the row
// originally came from.
const LISTS: SmartListDef[] = [
  {
    name: "🎯 Eyewear — Pitchable (entry+mid, multi-brand)",
    description:
      "The AI-opener outreach target: entry/mid tier eyewear-carrying " +
      "stores with multi-brand assortments (less than 40% one brand). " +
      "Excludes the Premium/Luxury price ceiling.",
    filters: {
      tag_and: ["eyewear_cohort", "eyewear_multi_brand_assortment"],
      tag_not: ["eyewear_price_too_high"],
      has_email: "true",
    },
  },
  {
    name: "🎯 Eyewear — All affordable matches",
    description:
      "Broader cut: every eyewear-carrying store in the entry+mid tier, " +
      "regardless of brand concentration. Includes merged storeleads-source " +
      "rows that picked up eyewear data on import.",
    filters: {
      tag_and: ["eyewear_cohort"],
      tag_not: ["eyewear_price_too_high"],
    },
  },
  {
    name: "🎯 Eyewear — Reading-glasses cohort",
    description: "Stores carrying reading glasses (separately or alongside sunglasses).",
    filters: {
      tag_and: ["eyewear_cohort", "carries_reading_glasses"],
    },
  },
  {
    name: "🎯 Eyewear — Carries both categories",
    description: "Stores carrying both sunglasses AND reading glasses.",
    filters: {
      tag_and: ["eyewear_cohort", "carries_both"],
    },
  },
  {
    name: "📦 Eyewear — Premium/Luxury (out of scope for now)",
    description: "Eyewear stores with AOV above $100 — too premium for Jaxy's current positioning.",
    filters: {
      tag_and: ["eyewear_cohort", "eyewear_price_too_high"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Vintage stores",
    description: "Apparel boutiques with no current eyewear shelf, tagged as Vintage.",
    filters: {
      tag_and: ["apparel_no_eyewear_v1", "industry_vintage"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Gift / lifestyle stores",
    description: "Apparel boutiques with no current eyewear shelf, tagged as Gifts.",
    filters: {
      tag_and: ["apparel_no_eyewear_v1", "industry_gifts"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — All others",
    description: "Every other apparel boutique with no current eyewear shelf.",
    filters: {
      tag_and: ["apparel_no_eyewear_v1"],
      tag_not: ["industry_vintage", "industry_gifts"],
    },
  },
  {
    // Brand-targeting cohort: stores carrying one of the 17 brands
    // Jaxy directly competes with (FREYRS, DAX, Quay, DIFF, etc.).
    // Each store has the canonical brand on `primary_competitor_brand`
    // which gets pushed to Instantly as the `primary_competitor`
    // custom variable. Drives the Brand Carriers - v1 campaign's
    // per-lead mail-merge.
    // See src/modules/sales/lib/competitor-brands.ts for the list +
    // POST /api/admin/sales/backfill-competitor-brand to populate.
    name: "🥽 Brand Carriers — competes with Jaxy",
    description:
      "Stores carrying one of the 17 sunglass brands Jaxy directly competes with " +
      "(FREYRS, DAX, Quay, DIFF, Cramilo, etc.). The Brand Carriers - v1 Instantly " +
      "campaign uses the {{primary_competitor}} mail-merge variable to personalize " +
      "the opener per brand. Excludes leads already in pipeline so we don't pester " +
      "active conversations.",
    filters: {
      tag_and: ["brand_carrier"],
      has_email: "true",
    },
  },
];

function countForFilters(filters: Record<string, unknown>): number {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const sqArr = filters.source_query as string[] | undefined;
  if (sqArr?.length) {
    clauses.push(`source_query IN (${sqArr.map(() => "?").join(",")})`);
    params.push(...sqArr);
  }
  const tagAnd = filters.tag_and as string[] | undefined;
  if (tagAnd?.length) {
    for (const t of tagAnd) {
      clauses.push(`tags LIKE ?`);
      params.push(`%${t}%`);
    }
  }
  const tagNot = filters.tag_not as string[] | undefined;
  if (tagNot?.length) {
    for (const t of tagNot) {
      clauses.push(`(tags IS NULL OR tags NOT LIKE ?)`);
      params.push(`%${t}%`);
    }
  }
  if (filters.has_email === "true") clauses.push(`email IS NOT NULL AND email != ''`);
  if (filters.has_email === "false") clauses.push(`(email IS NULL OR email = '')`);

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM companies ${where}`).get(...params) as { c: number };
  return row.c;
}

export async function POST(request: NextRequest) {
  try {
    const key = request.headers.get("x-admin-key");
    if (key !== "jaxy2026") {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const findByName = sqlite.prepare<[string]>(
      `SELECT id FROM smart_lists WHERE name = ? LIMIT 1`,
    );
    const insertNew = sqlite.prepare(
      `INSERT INTO smart_lists
         (id, name, description, filters, is_shared, is_default, result_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, ?, datetime('now'), datetime('now'))`,
    );
    const updateExisting = sqlite.prepare(
      `UPDATE smart_lists
          SET description = ?, filters = ?, result_count = ?, updated_at = datetime('now')
        WHERE id = ?`,
    );

    const results: Array<{ name: string; action: "created" | "updated"; count: number }> = [];

    for (const list of LISTS) {
      const filtersJson = JSON.stringify(list.filters);
      const count = countForFilters(list.filters);
      const existing = findByName.get(list.name) as { id: string } | undefined;
      if (existing) {
        updateExisting.run(list.description, filtersJson, count, existing.id);
        results.push({ name: list.name, action: "updated", count });
      } else {
        insertNew.run(crypto.randomUUID(), list.name, list.description, filtersJson, count);
        results.push({ name: list.name, action: "created", count });
      }
    }

    return NextResponse.json({
      status: "done",
      created: results.filter((r) => r.action === "created").length,
      updated: results.filter((r) => r.action === "updated").length,
      results,
    });
  } catch (err: unknown) {
    const e = err as Error;
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
