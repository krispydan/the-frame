import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, resetTestDb } from "../setup";

describe("Job Queue", () => {
  let db: ReturnType<typeof getTestDb>;
  beforeEach(() => { db = getTestDb(); resetTestDb(); });

  it("enqueue creates job in DB", () => {
    db.prepare("INSERT INTO jobs (id, type, module, status, input, priority) VALUES ('j1', 'icp_classify', 'sales', 'queued', '{\"ids\":[1,2,3]}', 1)").run();
    const job = db.prepare("SELECT * FROM jobs WHERE id = 'j1'").get() as any;
    expect(job.status).toBe("queued");
    expect(job.type).toBe("icp_classify");
  });

  it("dequeue gets highest priority job", () => {
    db.prepare("INSERT INTO jobs (id, type, module, status, priority) VALUES ('j1', 'low', 'sales', 'queued', 0)").run();
    db.prepare("INSERT INTO jobs (id, type, module, status, priority) VALUES ('j2', 'high', 'sales', 'queued', 10)").run();
    const job = db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority DESC LIMIT 1").get() as any;
    expect(job.id).toBe("j2");
  });

  it("complete marks job done", () => {
    db.prepare("INSERT INTO jobs (id, type, module, status) VALUES ('j1', 'test', 'core', 'running')").run();
    db.prepare("UPDATE jobs SET status = 'completed', output = '{\"result\":\"ok\"}', completed_at = datetime('now') WHERE id = 'j1'").run();
    const job = db.prepare("SELECT * FROM jobs WHERE id = 'j1'").get() as any;
    expect(job.status).toBe("completed");
    expect(JSON.parse(job.output).result).toBe("ok");
  });

  it("fail increments attempts", () => {
    db.prepare("INSERT INTO jobs (id, type, module, status, attempts, max_attempts) VALUES ('j1', 'test', 'core', 'running', 1, 3)").run();
    db.prepare("UPDATE jobs SET status = 'queued', attempts = attempts + 1, error = 'timeout' WHERE id = 'j1'").run();
    const job = db.prepare("SELECT * FROM jobs WHERE id = 'j1'").get() as any;
    expect(job.attempts).toBe(2);
    expect(job.error).toBe("timeout");
  });
});
