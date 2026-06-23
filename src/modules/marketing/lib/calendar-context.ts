/**
 * Resolves marketing calendar events into a string block that
 * gets injected into the AI prompt. Used by generate-copy +
 * generate-image-prompts + plan_week.
 *
 * Why pre-format here rather than in the prompt: the prompt
 * template is markdown-stable; the events are highly structured
 * (type-prefixed, date-formatted, priority-marked). Building
 * the string once + dropping it into a {{calendarEvents}} slot
 * is cleaner than asking Claude to walk a JSON blob.
 *
 * Window: by default we look at scheduledDate ± 14 days. Events
 * outside that window don't influence the campaign — different
 * Mondays can't credibly anchor to Christmas in May.
 */

import { db } from "@/lib/db";
import { calendarEvents } from "@/modules/marketing/schema";
import { and, asc, gte, lte } from "drizzle-orm";

function plusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function loadRelevantEvents(opts: {
  scheduledDate: string;       // ISO YYYY-MM-DD — the campaign send date
  audience: "retail" | "wholesale";
  windowDays?: number;          // half-width of the window around scheduledDate
}) {
  const half = opts.windowDays ?? 14;
  const from = plusDays(opts.scheduledDate, -half);
  const to = plusDays(opts.scheduledDate, half);

  // Overlap: event.dateStart ≤ to AND event.dateEnd ≥ from
  const all = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        lte(calendarEvents.dateStart, to),
        gte(calendarEvents.dateEnd, from),
      ),
    )
    .orderBy(asc(calendarEvents.dateStart));

  // Audience narrowing: 'all' applies to both; otherwise it must match.
  return all.filter(e => e.audience === "all" || e.audience === opts.audience);
}

/**
 * Format a list of events for prompt injection. Empty list returns
 * a "(none)" string so the prompt template still resolves cleanly
 * with no conditional logic.
 */
export function formatEventsForPrompt(events: Awaited<ReturnType<typeof loadRelevantEvents>>): string {
  if (events.length === 0) return "(none in the ±14-day window)";

  const TYPE_LABEL: Record<string, string> = {
    holiday: "HOLIDAY",
    sale: "SALE",
    launch: "LAUNCH",
    promotion: "PROMO",
  };

  const lines = events.map(e => {
    const dateRange = e.dateStart === e.dateEnd
      ? e.dateStart
      : `${e.dateStart} → ${e.dateEnd}`;
    const priority = e.priority === 1
      ? " [PRIMARY — lead with this]"
      : e.priority === 3
        ? " [background — only if natural]"
        : "";
    const type = TYPE_LABEL[e.eventType] ?? e.eventType.toUpperCase();
    const desc = e.description ? `\n     ${e.description}` : "";
    const skus = e.productSkus ? `\n     SKUs: ${e.productSkus}` : "";
    const link = e.linkUrl ? `\n     Link: ${e.linkUrl}` : "";
    return `   - [${type}] ${dateRange} — ${e.title}${priority}${desc}${skus}${link}`;
  });

  return lines.join("\n");
}

/** Convenience: load + format in one call. */
export async function getCalendarContextForCampaign(opts: {
  scheduledDate: string;
  audience: "retail" | "wholesale";
}): Promise<string> {
  const events = await loadRelevantEvents(opts);
  return formatEventsForPrompt(events);
}

/**
 * Load events overlapping an arbitrary date range — used by the
 * monthly planner where the window isn't ±14 days from a single
 * date but rather a multi-week span.
 */
export async function loadEventsInRange(opts: {
  startDate: string;
  endDate: string;
  audience: "retail" | "wholesale";
}) {
  const all = await db
    .select()
    .from(calendarEvents)
    .where(
      and(
        lte(calendarEvents.dateStart, opts.endDate),
        gte(calendarEvents.dateEnd, opts.startDate),
      ),
    )
    .orderBy(asc(calendarEvents.dateStart));
  return all.filter(e => e.audience === "all" || e.audience === opts.audience);
}

export async function getCalendarContextForRange(opts: {
  startDate: string;
  endDate: string;
  audience: "retail" | "wholesale";
}): Promise<string> {
  const events = await loadEventsInRange(opts);
  return formatEventsForPrompt(events);
}
