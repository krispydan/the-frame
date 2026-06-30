export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

/**
 * GET /api/admin/sales/enrich-via-apify/match-log
 *
 * Per-match audit log of every Apify enrichment decision — what we
 * sent, what Apify returned, the fuzzy similarity score, and what
 * we decided. Built for manual review of the low-confidence rejects
 * so we can tune the matcher.
 *
 * Two response formats:
 *   ?format=json  (default)   structured JSON
 *   ?format=csv               text/csv attachment download
 *
 * Filters:
 *   ?decision=skipped,accepted   filter by decision bucket
 *                                (no_match | skipped | accepted | marked_closed)
 *   ?min_similarity=0.5          only rows with sim ≥ this value
 *   ?max_similarity=0.85         only rows with sim ≤ this value
 *   ?since_hours=24              only rows newer than N hours
 *   ?limit=5000                  cap on rows (default 5000, max 50000)
 *
 * Typical workflow:
 *   curl ".../match-log?decision=skipped&format=csv" \
 *     -H "x-admin-key: jaxy2026" > skipped.csv
 *   open skipped.csv  (opens in Excel/Numbers/Sheets)
 *
 * Auth: x-admin-key.
 */
export async function GET(req: NextRequest) {
  if (req.headers.get("x-admin-key") !== "jaxy2026") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  const decisionCsv = url.searchParams.get("decision");
  const minSim = url.searchParams.get("min_similarity");
  const maxSim = url.searchParams.get("max_similarity");
  const sinceHours = url.searchParams.get("since_hours");
  const limit = Math.min(
    50_000,
    Math.max(1, parseInt(url.searchParams.get("limit") || "5000", 10) || 5000),
  );

  const where: string[] = [];
  const params: unknown[] = [];
  if (decisionCsv) {
    const decisions = decisionCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (decisions.length > 0) {
      where.push(`decision IN (${decisions.map(() => "?").join(",")})`);
      params.push(...decisions);
    }
  }
  if (minSim != null) {
    const v = parseFloat(minSim);
    if (!isNaN(v)) {
      where.push(`similarity_score >= ?`);
      params.push(v);
    }
  }
  if (maxSim != null) {
    const v = parseFloat(maxSim);
    if (!isNaN(v)) {
      where.push(`similarity_score <= ?`);
      params.push(v);
    }
  }
  if (sinceHours != null) {
    const h = parseFloat(sinceHours);
    if (!isNaN(h)) {
      where.push(`created_at >= datetime('now', ?)`);
      params.push(`-${h} hours`);
    }
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = sqlite
    .prepare(
      `SELECT created_at, decision, decision_reason, similarity_score,
              company_id, company_name, company_city, company_state,
              search_string,
              apify_title, apify_address, apify_city, apify_state,
              apify_phone, apify_place_id,
              apify_rating, apify_review_count,
              apify_permanently_closed, apify_temporarily_closed,
              apify_url,
              run_id
         FROM apify_match_log
         ${whereSql}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;

  if (format === "csv") {
    return new Response(rowsToCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="apify-match-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  // JSON default. Include quick aggregates for orientation.
  const totals = rows.reduce<Record<string, number>>((acc, r) => {
    const d = String(r.decision || "(null)");
    acc[d] = (acc[d] || 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    ok: true,
    row_count: rows.length,
    decision_totals: totals,
    rows,
    note: "Pass ?format=csv to download as a spreadsheet.",
  });
}

/** Serialize rows to RFC4180 CSV. Handles commas / quotes / newlines in cells. */
function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) {
    return "no rows\n";
  }
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : String(v);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const out: string[] = [headers.join(",")];
  for (const r of rows) {
    out.push(headers.map((h) => esc(r[h])).join(","));
  }
  return out.join("\n") + "\n";
}
