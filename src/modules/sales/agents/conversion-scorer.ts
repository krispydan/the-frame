/**
 * F2-010: Conversion Scoring Agent
 * Rule-based prospect scoring (0-100)
 */
import { sqlite } from "@/lib/db";
import { logger } from "@/modules/core/lib/logger";

const TARGET_STATES = ["CA", "TX", "FL", "NY"];

interface CompanyRow {
  id: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  icp_tier: string | null;
  state: string | null;
}

export function scoreCompany(company: CompanyRow): number {
  let score = 0;

  if (company.email) score += 20;
  if (company.phone) score += 15;
  if (company.website) score += 10;
  if (company.google_rating != null && company.google_rating >= 4.0) score += 10;
  if (company.google_review_count != null && company.google_review_count >= 50) score += 10;

  if (company.icp_tier === "A") score += 30;
  else if (company.icp_tier === "B") score += 20;
  else if (company.icp_tier === "C") score += 10;

  if (company.state && TARGET_STATES.includes(company.state)) score += 5;

  return Math.min(100, score);
}

/**
 * Batch score companies
 */
export function batchScore(companyIds?: string[]): { scored: number } {
  let query = `SELECT id, email, phone, website, google_rating, google_review_count, icp_tier, state FROM companies`;
  const params: unknown[] = [];

  if (companyIds && companyIds.length > 0) {
    query += ` WHERE id IN (${companyIds.map(() => "?").join(",")})`;
    params.push(...companyIds);
  }

  const companies = sqlite.prepare(query).all(...params) as CompanyRow[];

  const updateStmt = sqlite.prepare("UPDATE companies SET prospect_score = ?, updated_at = datetime('now') WHERE id = ?");
  const tx = sqlite.transaction(() => {
    for (const company of companies) {
      const score = scoreCompany(company);
      updateStmt.run(score, company.id);
    }
  });

  tx();

  logger.logEvent("conversion_scoring", "sales", { count: companies.length });

  return { scored: companies.length };
}

/**
 * Get unscored companies
 */
export function getUnscoredIds(limit = 1000): string[] {
  return (sqlite.prepare("SELECT id FROM companies WHERE prospect_score IS NULL LIMIT ?").all(limit) as { id: string }[]).map((r) => r.id);
}
