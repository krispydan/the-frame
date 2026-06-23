/**
 * Marketing calendar — the "what's coming up" register that AI
 * consults when drafting campaign copy.
 *
 * Holidays, sales, product launches, promotions all live in one
 * table differentiated by event_type. AI generate-copy + plan_week
 * call list_events(date_window) and pass the results into the
 * brief so the copy can lean into the right moment.
 *
 * Example: a campaign scheduled 2026-09-04 with a Labor Day event
 * spanning 2026-09-01..2026-09-07 in the window → AI knows to angle
 * toward "Labor Day road trip" rather than generic September copy.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());

export const calendarEvents = sqliteTable(
  "marketing_calendar_events",
  {
    id: id(),

    /** What kind of event drives the copy angle:
     *   holiday    — federal / cultural / observance
     *   sale       — markdown windows (BFCM, Cyber Monday, EOSS)
     *   launch     — new product / colorway drop
     *   promotion  — bundle / freebie / loyalty offer
     */
    eventType: text("event_type", {
      enum: ["holiday", "sale", "launch", "promotion"],
    }).notNull(),

    /** Date window the event is active. Single-day events use
     *  dateStart === dateEnd. */
    dateStart: text("date_start").notNull(),  // ISO YYYY-MM-DD
    dateEnd: text("date_end").notNull(),      // ISO YYYY-MM-DD (inclusive)

    /** Who the event matters for. `all` = both audiences. */
    audience: text("audience", { enum: ["all", "retail", "wholesale"] })
      .notNull()
      .default("all"),

    /** Short title shown on calendar + injected into AI prompt.
     *  Keep it concrete: "Labor Day" not "long weekend." */
    title: text("title").notNull(),

    /** 1–3 sentences of additional context the AI should weigh.
     *  Example for a sale: "30% off all readers, sitewide. Final 48
     *  hours hard sell." Example for a launch: "Honey colorway —
     *  caramel-amber tortoise, our warmest tone ever, limited run." */
    description: text("description"),

    /** Optional comma-separated SKU list — lets the AI pull the
     *  exact product into the brief. */
    productSkus: text("product_skus"),

    /** Optional URL the campaign CTA could link to. */
    linkUrl: text("link_url"),

    /** 1 = primary moment (lean hard into it), 2 = secondary
     *  (mention if natural), 3 = background (FYI only). */
    priority: integer("priority").notNull().default(2),

    /** Tag for filtering on the calendar UI (e.g. "EOSS",
     *  "BFCM-2026", "Q4-launches"). */
    tag: text("tag"),

    createdAt: text("created_at").default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_calendar_date_start").on(table.dateStart),
    index("idx_calendar_audience").on(table.audience),
    index("idx_calendar_event_type").on(table.eventType),
  ],
);

export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type CalendarEventInsert = typeof calendarEvents.$inferInsert;
