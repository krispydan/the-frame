import { NextRequest } from "next/server";
import { getTestDb } from "./setup";

/**
 * Create a mock NextRequest for testing API route handlers.
 */
export function createRequest(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    searchParams?: Record<string, string | string[]>;
    headers?: Record<string, string>;
  }
): NextRequest {
  const url = new URL(path, "http://localhost:3000");
  if (options?.searchParams) {
    for (const [key, val] of Object.entries(options.searchParams)) {
      if (Array.isArray(val)) {
        for (const v of val) url.searchParams.append(key, v);
      } else {
        url.searchParams.set(key, val);
      }
    }
  }

  const init: RequestInit = { method };
  if (options?.body) {
    init.body = JSON.stringify(options.body);
    init.headers = { "Content-Type": "application/json", ...options?.headers };
  } else if (options?.headers) {
    init.headers = options.headers;
  }

  return new NextRequest(url, init);
}

/**
 * Parse JSON from a NextResponse.
 */
export async function parseResponse<T = unknown>(response: Response): Promise<{ status: number; data: T }> {
  const data = await response.json() as T;
  return { status: response.status, data };
}

/**
 * Seed common test data into the test DB.
 */
export function seedTestData() {
  const db = getTestDb();

  // Companies
  db.prepare(`INSERT INTO companies (id, name, state, status, email, phone, icp_score, icp_tier, source, type, domain)
    VALUES ('c1', 'Sunny Shades', 'CA', 'qualified', 'info@sunny.com', '555-0001', 85, 'A', 'google', 'boutique', 'sunny.com')`).run();
  db.prepare(`INSERT INTO companies (id, name, state, status, email, phone, icp_score, icp_tier, source, type, domain)
    VALUES ('c2', 'Cool Frames', 'NY', 'new', NULL, '555-0002', 45, 'C', 'faire', 'chain', 'coolframes.com')`).run();
  db.prepare(`INSERT INTO companies (id, name, state, status, email, icp_score, icp_tier)
    VALUES ('c3', 'Beach Eyewear', 'FL', 'contacted', 'hello@beach.com', 72, 'B')`).run();

  // FTS
  try {
    db.prepare(`INSERT INTO companies_fts(rowid, name, city, state) SELECT rowid, name, city, state FROM companies`).run();
  } catch {}

  // Stores
  db.prepare(`INSERT INTO stores (id, company_id, name, is_primary) VALUES ('s1', 'c1', 'Main Store', 1)`).run();

  // Contacts
  db.prepare(`INSERT INTO contacts (id, company_id, store_id, first_name, last_name, email, is_primary)
    VALUES ('ct1', 'c1', 's1', 'Jane', 'Doe', 'jane@sunny.com', 1)`).run();

  return db;
}

/**
 * Seed deals into the test DB.
 */
export function seedDeals() {
  const db = getTestDb();
  db.prepare(`INSERT INTO deals (id, company_id, title, value, stage, channel, last_activity_at, created_at)
    VALUES ('d1', 'c1', 'Sunny Initial Order', 500, 'outreach', 'direct', datetime('now'), datetime('now'))`).run();
  db.prepare(`INSERT INTO deals (id, company_id, title, value, stage, channel, snooze_until, last_activity_at, created_at)
    VALUES ('d2', 'c2', 'Cool Frames Follow-up', 300, 'contact_made', 'faire', '2099-12-31', datetime('now'), datetime('now'))`).run();
  return db;
}

/**
 * Seed campaigns into the test DB.
 */
export function seedCampaigns() {
  const db = getTestDb();
  db.prepare(`INSERT INTO campaigns (id, name, type, status, sent, opened, replied)
    VALUES ('camp1', 'Launch Campaign', 'email_sequence', 'active', 100, 40, 10)`).run();
  db.prepare(`INSERT INTO campaigns (id, name, type, status, sent, opened, replied)
    VALUES ('camp2', 'Re-engage Old Leads', 're_engagement', 'draft', 0, 0, 0)`).run();
  return db;
}
