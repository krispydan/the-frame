/**
 * Dashboard cache warmer — runs from the cron registry every 5 hours.
 *
 * Force-rebuilds the dashboard bundles for every role that actually has an
 * active user (owner sees everything; other roles get their filtered subset)
 * for the page's default range (30d), and stores them in both cache tiers.
 * Result: page loads are always an instant cache read; the 45s cold build
 * only ever happens here, in the background.
 *
 * Keys must mirror the API route exactly: dashboard:{role}:{range}:{part}.
 */
import { sqlite } from "@/lib/db";
import { buildDashboard, type Part, type Range } from "./metrics";
import { primeCache } from "./cache";

const WARM_RANGE: Range = "30d";
const WARM_PARTS: Part[] = ["core", "heavy"];

export async function warmDashboardCache(): Promise<{ warmed: string[]; ms: number }> {
  const t0 = Date.now();
  const roles = (sqlite.prepare(
    "SELECT DISTINCT role FROM users WHERE COALESCE(is_active, 1) = 1",
  ).all() as Array<{ role: string | null }>)
    .map((r) => r.role)
    .filter((r): r is string => !!r && r !== "ai"); // service accounts don't view dashboards
  if (!roles.includes("owner")) roles.push("owner");

  const warmed: string[] = [];
  for (const role of roles) {
    for (const part of WARM_PARTS) {
      const key = `dashboard:${role}:${WARM_RANGE}:${part}`;
      try {
        await primeCache(key, () => buildDashboard(role, WARM_RANGE, part));
        warmed.push(key);
      } catch (e) {
        console.error(`[dashboard-warm] ${key} failed:`, e instanceof Error ? e.message : e);
      }
      // Yield between builds so the event loop breathes (the builders are
      // largely synchronous better-sqlite3 scans).
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { warmed, ms: Date.now() - t0 };
}
