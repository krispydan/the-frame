/**
 * The clip library's search box.
 *
 * It used to be one LIKE '%whatever you typed%' applied to a handful of
 * columns, which fails the moment you type the way people actually
 * search. Three concrete failures it had:
 *
 *   "jade boulevard"  → nothing. The words live in different columns
 *                       (creator, product), and a single contiguous LIKE
 *                       can only match them inside ONE column.
 *   "JX4011-BLK"      → nothing. SKUs weren't searchable at all, only
 *                       product names, and operators think in SKUs.
 *   "3_Sub_207"       → matched 3xSubx207 too. Unescaped `_` is a
 *                       single-character wildcard in SQL LIKE, and clip
 *                       filenames are full of underscores.
 *
 * So: split the query into terms, require EVERY term to match somewhere
 * (AND across terms, OR across fields). That is what makes progressive
 * narrowing work — each word you add removes results instead of nuking
 * them. Quoted "…" keeps a phrase intact for when you want the old
 * contiguous behaviour.
 */

/**
 * Alternate spellings of a SKU term.
 *
 * The catalog carries two generations — JX4011-S-BLK (current) and
 * JX4011-BLK (legacy, and what Shopify shows). Someone reading a SKU off
 * the storefront types the form they can see, so searching has to accept
 * either and find the same clips. Purely textual, both directions; no
 * catalog lookup, so a partial like "JX4011" still behaves as a prefix.
 */
export function skuVariants(term: string): string[] {
  const up = term.toUpperCase();
  const out: string[] = [];
  // JX4011-S-BLK → JX4011-BLK
  const stripped = up.replace(/^(JX\d{4})-[SR]-/, "$1-");
  if (stripped !== up) out.push(stripped);
  // JX4011-BLK → JX4011-S-BLK / JX4011-R-BLK
  const m = /^(JX\d{4})-(?![SR]-)(.+)$/.exec(up);
  if (m) out.push(`${m[1]}-S-${m[2]}`, `${m[1]}-R-${m[2]}`);
  return out;
}

/**
 * SQL for one term, plus its params in order.
 *
 * Built per-term rather than as a constant because a SKU-shaped term
 * carries extra spellings to try (see skuVariants).
 */
function termSql(term: string): { sql: string; params: string[] } {
  const like = likePattern(term);
  const skuLikes = [like, ...skuVariants(term).map(likePattern)];
  const skuOr = skuLikes.map(() => `s.sku LIKE ? ESCAPE '\\'`).join(" OR ");
  return {
    sql: `(
      c.file_name LIKE ? ESCAPE '\\'
      OR c.notes LIKE ? ESCAPE '\\'
      OR c.talent LIKE ? ESCAPE '\\'
      OR cat.name LIKE ? ESCAPE '\\'
      OR cat.slug LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM marketing_video_clip_products cp
          JOIN catalog_skus s ON s.id = cp.sku_id
          LEFT JOIN catalog_products p ON p.id = s.product_id
         WHERE cp.clip_id = c.id
           AND (p.name LIKE ? ESCAPE '\\' OR s.color_name LIKE ? ESCAPE '\\' OR ${skuOr})
      )
    )`,
    // Order must match the placeholders above exactly.
    params: [like, like, like, like, like, like, like, ...skuLikes],
  };
}

/**
 * Split a query into terms, honouring "quoted phrases".
 *
 * Bare whitespace separates terms; anything inside double quotes stays
 * one term so `"take it all"` doesn't become three near-useless words.
 */
export function parseSearchTerms(raw: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const term = (m[1] ?? m[2] ?? "").trim();
    if (term) terms.push(term);
  }
  return terms;
}

/**
 * Make a term safe for LIKE.
 *
 * `%` and `_` are wildcards; a filename search like "3_Sub_207" is meant
 * literally, so they're escaped rather than left to match anything.
 */
export function likePattern(term: string): string {
  const escaped = term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return `%${escaped}%`;
}

export interface SearchClause {
  /** SQL to AND into the WHERE, or null when the query was empty. */
  sql: string | null;
  /** Positional params, already in order. */
  params: string[];
  /** The parsed terms (for relevance ranking and for tests). */
  terms: string[];
}

/**
 * Build the WHERE fragment for a search query.
 *
 * Every term must match at least one field — AND across terms, OR across
 * fields — so adding a word narrows instead of broadening.
 */
export function buildSearchClause(raw: string | null | undefined): SearchClause {
  const terms = parseSearchTerms(raw ?? "");
  if (terms.length === 0) return { sql: null, params: [], terms };

  const parts = terms.map(termSql);
  return {
    sql: parts.map((p) => p.sql).join(" AND "),
    params: parts.flatMap((p) => p.params),
    terms,
  };
}

/**
 * Rank a filename hit above an incidental one.
 *
 * Searching "boulevard" should lead with clips actually NAMED for it
 * rather than whatever happens to be newest among everything tagged with
 * that product. Ties fall through to the caller's normal ordering.
 */
export function buildRelevanceOrder(terms: string[]): { sql: string; params: string[] } {
  if (terms.length === 0) return { sql: "", params: [] };
  const like = likePattern(terms[0]);
  return {
    sql: `CASE WHEN c.file_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, `,
    params: [like],
  };
}
