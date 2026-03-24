export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/api-middleware";
import { sqlite } from "@/lib/db";

export const GET = apiHandler(
  async (request: NextRequest) => {
    const q = request.nextUrl.searchParams.get("q")?.trim();
    if (!q || q.length < 2) {
      return NextResponse.json({ prospects: [] });
    }

    // Try FTS first, fallback to LIKE
    let rows: Record<string, unknown>[];
    try {
      const ftsResults = sqlite
        .prepare(`SELECT rowid FROM companies_fts WHERE companies_fts MATCH ? LIMIT 20`)
        .all(q + "*") as { rowid: number }[];

      if (ftsResults.length === 0) {
        rows = [];
      } else {
        const ids = ftsResults.map((r) => r.rowid).join(",");
        rows = sqlite
          .prepare(
            `SELECT id, name, domain, city, state, status FROM companies WHERE rowid IN (${ids}) LIMIT 20`
          )
          .all() as Record<string, unknown>[];
      }
    } catch {
      rows = sqlite
        .prepare(
          `SELECT id, name, domain, city, state, status FROM companies WHERE name LIKE ? LIMIT 20`
        )
        .all(`%${q}%`) as Record<string, unknown>[];
    }

    return NextResponse.json({ prospects: rows });
  },
  { auth: true }
);
