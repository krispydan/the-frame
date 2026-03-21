import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Chat Commands", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => {
    db = getTestDb(); resetTestDb();
    db.prepare("INSERT INTO companies (id, name, state, type) VALUES ('c1', 'CA Boutique', 'CA', 'boutique')").run();
    db.prepare("INSERT INTO companies (id, name, state, type) VALUES ('c2', 'TX Gift Shop', 'TX', 'gift shop')").run();
    db.prepare("INSERT INTO companies (id, name, state, type) VALUES ('c3', 'CA Optical', 'CA', 'optical')").run();
  });

  it("counts prospects by state", () => {
    const result = db.prepare("SELECT COUNT(*) as count FROM companies WHERE UPPER(state) = 'CA'").get() as any;
    expect(result.count).toBe(2);
  });

  it("counts by category", () => {
    const result = db.prepare("SELECT COUNT(*) as count FROM companies WHERE LOWER(type) LIKE '%boutique%'").get() as any;
    expect(result.count).toBe(1);
  });

  it("counts all prospects", () => {
    const result = db.prepare("SELECT COUNT(*) as count FROM companies").get() as any;
    expect(result.count).toBe(3);
  });
});
