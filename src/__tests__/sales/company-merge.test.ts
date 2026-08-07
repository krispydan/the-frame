import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb } from "../setup";
import {
  findDuplicateCompanies, mergeCompanies, getNeedsReview,
  normalizeCompanyName, normalizeState,
} from "@/modules/sales/lib/company-merge";

/**
 * Merging companies deletes rows, so every rule here earns its place by
 * having been WRONG against production data first. Each case below is a real
 * record set that an earlier version of the detector either wrongly merged or
 * wrongly kept apart:
 *
 *   - a placeholder contact address ("name@email.com") sat on 8 unrelated
 *     companies and pulled them into one group
 *   - "seattle, WA" and "seattle, WASHINGTON" failed to corroborate, so two
 *     genuine Show Pony records stayed split
 *   - a personal telus.net address counted as a company domain and split
 *     "Front & Company" from "Front and Company" in the same city
 *   - eleven unrelated "Revival" shops shared nothing but a name
 */
const db = getTestDb();

// The shared fixture's `companies` DDL predates these columns; the merge reads
// them to rank keepers and to rescue fields off a loser before deleting it.
const EXTRA_COMPANY_COLUMNS = [
  "shopify_customer_id TEXT", "enrichment_text TEXT",
  "latitude REAL", "longitude REAL", "geocoded_at TEXT",
  "do_not_contact INTEGER DEFAULT 0", "do_not_contact_reason TEXT",
  "faire_retailer_id TEXT",
];

function reset() {
  for (const col of EXTRA_COMPANY_COLUMNS) {
    try { db.exec(`ALTER TABLE companies ADD COLUMN ${col}`); } catch { /* already added */ }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ajm_orders (id TEXT PRIMARY KEY, source TEXT, order_number TEXT, order_date TEXT, customer_name TEXT, email TEXT, city TEXT, state TEXT, country TEXT, total REAL, status TEXT, cancelled INTEGER DEFAULT 0, units INTEGER, company_id TEXT)`);
  db.exec(`DELETE FROM companies; DELETE FROM contacts; DELETE FROM orders; DELETE FROM customer_accounts; DELETE FROM ajm_orders;`);
}

let n = 0;
function company(name: string, city = "", state = "", opts: { zip?: string; email?: string; notes?: string; shopifyId?: string; createdAt?: string } = {}) {
  const id = `co${++n}`;
  db.prepare(
    `INSERT INTO companies (id, name, city, state, zip, notes, created_at) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, name, city, state, opts.zip ?? "", opts.notes ?? null, opts.createdAt ?? "2024-01-01");
  if (opts.email) {
    db.prepare(`INSERT INTO contacts (id, company_id, email) VALUES (?,?,?)`).run(`ct${n}`, id, opts.email);
  }
  return id;
}

const survivors = () => new Set((db.prepare("SELECT id FROM companies").all() as Array<{ id: string }>).map((r) => r.id));

beforeEach(reset);

describe("normalizeState", () => {
  it("maps spelled-out states and provinces to their code", () => {
    expect(normalizeState("WASHINGTON")).toBe("WA");
    expect(normalizeState("Maine")).toBe("ME");
    expect(normalizeState("new york")).toBe("NY");
    expect(normalizeState("British Columbia")).toBe("BC");
    expect(normalizeState("wa")).toBe("WA");
    expect(normalizeState(null)).toBe("");
  });
});

describe("normalizeCompanyName", () => {
  it("ignores punctuation, case and legal suffixes", () => {
    expect(normalizeCompanyName("Grey 56 Leather Inc")).toBe(normalizeCompanyName("Grey56 Leather"));
    expect(normalizeCompanyName("Front & Company")).toBe(normalizeCompanyName("Front and Company"));
    expect(normalizeCompanyName("ALTER")).toBe(normalizeCompanyName("Alter"));
  });
});

describe("findDuplicateCompanies — merges genuine duplicates", () => {
  it("treats WA and WASHINGTON as the same state", () => {
    const a = company("Show Pony", "seattle", "WA");
    const b = company("Show Pony", "seattle", "WASHINGTON", { email: "name@email.com" });
    mergeCompanies({ apply: true });
    const left = survivors();
    expect(left.has(a) && left.has(b)).toBe(false);
    expect(left.size).toBe(1);
  });

  it("does not let a personal ISP address masquerade as a company domain", () => {
    // Same name, same city; only the contact domains differ.
    company("Front & Company", "vancouver", "BC", { email: "flora.cheung@telus.net" });
    company("Front and Company", "vancouver", "BC", { email: "flora@frontandcompany.ca" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(1);
  });

  it("links on a shared company domain even when the addresses differ", () => {
    company("Alter", "brooklyn", "NY", { email: "tommy@alterbrooklyn.com" });
    company("ALTER", "", "", { email: "info@alterbrooklyn.com" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(1);
  });

  it("matches St. and Saint spellings of a city", () => {
    company("360 Boutique", "st. augustine", "FL");
    company("360 Boutique", "saint augustine", "FLORIDA");
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(1);
  });
});

describe("findDuplicateCompanies — refuses unsafe merges", () => {
  it("keeps same-named shops in different cities apart", () => {
    company("Revival", "portland", "OR", { zip: "97201" });
    company("Revival", "austin", "TX", { zip: "78701" });
    expect(findDuplicateCompanies()).toHaveLength(0);
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
    expect(getNeedsReview().some((r) => r.key === "name:revival")).toBe(true);
  });

  it("ignores a placeholder address shared by many companies", () => {
    const shops = [
      ["Martin Patrick 3", "minneapolis", "MN"],
      ["Ventura Swimwear", "ventura", "CA"],
      ["The Curator", "asheville", "NC"],
      ["The Arrangement", "dallas", "TX"],
      ["Pedal Bike Shop", "denver", "CO"],
      ["Glow Med Spa", "tampa", "FL"],
      ["Blue Door Gifts", "boise", "ID"],
      ["Harbor Goods", "portland", "ME"],
    ].map(([nm, city, st]) => company(nm, city, st, { email: "name@email.com" }));

    mergeCompanies({ apply: true });
    const left = survivors();
    for (const id of shops) expect(left.has(id)).toBe(true);
    expect(getNeedsReview().some((r) => r.reason.includes("placeholder inbox"))).toBe(true);
  });

  it("does not merge on a shared rep address alone", () => {
    company("Sunwink", "chicago", "IL", { email: "hello@rep-agency.com" });
    company("Northside Apothecary", "seattle", "WA", { email: "hello@rep-agency.com" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
  });

  it("keeps distinct stores of one chain separate", () => {
    company("Lockwood", "astoria", "NY", { zip: "11106" });
    company("Lockwood Shop", "brooklyn", "NEW YORK", { zip: "11222" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
  });

  it("keeps sibling stores that share a shop address but each trade", () => {
    // Two real Brooklyn shops on one shop@ inbox, each with its own history.
    const a = company("Lockwood Williamsburg", "brooklyn", "NY", { email: "shop@lockwoodshop.com" });
    const b = company("Lockwood Greenpoint", "brooklyn", "NY", { email: "shop@lockwoodshop.com" });
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a1','A1','2024-06-01',4677,0,?)`).run(a);
    db.prepare(`INSERT INTO orders (id, order_number, company_id, channel, status, total, placed_at) VALUES ('o1','#1',?,'shopify_wholesale','shipped',1440,'2026-04-28')`).run(b);

    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
    expect(getNeedsReview().some((r) => r.key.includes("lockwoodshop"))).toBe(true);
  });

  it("does not merge an email group on city alone, even for a real dba", () => {
    // "Water Bros, INC Dba: Quiet Storm" and "Quiet Storm Surf Shop" ARE the
    // same shop, but the only thing linking them is a shared inbox and a
    // shared city — and that same evidence wanted to merge "Shell" into
    // "Timewise Car Wash" (both Houston TX) and to collapse Clean Market's
    // Midtown, FIDI and NoHo branches into one record. We accept losing this
    // merge to review rather than accept those. A matching zip or name still
    // merges it.
    company("Water Bros, INC Dba: Quiet Storm", "rehoboth beach", "DE", { email: "info@quietstormsurf.com" });
    const real = company("Quiet Storm Surf Shop", "rehoboth beach", "DE", { email: "info@quietstormsurf.com" });
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a2','A2','2024-06-01',15654,0,?)`).run(real);

    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
    expect(getNeedsReview().some((r) => r.key.includes("quietstormsurf"))).toBe(true);
  });

  it("merges an email group when a zip corroborates it", () => {
    company("Water Bros, INC Dba: Quiet Storm", "rehoboth beach", "DE", { zip: "19971", email: "info@quietstormsurf.com" });
    const real = company("Quiet Storm Surf Shop", "rehoboth beach", "DE", { zip: "19971", email: "info@quietstormsurf.com" });
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a8','A8','2024-06-01',15654,0,?)`).run(real);

    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(1);
  });

  it("does not merge unrelated shops that share an inbox and a city", () => {
    company("Shell", "houston", "TX", { email: "ops@fuelpartners.com" });
    company("Timewise Car Wash", "houston", "TX", { email: "ops@fuelpartners.com" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(2);
  });
});

describe("findDuplicateCompanies — group integrity", () => {
  it("never makes a company both a keeper and a loser", () => {
    // The name pass and the email pass find overlapping sets. If each picks
    // its own keeper, rows get repointed onto a record that is then deleted,
    // and the whole apply dies on a foreign key. This invariant is what makes
    // the merge safe to run in one transaction.
    company("Hidden Treasures", "topanga", "CA", { email: "info@hiddentreasures.com" });
    company("Hidden Treasures", "topanga", "CALIFORNIA", { email: "info@hiddentreasures.com" });
    company("Hidden Treasures", "", "", { email: "info@hiddentreasures.com" });

    const groups = findDuplicateCompanies();
    const keepers = new Set(groups.map((g) => g.keepId));
    const losers = new Set(groups.flatMap((g) => g.companies.filter((c) => c.id !== g.keepId).map((c) => c.id)));
    expect([...keepers].filter((id) => losers.has(id))).toEqual([]);

    // And each company appears in exactly one group.
    const seen = new Set<string>();
    for (const g of groups) for (const c of g.companies) {
      expect(seen.has(c.id)).toBe(false);
      seen.add(c.id);
    }
  });

  it("fuses a name group and an email group into one survivor", () => {
    company("Urban Dwell", "washington", "DC", { email: "tom@urbandwell.com" });
    company("Urban Dwell", "washington", "DISTRICT OF COLUMBIA", { email: "tom@urbandwell.com" });
    mergeCompanies({ apply: true });
    expect(survivors().size).toBe(1);
  });
});

describe("mergeCompanies", () => {
  it("dry-runs by default", () => {
    company("Show Pony", "seattle", "WA");
    company("Show Pony", "seattle", "WASHINGTON");
    const res = mergeCompanies();
    expect(res.dryRun).toBe(true);
    expect(res.companiesRemoved).toBe(1);
    expect(survivors().size).toBe(2);
  });

  it("keeps the record holding the history over a placeholder-contact stub", () => {
    // The stub's only contact is the shared placeholder address; it must not
    // outrank the record carrying $85,976 of AJM history.
    const real = company("Show Pony", "seattle", "WA");
    company("Show Pony", "seattle", "WASHINGTON", { email: "name@email.com" });
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a3','A3','2024-06-01',85976,0,?)`).run(real);

    mergeCompanies({ apply: true });
    expect([...survivors()]).toEqual([real]);
  });

  it("keeps the worked CRM record and repoints its orders", () => {
    // A1 is the record a human has worked; A2 is the webhook's stub, and the
    // stub is the one carrying the orders. The worked record must survive.
    const worked = company("Grey56 Leather", "miami", "FL", { zip: "33101", notes: "key account" });
    const stub = company("Grey 56 Leather Inc", "miami", "FL", { zip: "33101", createdAt: "2025-01-01" });
    db.prepare(`INSERT INTO orders (id, order_number, company_id, channel, status, total, placed_at) VALUES ('o1','#1',?, 'shopify_wholesale','shipped',1808,'2026-05-20')`).run(stub);
    db.prepare(`INSERT INTO orders (id, order_number, company_id, channel, status, total, placed_at) VALUES ('o2','#2',?, 'shopify_wholesale','shipped',1596,'2026-04-28')`).run(stub);

    mergeCompanies({ apply: true });

    const left = survivors();
    expect(left.has(worked)).toBe(true);
    expect(left.has(stub)).toBe(false);
    const rolled = db.prepare("SELECT COUNT(*) n, SUM(total) rev FROM orders WHERE company_id = ?").get(worked) as { n: number; rev: number };
    expect(rolled.n).toBe(2);
    expect(rolled.rev).toBe(3404);
  });

  it("rescues the loser's shopify id and blank fields onto the keeper", () => {
    // Losing shopify_customer_id would let the order webhook recreate this
    // exact duplicate on the customer's next order.
    const worked = company("Grey56 Leather", "miami", "FL", { zip: "33101", notes: "key account" });
    const stub = company("Grey 56 Leather Inc", "miami", "FL", { zip: "33101", createdAt: "2025-01-01" });
    db.prepare("UPDATE companies SET shopify_customer_id='SHOP-999', domain='grey56.com' WHERE id=?").run(stub);

    mergeCompanies({ apply: true });

    const k = db.prepare("SELECT shopify_customer_id AS sid, domain, notes FROM companies WHERE id=?").get(worked) as Record<string, string>;
    expect(k.sid).toBe("SHOP-999");
    expect(k.domain).toBe("grey56.com");
    expect(k.notes).toBe("key account"); // never overwritten
  });

  it("survives a composite unique index the repoint would collide on", () => {
    // company_phones is UNIQUE(company_id, phone), and two records of the same
    // shop almost always carry the same number. Repointing both rows onto the
    // keeper violates the index — this rolled back the first production apply.
    db.exec(`CREATE TABLE IF NOT EXISTS company_phones (id TEXT PRIMARY KEY, company_id TEXT, phone TEXT)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_company_phones ON company_phones (company_id, phone)`);
    db.exec(`DELETE FROM company_phones`);

    const keep = company("Show Pony", "seattle", "WA");
    const dup = company("Show Pony", "seattle", "WASHINGTON");
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a4','A4','2024-06-01',85976,0,?)`).run(keep);
    db.prepare(`INSERT INTO company_phones VALUES ('p1',?,'206-555-0100')`).run(keep);
    db.prepare(`INSERT INTO company_phones VALUES ('p2',?,'206-555-0100')`).run(dup);   // collides
    db.prepare(`INSERT INTO company_phones VALUES ('p3',?,'206-555-0199')`).run(dup);   // survives

    expect(() => mergeCompanies({ apply: true })).not.toThrow();

    const phones = (db.prepare("SELECT phone FROM company_phones WHERE company_id=? ORDER BY phone").all(keep) as Array<{ phone: string }>).map((r) => r.phone);
    expect(phones).toEqual(["206-555-0100", "206-555-0199"]);
    expect(survivors().size).toBe(1);
  });

  it("repoints tables that were never on the hand-maintained list", () => {
    db.exec(`CREATE TABLE IF NOT EXISTS sequence_enrollments (id TEXT PRIMARY KEY, company_id TEXT, status TEXT, exited_at TEXT, exit_reason TEXT)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_seq_enroll_one_active ON sequence_enrollments (company_id) WHERE status IN ('active','paused_t0')`);
    db.exec(`DELETE FROM sequence_enrollments`);
    const keep = company("Show Pony", "seattle", "WA");
    const dup = company("Show Pony", "seattle", "WASHINGTON");
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a5','A5','2024-06-01',85976,0,?)`).run(keep);
    db.prepare(`INSERT INTO sequence_enrollments (id, company_id, status) VALUES ('s1',?,'active')`).run(dup);

    mergeCompanies({ apply: true });

    const row = db.prepare("SELECT company_id AS cid FROM sequence_enrollments WHERE id='s1'").get() as { cid: string };
    expect(row.cid).toBe(keep);
  });

  it("carries do-not-contact onto the survivor", () => {
    // do_not_contact = 0 is not blank, so the blank-filling backfill cannot
    // rescue it. Without an explicit OR across the group, merging a suppressed
    // duplicate would quietly make a retailer who asked us to stop contactable.
    const keep = company("Show Pony", "seattle", "WA");
    const dup = company("Show Pony", "seattle", "WASHINGTON");
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a6','A6','2024-06-01',85976,0,?)`).run(keep);
    db.prepare("UPDATE companies SET do_not_contact=1, do_not_contact_reason='asked to stop' WHERE id=?").run(dup);

    mergeCompanies({ apply: true });

    const row = db.prepare("SELECT do_not_contact AS dnc, do_not_contact_reason AS why FROM companies WHERE id=?").get(keep) as { dnc: number; why: string };
    expect([...survivors()]).toEqual([keep]);
    expect(row.dnc).toBe(1);
    expect(row.why).toBe("asked to stop");
  });

  it("repoints a reference that is not called company_id", () => {
    // A declared FK into companies under another name is invisible to a
    // company_id scan; the row is left pointing at a deleted company and the
    // DELETE trips the constraint. This is what killed the second apply.
    db.exec(`DROP TABLE IF EXISTS company_relationships`);
    db.exec(`CREATE TABLE company_relationships (id TEXT PRIMARY KEY, parent_company_id TEXT REFERENCES companies(id), note TEXT)`);
    db.pragma("foreign_keys = ON");

    const keep = company("Show Pony", "seattle", "WA");
    const dup = company("Show Pony", "seattle", "WASHINGTON");
    db.prepare(`INSERT INTO ajm_orders (id, order_number, order_date, total, cancelled, company_id) VALUES ('a7','A7','2024-06-01',85976,0,?)`).run(keep);
    db.prepare(`INSERT INTO company_relationships VALUES ('r1',?,'parent')`).run(dup);

    expect(() => mergeCompanies({ apply: true })).not.toThrow();
    const row = db.prepare("SELECT parent_company_id AS pid FROM company_relationships WHERE id='r1'").get() as { pid: string };
    expect(row.pid).toBe(keep);

    db.pragma("foreign_keys = OFF");
    db.exec(`DROP TABLE IF EXISTS company_relationships`);
  });

  it("is stable when run twice", () => {
    company("Show Pony", "seattle", "WA");
    company("Show Pony", "seattle", "WASHINGTON");
    mergeCompanies({ apply: true });
    const after = survivors();
    mergeCompanies({ apply: true });
    expect(survivors()).toEqual(after);
  });
});
