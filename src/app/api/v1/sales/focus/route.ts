export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { sqlite } from "@/lib/db";

export async function GET() {
  // Snoozed deals waking today
  const wakingToday = sqlite.prepare(`
    SELECT d.id, d.title, d.stage, d.snooze_reason, d.value, c.name as company_name
    FROM deals d LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.snooze_until IS NOT NULL 
    AND date(d.snooze_until) <= date('now')
    AND d.snooze_until > datetime('now', '-1 day')
    ORDER BY d.snooze_until ASC
  `).all();

  // Reorder reminders due
  const reorderDue = sqlite.prepare(`
    SELECT d.id, d.title, d.value, d.reorder_due_at, c.name as company_name
    FROM deals d LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.reorder_due_at IS NOT NULL 
    AND d.reorder_due_at <= datetime('now', '+14 days')
    AND d.stage = 'order_placed'
    ORDER BY d.reorder_due_at ASC
    LIMIT 10
  `).all();

  // Deals with no activity in 7+ days
  const stale = sqlite.prepare(`
    SELECT d.id, d.title, d.stage, d.last_activity_at, d.value, c.name as company_name
    FROM deals d LEFT JOIN companies c ON c.id = d.company_id
    WHERE d.last_activity_at < datetime('now', '-7 days')
    AND d.stage NOT IN ('order_placed', 'not_interested')
    AND (d.snooze_until IS NULL OR d.snooze_until <= datetime('now'))
    ORDER BY d.last_activity_at ASC
    LIMIT 10
  `).all();

  return NextResponse.json({ wakingToday, reorderDue, stale });
}
