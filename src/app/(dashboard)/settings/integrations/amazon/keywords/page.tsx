/**
 * /settings/integrations/amazon/keywords
 *
 * Review surface for the scrubbed Cerebro keyword research that feeds the
 * Amazon listing prompts. One tab per frame shape (plus a shared "Head"
 * tab and a "Scrubbed" tab showing what was filtered out). Operators can
 * whitelist a phrase the scrub wrongly dropped, or blacklist one that
 * slipped through — the assembler honors both, and overrides survive
 * re-imports.
 *
 * Server component fetches the rows; KeywordsTable is the client island
 * that owns the tabs + override buttons.
 */
export const dynamic = "force-dynamic";

import { sqlite } from "@/lib/db";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Tags } from "lucide-react";
import { CANONICAL_SHAPES } from "@/modules/catalog/lib/keywords/scrub";
import { KeywordsTable, type KeywordRow } from "./keywords-table";

function tryAll<T>(sql: string, params: unknown[] = []): T[] {
  try {
    return sqlite.prepare(sql).all(...params) as T[];
  } catch (e) {
    console.error("[amazon keywords page]", e);
    return [];
  }
}

interface DbRow {
  phrase: string;
  sv: number;
  td: number;
  pool: string | null;
  shape: string | null;
  verdict: string;
  override_status: string | null;
}

/** Per-tab cap — the assembler only ever uses the top of each pool, so
 *  showing the top few hundred is plenty for review. */
const PER_BUCKET = 250;

export default function AmazonKeywordsPage() {
  // Keeps + anything an operator has touched + the top scrubbed rows so
  // the audit trail is visible. Dedup by phrase (highest volume wins).
  const rows = tryAll<DbRow>(`
    SELECT phrase,
           MAX(search_volume)   AS sv,
           MIN(title_density)   AS td,
           classification       AS pool,
           shape,
           verdict,
           MAX(override_status) AS override_status
      FROM catalog_keywords
     GROUP BY phrase, shape
     ORDER BY sv DESC
  `);

  const totalKeep = rows.filter((r) => r.verdict === "keep").length;
  const totalScrubbed = rows.filter((r) => r.verdict === "brand" || r.verdict === "irrelevant").length;
  const overrides = rows.filter((r) => r.override_status).length;

  // Bucket: head = shape NULL keeps; one bucket per canonical shape;
  // scrubbed = brand/irrelevant (any shape). Whitelisted/blacklisted rows
  // ride along in their natural bucket so they can be toggled back.
  const buckets: Record<string, KeywordRow[]> = { head: [] };
  for (const s of CANONICAL_SHAPES) buckets[s] = [];
  const scrubbed: KeywordRow[] = [];

  for (const r of rows) {
    const row: KeywordRow = {
      phrase: r.phrase,
      searchVolume: r.sv ?? 0,
      titleDensity: r.td ?? 0,
      pool: r.pool,
      shape: r.shape,
      verdict: r.verdict,
      overrideStatus: r.override_status,
    };
    if (r.verdict === "brand" || r.verdict === "irrelevant") {
      if (scrubbed.length < PER_BUCKET) scrubbed.push(row);
      continue;
    }
    // keep (or whitelisted): goes to its shape bucket, else head.
    const key = r.shape && buckets[r.shape] ? r.shape : "head";
    if (buckets[key].length < PER_BUCKET) buckets[key].push(row);
  }

  return (
    <div className="container mx-auto p-6 max-w-7xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Tags className="h-7 w-7" />
          Amazon keywords
        </h1>
        <p className="text-muted-foreground mt-2">
          Scrubbed Helium 10 Cerebro research, ranked by search volume. These pools feed
          every product&apos;s title, bullets, and backend search terms — keyed off its frame shape.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Keyword library</CardTitle>
          <CardDescription>
            {totalKeep.toLocaleString()} keep · {totalScrubbed.toLocaleString()} scrubbed (brand / irrelevant)
            {overrides > 0 ? ` · ${overrides} manual override${overrides === 1 ? "" : "s"}` : ""}.
            Whitelist a phrase the scrub wrongly dropped, or blacklist one that slipped through — the
            assembler picks it up on the next regeneration, and overrides survive re-imports.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <KeywordsTable buckets={buckets} scrubbed={scrubbed} />
        </CardContent>
      </Card>
    </div>
  );
}
