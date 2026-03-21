/**
 * F2-009: Duplicate Detection & Merge
 */
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

interface DuplicatePair {
  id1: string;
  id2: string;
  name1: string;
  name2: string;
  city1: string;
  city2: string;
  state1: string;
  state2: string;
  confidence: number;
  reasons: string[];
}

/**
 * Fuzzy name similarity (simple trigram-based)
 */
function nameSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1;
  if (na.length < 3 || nb.length < 3) return na === nb ? 1 : 0;

  // Trigram similarity
  const trigrams = (s: string) => {
    const t = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) t.add(s.slice(i, i + 3));
    return t;
  };
  const ta = trigrams(na);
  const tb = trigrams(nb);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return (2 * overlap) / (ta.size + tb.size);
}

/**
 * Find potential duplicate companies
 */
export function findDuplicates(limit = 100): DuplicatePair[] {
  const duplicates: DuplicatePair[] = [];

  // Strategy 1: Same phone
  const phoneMatches = sqlite.prepare(`
    SELECT c1.id as id1, c2.id as id2, c1.name as name1, c2.name as name2,
           c1.city as city1, c2.city as city2, c1.state as state1, c2.state as state2,
           c1.phone as phone
    FROM companies c1
    JOIN companies c2 ON c1.phone = c2.phone AND c1.id < c2.id
    WHERE c1.phone IS NOT NULL AND c1.phone != ''
    LIMIT ?
  `).all(limit) as { id1: string; id2: string; name1: string; name2: string; city1: string; city2: string; state1: string; state2: string; phone: string }[];

  for (const m of phoneMatches) {
    duplicates.push({
      ...m,
      confidence: 85 + (nameSimilarity(m.name1, m.name2) * 15),
      reasons: [`Same phone: ${m.phone}`],
    });
  }

  // Strategy 2: Same email
  const emailMatches = sqlite.prepare(`
    SELECT c1.id as id1, c2.id as id2, c1.name as name1, c2.name as name2,
           c1.city as city1, c2.city as city2, c1.state as state1, c2.state as state2,
           c1.email as email
    FROM companies c1
    JOIN companies c2 ON c1.email = c2.email AND c1.id < c2.id
    WHERE c1.email IS NOT NULL AND c1.email != ''
    LIMIT ?
  `).all(limit) as { id1: string; id2: string; name1: string; name2: string; city1: string; city2: string; state1: string; state2: string; email: string }[];

  for (const m of emailMatches) {
    const existing = duplicates.find((d) => (d.id1 === m.id1 && d.id2 === m.id2));
    if (existing) {
      existing.confidence = Math.min(100, existing.confidence + 10);
      existing.reasons.push(`Same email: ${m.email}`);
    } else {
      duplicates.push({
        ...m,
        confidence: 90 + (nameSimilarity(m.name1, m.name2) * 10),
        reasons: [`Same email: ${m.email}`],
      });
    }
  }

  // Strategy 3: Same domain
  const domainMatches = sqlite.prepare(`
    SELECT c1.id as id1, c2.id as id2, c1.name as name1, c2.name as name2,
           c1.city as city1, c2.city as city2, c1.state as state1, c2.state as state2,
           c1.domain as domain
    FROM companies c1
    JOIN companies c2 ON c1.domain = c2.domain AND c1.id < c2.id
    WHERE c1.domain IS NOT NULL AND c1.domain != ''
    LIMIT ?
  `).all(limit) as { id1: string; id2: string; name1: string; name2: string; city1: string; city2: string; state1: string; state2: string; domain: string }[];

  for (const m of domainMatches) {
    const existing = duplicates.find((d) => (d.id1 === m.id1 && d.id2 === m.id2));
    if (existing) {
      existing.confidence = Math.min(100, existing.confidence + 10);
      existing.reasons.push(`Same domain: ${m.domain}`);
    } else {
      duplicates.push({
        ...m,
        confidence: 75 + (nameSimilarity(m.name1, m.name2) * 25),
        reasons: [`Same domain: ${m.domain}`],
      });
    }
  }

  // Strategy 4: Fuzzy name + same state (only top matches)
  const nameCandidates = sqlite.prepare(`
    SELECT c1.id as id1, c2.id as id2, c1.name as name1, c2.name as name2,
           c1.city as city1, c2.city as city2, c1.state as state1, c2.state as state2
    FROM companies c1
    JOIN companies c2 ON c1.state = c2.state AND c1.id < c2.id
    WHERE c1.state IS NOT NULL
    AND c1.name != c2.name
    AND substr(lower(c1.name), 1, 5) = substr(lower(c2.name), 1, 5)
    LIMIT ?
  `).all(limit * 2) as { id1: string; id2: string; name1: string; name2: string; city1: string; city2: string; state1: string; state2: string }[];

  for (const m of nameCandidates) {
    const sim = nameSimilarity(m.name1, m.name2);
    if (sim < 0.7) continue;
    const existing = duplicates.find((d) => (d.id1 === m.id1 && d.id2 === m.id2));
    if (!existing) {
      duplicates.push({
        ...m,
        confidence: Math.round(sim * 80),
        reasons: [`Similar name (${Math.round(sim * 100)}% match), same state`],
      });
    }
  }

  // Sort by confidence desc, dedupe
  const seen = new Set<string>();
  return duplicates
    .filter((d) => {
      const key = `${d.id1}-${d.id2}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

/**
 * Merge two companies: keep primary, move all related records, delete secondary
 */
export function mergeCompanies(primaryId: string, secondaryId: string): { success: boolean; error?: string } {
  try {
    sqlite.transaction(() => {
      // Move stores
      sqlite.prepare("UPDATE stores SET company_id = ? WHERE company_id = ?").run(primaryId, secondaryId);
      // Move contacts
      sqlite.prepare("UPDATE contacts SET company_id = ? WHERE company_id = ?").run(primaryId, secondaryId);
      // Move deals
      sqlite.prepare("UPDATE deals SET company_id = ? WHERE company_id = ?").run(primaryId, secondaryId);
      // Move deal activities
      sqlite.prepare("UPDATE deal_activities SET company_id = ? WHERE company_id = ?").run(primaryId, secondaryId);
      // Delete secondary
      sqlite.prepare("DELETE FROM companies WHERE id = ?").run(secondaryId);

      logger.logChange("company", primaryId, "merged", secondaryId, primaryId, null, "api");
    })();

    return { success: true };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
