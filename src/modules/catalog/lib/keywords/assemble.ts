/**
 * Per-product keyword assembler. Turns the scrubbed catalog_keywords
 * table into the ranked, byte-budgeted pools the Amazon prompt consumes,
 * keyed off a product's primary frame shape (+ any secondary shapes for
 * styles that legitimately span two categories).
 *
 * Ranking: score = searchVolume × relevanceWeight, where weight favours
 * the product's own shape over shared head terms over secondary shapes.
 * Ties break on ascending titleDensity (fewer competitors in the title =
 * an easier word to rank for).
 *
 * The backend string is the highest-leverage part: Amazon's
 * generic_keywords field indexes TOKENS, ignores anything already in the
 * title/bullets, and ignores repeats. So we pack unique, high-value
 * tokens NOT already used in the title/bullet pools up to the 240-byte
 * budget (Amazon hard-caps at 250).
 */
import { sqlite } from "@/lib/db";
import { canonicalShapeFor, BRAND_SINGLE_TOKENS } from "./scrub";

export interface AssembledKeywords {
  /** Generic head terms for the title (e.g. "sunglasses for women"). */
  head: string[];
  /** Shape-specific terms for the bullets ("round sunglasses for women"). */
  shape: string[];
  /** Feature terms ("polarized sunglasses", "uv400 sunglasses"). */
  feature: string[];
  /** Space-delimited backend search string, ≤240 bytes, token-deduped
   *  against the head/shape/feature pools. Goes verbatim into
   *  generic_keywords. */
  backend: string;
  /** How many keep rows fed the assembly (debug/telemetry). */
  candidateCount: number;
}

export interface AssembleOptions {
  primaryShape: string | null;
  secondaryShapes?: string[];
  /** Max phrases returned per title/bullet pool. */
  headLimit?: number;
  shapeLimit?: number;
  featureLimit?: number;
  /** Backend byte budget (Amazon caps generic_keywords at 250). */
  backendByteBudget?: number;
}

interface KeywordRow {
  phrase: string;
  search_volume: number;
  title_density: number;
  classification: string | null;
  shape: string | null;
  verdict: string;
  override_status: string | null;
}

const RELEVANCE = { primary: 1.0, head: 0.8, secondary: 0.6 } as const;

/** Tokens too generic to spend backend budget on. */
const STOPWORDS = new Set([
  "for", "the", "with", "and", "to", "a", "of", "in", "on", "your", "you",
  "my", "or", "by", "best", "top", "new", "that", "fit", "over",
]);

/** Split a phrase into indexable tokens (lowercase alphanumerics). */
function tokenize(phrase: string): string[] {
  return phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function assembleProductKeywords(opts: AssembleOptions): AssembledKeywords {
  const headLimit = opts.headLimit ?? 6;
  const shapeLimit = opts.shapeLimit ?? 12;
  const featureLimit = opts.featureLimit ?? 6;
  const budget = opts.backendByteBudget ?? 240;

  const primary = canonicalShapeFor(opts.primaryShape);
  const secondaries = (opts.secondaryShapes ?? [])
    .map(canonicalShapeFor)
    .filter((s): s is string => !!s && s !== primary);
  const shapeSet = new Set([primary, ...secondaries].filter((s): s is string => !!s));

  // Pull head terms (shape IS NULL) + every requested shape's terms. Keep
  // verdict='keep' OR a manual whitelist; never a manual blacklist.
  const shapeList = Array.from(shapeSet);
  const placeholders = shapeList.map(() => "?").join(",");
  const shapeClause = shapeList.length
    ? `(shape IS NULL OR shape IN (${placeholders}))`
    : "shape IS NULL";

  const rows = sqlite
    .prepare(
      `SELECT phrase, search_volume, title_density, classification, shape, verdict, override_status
         FROM catalog_keywords
        WHERE (verdict = 'keep' OR override_status = 'whitelist')
          AND (override_status IS NULL OR override_status != 'blacklist')
          AND ${shapeClause}`,
    )
    .all(...shapeList) as KeywordRow[];

  // Score + sort. Dedup by phrase (a head term can appear under multiple
  // source imports; keep the highest-scoring instance).
  const weightFor = (r: KeywordRow): number => {
    if (r.shape && r.shape === primary) return RELEVANCE.primary;
    if (r.shape && secondaries.includes(r.shape)) return RELEVANCE.secondary;
    return RELEVANCE.head; // shape IS NULL
  };

  const bestByPhrase = new Map<string, { row: KeywordRow; score: number }>();
  for (const r of rows) {
    const score = (r.search_volume || 0) * weightFor(r);
    const prev = bestByPhrase.get(r.phrase);
    if (!prev || score > prev.score) bestByPhrase.set(r.phrase, { row: r, score });
  }

  const ranked = Array.from(bestByPhrase.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.row.title_density || 0) - (b.row.title_density || 0); // lower density first
  });

  // Bucket for the prompt's title/bullet sections.
  const head: string[] = [];
  const shape: string[] = [];
  const feature: string[] = [];
  for (const { row } of ranked) {
    if (row.shape && shapeSet.has(row.shape)) {
      if (shape.length < shapeLimit) shape.push(row.phrase);
    } else if (row.classification === "feature") {
      if (feature.length < featureLimit) feature.push(row.phrase);
    } else {
      // head / audience / use_case shared terms → title head pool
      if (head.length < headLimit) head.push(row.phrase);
    }
  }

  // Backend: pack unique high-value tokens NOT already surfaced in the
  // title/bullet pools, ranked by phrase score, up to the byte budget.
  const used = new Set<string>();
  for (const p of [...head, ...shape, ...feature]) {
    for (const t of tokenize(p)) used.add(t);
  }
  const backendTokens: string[] = [];
  let bytes = 0;
  for (const { row } of ranked) {
    for (const t of tokenize(row.phrase)) {
      if (used.has(t) || STOPWORDS.has(t) || t.length < 2) continue;
      if (BRAND_SINGLE_TOKENS.has(t)) continue; // never index a competitor brand
      const addBytes = (backendTokens.length === 0 ? 0 : 1) + Buffer.byteLength(t, "utf8");
      if (bytes + addBytes > budget) continue; // skip; a shorter later token may still fit
      backendTokens.push(t);
      used.add(t);
      bytes += addBytes;
    }
    if (bytes >= budget) break;
  }

  return {
    head,
    shape,
    feature,
    backend: backendTokens.join(" "),
    candidateCount: bestByPhrase.size,
  };
}
