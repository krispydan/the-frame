import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Logger", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("logError writes to error_logs", () => {
    db.prepare("INSERT INTO error_logs (id, level, source, message) VALUES ('e1', 'error', 'sales', 'test error')").run();
    const row = db.prepare("SELECT * FROM error_logs WHERE id = 'e1'").get() as any;
    expect(row.level).toBe("error");
    expect(row.source).toBe("sales");
    expect(row.message).toBe("test error");
  });

  it("logChange writes immutable change_logs", () => {
    db.prepare("INSERT INTO change_logs (id, entity_type, entity_id, field, old_value, new_value, user_id, source) VALUES ('c1', 'company', 'comp1', 'status', 'new', 'qualified', 'u1', 'ui')").run();
    const row = db.prepare("SELECT * FROM change_logs WHERE id = 'c1'").get() as any;
    expect(row.old_value).toBe("new");
    expect(row.new_value).toBe("qualified");
  });

  it("logEvent writes to reporting_logs", () => {
    db.prepare("INSERT INTO reporting_logs (id, event_type, module, duration_ms) VALUES ('r1', 'agent_run', 'sales', 1200)").run();
    const row = db.prepare("SELECT * FROM reporting_logs WHERE id = 'r1'").get() as any;
    expect(row.event_type).toBe("agent_run");
    expect(row.duration_ms).toBe(1200);
  });
});
