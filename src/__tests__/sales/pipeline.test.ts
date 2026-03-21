import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Pipeline", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => {
    db = getTestDb(); resetTestDb();
    db.prepare("INSERT INTO companies (id, name, state, status) VALUES ('c1', 'Test Boutique', 'CA', 'qualified')").run();
  });

  it("creates a deal linked to company", () => {
    db.prepare("INSERT INTO deals (id, company_id, title, value, stage, channel) VALUES ('d1', 'c1', 'Test Deal', 500, 'outreach', 'direct')").run();
    const deal = db.prepare("SELECT * FROM deals WHERE id = 'd1'").get() as any;
    expect(deal.company_id).toBe("c1");
    expect(deal.stage).toBe("outreach");
  });

  it("moves deal through stages", () => {
    db.prepare("INSERT INTO deals (id, company_id, title, value, stage) VALUES ('d1', 'c1', 'Test', 500, 'outreach')").run();
    for (const stage of ["contact_made", "interested", "order_placed"]) {
      db.prepare("UPDATE deals SET stage = ? WHERE id = 'd1'").run(stage);
    }
    const deal = db.prepare("SELECT stage FROM deals WHERE id = 'd1'").get() as any;
    expect(deal.stage).toBe("order_placed");
  });

  it("snooze sets future date", () => {
    db.prepare("INSERT INTO deals (id, company_id, title, stage) VALUES ('d1', 'c1', 'Test', 'outreach')").run();
    db.prepare("UPDATE deals SET snooze_until = '2026-04-15' WHERE id = 'd1'").run();
    const deal = db.prepare("SELECT snooze_until FROM deals WHERE id = 'd1'").get() as any;
    expect(deal.snooze_until).toBe("2026-04-15");
  });

  it("snoozed deals filtered from active", () => {
    db.prepare("INSERT INTO deals (id, company_id, title, stage, snooze_until) VALUES ('d1', 'c1', 'Active', 'outreach', NULL)").run();
    db.prepare("INSERT INTO deals (id, company_id, title, stage, snooze_until) VALUES ('d2', 'c1', 'Snoozed', 'outreach', '2026-12-31')").run();
    const active = db.prepare("SELECT * FROM deals WHERE snooze_until IS NULL OR snooze_until <= datetime('now')").all();
    expect(active.length).toBe(1);
  });

  it("reorder_due_at set on order_placed", () => {
    db.prepare("INSERT INTO deals (id, company_id, title, stage, reorder_due_at) VALUES ('d1', 'c1', 'Won Deal', 'order_placed', '2026-06-20')").run();
    const deal = db.prepare("SELECT reorder_due_at FROM deals WHERE id = 'd1'").get() as any;
    expect(deal.reorder_due_at).toBe("2026-06-20");
  });
});
