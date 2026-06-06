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

const LISTS: SmartListDef[] = [
  {
    name: "🎯 Eyewear — Pitchable (entry+mid, multi-brand)",
    description:
      "The AI-opener outreach target: entry/mid tier eyewear-carrying " +
      "stores with multi-brand assortments (less than 40% one brand). " +
      "Excludes the Premium/Luxury price ceiling.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "eyewear_multi_brand_assortment"],
      tag_not: ["eyewear_price_too_high"],
      has_email: "true",
    },
  },
  {
    name: "🎯 Eyewear — All affordable matches",
    description:
      "Broader cut: every eyewear-carrying store in the entry+mid " +
      "tier, regardless of brand concentration.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort"],
      tag_not: ["eyewear_price_too_high"],
    },
  },
  {
    name: "🎯 Eyewear — Reading-glasses cohort",
    description: "Stores carrying reading glasses (separately or alongside sunglasses).",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "carries_reading_glasses"],
    },
  },
  {
    name: "🎯 Eyewear — Carries both categories",
    description: "Stores carrying both sunglasses AND reading glasses.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "carries_both"],
    },
  },
  {
    name: "📦 Eyewear — Premium/Luxury (out of scope for now)",
    description: "Eyewear stores with AOV above $100 — too premium for Jaxy's current positioning.",
    filters: {
      source_query: ["eyewear_inventory_v1_2026-06"],
      tag_and: ["eyewear_cohort", "eyewear_price_too_high"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Vintage stores",
    description: "Apparel boutiques with no current eyewear shelf, tagged as Vintage.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1", "industry_vintage"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — Gift / lifestyle stores",
    description: "Apparel boutiques with no current eyewear shelf, tagged as Gifts.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1", "industry_gifts"],
    },
  },
  {
    name: "🗂 Apparel no-eyewear — All others",
    description: "Every other apparel boutique with no current eyewear shelf.",
    filters: {
      source_query: ["apparel_no_eyewear_v1_2026-06"],
      tag_and: ["apparel_no_eyewear_v1"],
      tag_not: ["industry_vintage", "industry_gifts"],
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
