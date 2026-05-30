/**
 * Vitest tests for the StoreLeads CSV importer. Uses the shared
 * in-memory test DB from src/__tests__/setup.ts (auto-mocks @/lib/db).
 * That DB ships a slim `companies` schema; we ALTER in the StoreLeads-
 * specific columns once so the importer's INSERT/UPDATE round-trips work.
 *
 * Covers:
 *   - Currency parsing ("USD $250000", "USD $29.10")
 *   - Insert path: new domain → row with storeleads_* columns populated
 *   - Dedup within a single file: same domain twice → second skipped
 *   - Empty-domain rows are skipped, not crashed
 *   - Merge path: existing hand-edited values are NOT clobbered; nulls
 *     fill from CSV; storeleads_last_synced_at always stamps
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { getTestDb, resetTestDb } from "../../setup";

// Extend the shared test schema with the StoreLeads columns the importer
// writes. Idempotent so re-runs don't error.
function ensureStoreLeadsColumns() {
  const db = getTestDb();
  const cols: string[] = [
    "category TEXT",
    "industry TEXT",
    "source_type TEXT",
    "source_query TEXT",
    "storeleads_id TEXT",
    "storeleads_last_synced_at TEXT",
    "employee_count INTEGER",
    "estimated_monthly_visits INTEGER",
    "estimated_yearly_sales_cents INTEGER",
    "average_product_price_cents INTEGER",
    "facebook_url TEXT",
    "instagram_url TEXT",
    "tiktok_url TEXT",
    "tiktok_followers INTEGER",
    "youtube_url TEXT",
    "youtube_followers INTEGER",
    "contact_form_url TEXT",
    "ecom_platform TEXT",
    "enriched_at TEXT",
    "enrichment_source TEXT",
    "enrichment_fetched_at TEXT",
  ];
  for (const c of cols) {
    try {
      db.exec(`ALTER TABLE companies ADD COLUMN ${c}`);
    } catch {
      // exists
    }
  }
}

const HEADER =
  "domain,about_us_url,average_product_price_usd,categories,city,cluster_domains,company_ids,company_location,contact_page_url,country_code,created,description,domain_url,emails,employee_count,estimated_monthly_pageviews,estimated_monthly_visits,estimated_yearly_sales,facebook,instagram,phones,platform,region,state,status,street_address,tiktok,tiktok_followers,youtube,youtube_followers\n";

function writeCsv(rows: string[]): string {
  const p = path.join(os.tmpdir(), `sl-import-${process.pid}-${Math.random()}.csv`);
  fs.writeFileSync(p, HEADER + rows.join("\n") + "\n");
  return p;
}

beforeAll(() => {
  ensureStoreLeadsColumns();
});

beforeEach(() => {
  resetTestDb();
  // resetTestDb may have re-created schema → re-add our columns.
  ensureStoreLeadsColumns();
});

describe("storeleads CSV importer", () => {
  it("inserts a new row and parses currency / counts correctly", async () => {
    const csv = writeCsv([
      `shopdressup.com,,USD $29.10,/Apparel/Women's Clothing,Gainesville,shopdressup.com,co_123,"Gainesville, GA, USA",https://shopdressup.com/pages/contact,US,2018/06/22,Boutique,https://shopdressup.com,sales@shopdressup.com,154,1992300,538459,USD $5400000,facebook.com/shopdressup,instagram.com/shopdressup,7705551212,shopify,Americas,GA,active,123 Main St,tiktok.com/shopdressup,15000,youtube.com/shopdressup,500`,
    ]);
    const { importStoreLeadsCsv } = await import("@/modules/sales/lib/storeleads/import");
    const stats = await importStoreLeadsCsv(csv);
    expect(stats.totalRows).toBe(1);
    expect(stats.created).toBe(1);
    expect(stats.mergedByDomain).toBe(0);

    const row = getTestDb()
      .prepare("SELECT * FROM companies WHERE domain = ?")
      .get("shopdressup.com") as Record<string, unknown>;
    expect(row.domain).toBe("shopdressup.com");
    expect(row.email).toBe("sales@shopdressup.com");
    expect(row.phone).toBe("7705551212");
    expect(row.city).toBe("Gainesville");
    expect(row.state).toBe("GA");
    expect(row.country).toBe("US");
    expect(row.average_product_price_cents).toBe(2910);
    expect(row.estimated_yearly_sales_cents).toBe(540000000);
    expect(row.employee_count).toBe(154);
    expect(row.estimated_monthly_visits).toBe(538459);
    expect(row.tiktok_followers).toBe(15000);
    expect(row.youtube_followers).toBe(500);
    expect(row.ecom_platform).toBe("shopify");
    expect(row.source_type).toBe("storeleads");
    expect(row.storeleads_id).toBe("co_123");
    expect(row.storeleads_last_synced_at).toBeTruthy();
  });

  it("deduplicates within a single CSV (same domain twice → second skipped)", async () => {
    const csv = writeCsv([
      `dup.com,,,,,,,,,US,,,https://dup.com,a@dup.com,,,,,,,,shopify,,,,,,,,`,
      `dup.com,,,,,,,,,US,,,https://dup.com,a@dup.com,,,,,,,,shopify,,,,,,,,`,
    ]);
    const { importStoreLeadsCsv } = await import("@/modules/sales/lib/storeleads/import");
    const stats = await importStoreLeadsCsv(csv);
    expect(stats.totalRows).toBe(2);
    expect(stats.created).toBe(1);
    expect(stats.skippedDuplicate).toBe(1);
  });

  it("skips rows with no domain", async () => {
    const csv = writeCsv([
      `,,,,,,,,,,,,,,,,,,,,,,,,,,,,,`,
    ]);
    const { importStoreLeadsCsv } = await import("@/modules/sales/lib/storeleads/import");
    const stats = await importStoreLeadsCsv(csv);
    expect(stats.skippedNoDomain).toBe(1);
    expect(stats.created).toBe(0);
  });

  it("never clobbers a hand-edited non-null field on merge", async () => {
    const db = getTestDb();
    db.prepare(`
      INSERT INTO companies (id, name, domain, email, phone, status, created_at, updated_at)
      VALUES ('c1', 'Hand Edited', 'edited.com',
              'human@edited.com', '5559999999',
              'qualified', datetime('now'), datetime('now'))
    `).run();

    const csv = writeCsv([
      `edited.com,,USD $99.00,/Apparel/,Austin,,co_777,,,US,,,https://edited.com,storeleads@edited.com,42,,1000,USD $250000,,,8005551111,shopify,,TX,,,,,,`,
    ]);
    const { importStoreLeadsCsv } = await import("@/modules/sales/lib/storeleads/import");
    const stats = await importStoreLeadsCsv(csv);
    expect(stats.mergedByDomain).toBe(1);
    expect(stats.created).toBe(0);

    const row = db
      .prepare("SELECT * FROM companies WHERE domain = ?")
      .get("edited.com") as Record<string, unknown>;
    // Hand-edited values UNCHANGED:
    expect(row.email).toBe("human@edited.com");
    expect(row.phone).toBe("5559999999");
    expect(row.status).toBe("qualified");
    // Previously-null fields FILLED IN:
    expect(row.city).toBe("Austin");
    expect(row.state).toBe("TX");
    expect(row.ecom_platform).toBe("shopify");
    expect(row.estimated_yearly_sales_cents).toBe(25000000);
    expect(row.storeleads_id).toBe("co_777");
    // Sync timestamp ALWAYS stamps:
    expect(row.storeleads_last_synced_at).toBeTruthy();
  });
});
