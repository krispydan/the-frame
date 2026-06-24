/**
 * Regression test for the daily health digest reading 0 calls despite a
 * busy day. Root cause: loadPhoneBurnerMetrics compared called_at as a
 * RAW string against ISO-UTC bounds, so rows stored in the common
 * "YYYY-MM-DD HH:MM:SS" (space, no Z) format — what the PhoneBurner
 * webhook writes — were silently excluded (space sorts before 'T').
 * The fix wraps both sides in datetime(); this proves mixed-format rows
 * inside the window are now counted.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getTestDb } from "../setup";
import { loadPhoneBurnerMetrics } from "@/modules/integrations/lib/slack/digests";

const START = "2026-06-23T07:00:00.000Z"; // midnight PT (PDT)
const END = "2026-06-24T07:00:00.000Z";

beforeAll(() => {
  const db = getTestDb();
  db.exec(`CREATE TABLE IF NOT EXISTS phoneburner_call_log (
    id TEXT PRIMARY KEY, connected INTEGER, disposition_label TEXT, called_at TEXT
  )`);
  db.exec(`DELETE FROM phoneburner_call_log`);
  const ins = db.prepare(
    `INSERT INTO phoneburner_call_log (id, connected, disposition_label, called_at) VALUES (?,?,?,?)`,
  );
  // In-window, SPACE format (the webhook format that used to be dropped)
  ins.run("c1", 1, "Set Appointment", "2026-06-23 20:30:00");
  ins.run("c2", 0, "No Answer", "2026-06-23 09:00:00");
  // In-window, ISO format (poll format) — should also count
  ins.run("c3", 1, "Left Voicemail", "2026-06-23T21:00:00.000Z");
  // Out of window (before start, space format) — excluded
  ins.run("c4", 1, "Set Appointment", "2026-06-23 05:00:00");
  // Out of window (after end, space format) — excluded
  ins.run("c5", 1, "Set Appointment", "2026-06-24 08:00:00");
});

describe("digest PhoneBurner window — format-robust", () => {
  it("counts space-format AND iso-format rows inside the window; excludes outside", () => {
    const m = loadPhoneBurnerMetrics(START, END);
    expect(m.total).toBe(3);       // c1, c2, c3 — c4/c5 out of window
    expect(m.connected).toBe(2);   // c1, c3
    expect(m.interested).toBe(1);  // c1 (Set Appointment), in-window only
  });

  it("a window with no rows returns zeros (not a crash)", () => {
    const m = loadPhoneBurnerMetrics("2020-01-01T00:00:00.000Z", "2020-01-02T00:00:00.000Z");
    expect(m).toEqual({ total: 0, connected: 0, interested: 0 });
  });
});
