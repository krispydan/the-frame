/**
 * Prospect detail page activity timeline.
 *
 * Renders the activity_feed entries for a single company in a
 * CRM-style timeline with date grouping, per-event icons + colors,
 * source attribution, and filtering.
 *
 * Companion to (but distinct from)
 * src/modules/sales/components/activity-timeline.tsx — that one is
 * deal-flavored and includes an Add Activity form. This one is
 * read-only and tuned for the broader prospect event mix
 * (Instantly + PhoneBurner + manual changes).
 */
"use client";
import { useMemo, useState } from "react";
import { formatDistanceToNow, format, parseISO, isToday, isYesterday, differenceInDays } from "date-fns";
import {
  Mail, MailOpen, MousePointerClick, MessageSquare, MessageCircleDashed,
  CheckCircle2, XCircle, Clock, EyeOff, Phone, PhoneCall, PhoneOff,
  RefreshCw, StickyNote, Pencil, UserPlus, Flag, Inbox, Send,
  CalendarCheck, AlertTriangle, type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

export interface Activity {
  id: string;
  event_type: string;
  module?: string;
  entity_type?: string;
  entity_id?: string;
  data: string | null;
  user_id?: string | null;
  created_at: string;
}

// ── Event catalog ───────────────────────────────────────────────────
// Single source of truth for how every event_type renders. Adding a
// new event = one row here.

type EventCategory = "outreach" | "reply" | "status" | "note" | "system";
type EventColor = "green" | "blue" | "amber" | "red" | "gray";
type EventSource = "instantly" | "phoneburner" | "manual" | "system";

interface EventSpec {
  icon: LucideIcon;
  color: EventColor;
  category: EventCategory;
  source: EventSource;
  /**
   * Render the body — returns a short human-readable string. Receives
   * the parsed `data` blob. Snippet content (reply bodies, call notes)
   * comes out via `snippet` instead so the component can render it in
   * a quote block.
   */
  render: (data: Record<string, unknown>) => { body: React.ReactNode; snippet?: string };
}

const camp = (d: Record<string, unknown>) =>
  (d.campaign_name as string) || (d.campaign as string) || "campaign";

const EVENT_CATALOG: Record<string, EventSpec> = {
  // ── Instantly: email lifecycle
  instantly_email_sent: {
    icon: Send, color: "blue", category: "outreach", source: "instantly",
    render: (d) => ({
      body: <>Email sent in <span className="font-medium">{camp(d)}</span>{d.step != null ? <span className="text-gray-500"> · step {String(d.step)}</span> : null}</>,
    }),
  },
  instantly_email_opened: {
    icon: MailOpen, color: "blue", category: "outreach", source: "instantly",
    render: (d) => ({
      body: <>Opened {d.email_subject ? <em>“{String(d.email_subject)}”</em> : <>email</>} in {camp(d)}</>,
    }),
  },
  instantly_email_link_clicked: {
    icon: MousePointerClick, color: "blue", category: "outreach", source: "instantly",
    render: (d) => ({ body: <>Clicked link in {camp(d)}</> }),
  },
  instantly_email_bounced: {
    icon: AlertTriangle, color: "red", category: "outreach", source: "instantly",
    render: (d) => ({ body: <>Email bounced in {camp(d)}</> }),
  },

  // ── Instantly: replies + lead labels
  instantly_reply_received: {
    icon: MessageSquare, color: "green", category: "reply", source: "instantly",
    render: (d) => ({
      body: <><span className="font-medium">Replied</span> in {camp(d)}</>,
      snippet: (d.reply_snippet as string) || undefined,
    }),
  },
  instantly_lead_interested: {
    icon: CheckCircle2, color: "green", category: "status", source: "instantly",
    render: (d) => ({ body: <><span className="font-medium">Marked Interested</span> in {camp(d)}</> }),
  },
  instantly_lead_not_interested: {
    icon: XCircle, color: "red", category: "status", source: "instantly",
    render: (d) => ({ body: <>Marked Not Interested in {camp(d)}</> }),
  },
  instantly_lead_out_of_office: {
    icon: MessageCircleDashed, color: "amber", category: "reply", source: "instantly",
    render: (d) => ({ body: <>Out of office ({camp(d)})</> }),
  },
  instantly_lead_wrong_person: {
    icon: MessageCircleDashed, color: "amber", category: "reply", source: "instantly",
    render: (d) => ({ body: <>Wrong person ({camp(d)})</> }),
  },
  instantly_lead_neutral: {
    icon: MessageSquare, color: "gray", category: "reply", source: "instantly",
    render: (d) => ({ body: <>Neutral reply ({camp(d)})</> }),
  },
  instantly_lead_no_show: {
    icon: PhoneOff, color: "amber", category: "status", source: "instantly",
    render: (d) => ({ body: <>Meeting no-show ({camp(d)})</> }),
  },
  instantly_lead_meeting_booked: {
    icon: CalendarCheck, color: "green", category: "status", source: "instantly",
    render: (d) => ({ body: <><span className="font-medium">Meeting booked</span> ({camp(d)})</> }),
  },
  instantly_lead_meeting_completed: {
    icon: CheckCircle2, color: "green", category: "status", source: "instantly",
    render: (d) => ({ body: <>Meeting completed ({camp(d)})</> }),
  },
  instantly_lead_unsubscribed: {
    icon: XCircle, color: "red", category: "status", source: "instantly",
    render: (d) => ({ body: <>Unsubscribed from {camp(d)}</> }),
  },
  instantly_campaign_completed: {
    icon: Flag, color: "gray", category: "system", source: "instantly",
    render: (d) => ({ body: <>Campaign completed: {camp(d)}</> }),
  },

  // ── PhoneBurner
  phoneburner_call_completed: {
    icon: Phone, color: "blue", category: "outreach", source: "phoneburner",
    render: (d) => {
      const disp = d.disposition_label as string | undefined;
      const dur = d.duration_seconds as number | undefined;
      const durFmt = dur != null ? ` · ${Math.floor(dur / 60)}m ${dur % 60}s` : "";
      return {
        body: <>Call: <span className="font-medium">{disp ?? "completed"}</span><span className="text-gray-500">{durFmt}</span></>,
        snippet: (d.notes as string) || undefined,
      };
    },
  },
  phoneburner_call_started: {
    icon: PhoneCall, color: "blue", category: "outreach", source: "phoneburner",
    render: () => ({ body: <>Dialing…</> }),
  },
  phoneburner_contact_displayed: {
    icon: Inbox, color: "gray", category: "system", source: "phoneburner",
    render: () => ({ body: <>Viewed in PhoneBurner</> }),
  },
  phoneburner_email_unsubscribed: {
    icon: XCircle, color: "red", category: "status", source: "phoneburner",
    render: () => ({ body: <>Unsubscribed via PhoneBurner</> }),
  },
  phoneburner_appointment_scheduled: {
    icon: CalendarCheck, color: "green", category: "status", source: "phoneburner",
    render: () => ({ body: <><span className="font-medium">Appointment scheduled</span></> }),
  },
  phoneburner_task_created: {
    icon: StickyNote, color: "gray", category: "note", source: "phoneburner",
    render: () => ({ body: <>Task created</> }),
  },
  phoneburner_manual_trigger: {
    icon: Flag, color: "amber", category: "system", source: "phoneburner",
    render: () => ({ body: <>Manual trigger</> }),
  },

  // ── Manual + system
  change: {
    icon: Pencil, color: "gray", category: "note", source: "system",
    render: (d) => {
      const field = String(d.field ?? "field");
      const oldV = d.old != null ? String(d.old).slice(0, 40) : null;
      const newV = d.new != null ? String(d.new).slice(0, 40) : null;
      return {
        body: <>
          <span className="font-medium">{field}</span>
          {oldV ? <> changed from <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{oldV}</code></> : null}
          {newV ? <> to <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">{newV}</code></> : null}
        </>,
      };
    },
  },
  company_updated: {
    icon: RefreshCw, color: "gray", category: "note", source: "manual",
    render: () => ({ body: <>Company details updated</> }),
  },
  contact_created: {
    icon: UserPlus, color: "blue", category: "note", source: "manual",
    render: (d) => ({ body: <>Contact added{d.contact_name ? <> — {String(d.contact_name)}</> : null}</> }),
  },
  status_change: {
    icon: RefreshCw, color: "gray", category: "status", source: "manual",
    render: (d) => {
      const from = d.from ? String(d.from) : null;
      const to = d.to ? String(d.to) : null;
      return {
        body: <>Status changed{from && to ? <> from <strong>{from}</strong> to <strong>{to}</strong></> : null}</>,
      };
    },
  },
};

const FALLBACK_SPEC: EventSpec = {
  icon: Clock, color: "gray", category: "system", source: "system",
  render: () => ({ body: <span className="text-gray-500">event</span> }),
};

function specFor(eventType: string): EventSpec {
  return EVENT_CATALOG[eventType] ?? FALLBACK_SPEC;
}

// ── Visual layer ────────────────────────────────────────────────────

const ICON_COLOR_CLASSES: Record<EventColor, string> = {
  green: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  red: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  gray: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const SOURCE_LABELS: Record<EventSource, string> = {
  instantly: "Instantly",
  phoneburner: "PhoneBurner",
  manual: "Manual",
  system: "System",
};

// ── Date bucketing ──────────────────────────────────────────────────

interface Bucket {
  label: string;
  activities: Activity[];
}

function bucketByDate(activities: Activity[]): Bucket[] {
  const now = new Date();
  const buckets: Record<string, Activity[]> = {};
  const order: string[] = [];

  for (const a of activities) {
    if (!a.created_at) continue;
    let d: Date;
    try {
      // activity_feed timestamps lack timezone; treat as UTC for parsing
      d = parseISO(a.created_at.endsWith("Z") ? a.created_at : `${a.created_at}Z`);
      if (Number.isNaN(d.getTime())) continue;
    } catch {
      continue;
    }
    let label: string;
    if (isToday(d)) label = "Today";
    else if (isYesterday(d)) label = "Yesterday";
    else {
      const days = differenceInDays(now, d);
      if (days <= 7) label = "This Week";
      else if (days <= 30) label = "This Month";
      else label = "Earlier";
    }
    if (!(label in buckets)) {
      buckets[label] = [];
      order.push(label);
    }
    buckets[label].push(a);
  }
  return order.map((label) => ({ label, activities: buckets[label] }));
}

// ── Sub-components ──────────────────────────────────────────────────

function TimelineSnippet({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 240;
  const display = expanded || !long ? text : `${text.slice(0, 240)}…`;
  return (
    <div className="mt-1 text-xs text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/40 border-l-2 border-gray-300 dark:border-gray-700 pl-2 py-1 whitespace-pre-wrap">
      {display}
      {long && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="ml-1 text-blue-600 dark:text-blue-400 hover:underline text-xs"
        >
          {expanded ? "show less" : "show full"}
        </button>
      )}
    </div>
  );
}

interface RowProps {
  activity: Activity;
  spec: EventSpec;
  data: Record<string, unknown>;
}

function TimelineRow({ activity, spec, data }: RowProps) {
  const Icon = spec.icon;
  const { body, snippet } = spec.render(data);
  let absolute = "";
  try {
    const d = parseISO(
      activity.created_at.endsWith("Z") ? activity.created_at : `${activity.created_at}Z`,
    );
    absolute = format(d, "MMM d, yyyy 'at' h:mm a");
  } catch {
    absolute = activity.created_at;
  }
  const relative = (() => {
    try {
      return formatDistanceToNow(
        parseISO(activity.created_at.endsWith("Z") ? activity.created_at : `${activity.created_at}Z`),
        { addSuffix: true },
      );
    } catch {
      return "";
    }
  })();
  return (
    <div className="flex gap-3 py-2.5">
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${ICON_COLOR_CLASSES[spec.color]}`}
      >
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <div className="text-sm text-gray-800 dark:text-gray-200 flex-1 min-w-0">{body}</div>
          <Badge variant="outline" className="text-[10px] uppercase tracking-wide shrink-0">
            {SOURCE_LABELS[spec.source]}
          </Badge>
        </div>
        {snippet ? <TimelineSnippet text={snippet} /> : null}
        <div
          className="text-xs text-gray-400 dark:text-gray-500 mt-1"
          title={absolute}
        >
          {relative}
        </div>
      </div>
    </div>
  );
}

// ── Top-level component ─────────────────────────────────────────────

type FilterKey = "all" | "outreach" | "reply" | "status" | "note";

const FILTERS: { key: FilterKey; label: string; categories: EventCategory[] | null }[] = [
  { key: "all",      label: "All",      categories: null },
  { key: "outreach", label: "Outreach", categories: ["outreach"] },
  { key: "reply",    label: "Replies",  categories: ["reply"] },
  { key: "status",   label: "Status",   categories: ["status"] },
  { key: "note",     label: "Notes",    categories: ["note", "system"] },
];

const INITIAL_VISIBLE = 30;

export function ProspectActivityTimeline({
  activities,
  emptyHint,
}: {
  activities: Activity[];
  /**
   * Optional rich empty-state. Falls back to a plain "No activity yet"
   * message when not provided. Caller typically passes a
   * company-status-aware CTA so unsent prospects get a meaningful
   * action instead of dead text.
   */
  emptyHint?: React.ReactNode;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    const filterSpec = FILTERS.find((f) => f.key === filter);
    if (!filterSpec || !filterSpec.categories) return activities;
    const cats = new Set(filterSpec.categories);
    return activities.filter((a) => cats.has(specFor(a.event_type).category));
  }, [activities, filter]);

  const visible = showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE);
  const buckets = useMemo(() => bucketByDate(visible), [visible]);
  const hiddenCount = Math.max(0, filtered.length - visible.length);

  if (activities.length === 0) {
    return (
      <>
        {emptyHint ?? (
          <div className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
            No activity yet
          </div>
        )}
      </>
    );
  }

  return (
    <div>
      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5 mb-3 pb-3 border-b dark:border-gray-800">
        {FILTERS.map((f) => {
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key);
                setShowAll(false);
              }}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition ${
                isActive
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* Filtered-empty state */}
      {filtered.length === 0 ? (
        <div className="text-sm text-gray-400 dark:text-gray-500 py-6 text-center">
          No activity matching this filter
        </div>
      ) : (
        <div className="space-y-4">
          {buckets.map((b) => (
            <div key={b.label}>
              <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
                {b.label}
              </div>
              <div className="divide-y dark:divide-gray-800">
                {b.activities.map((a) => {
                  let data: Record<string, unknown> = {};
                  try {
                    data = a.data ? (JSON.parse(a.data as string) as Record<string, unknown>) : {};
                  } catch { /* leave empty */ }
                  return (
                    <TimelineRow
                      key={a.id}
                      activity={a}
                      spec={specFor(a.event_type)}
                      data={data}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full mt-3 py-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-800 rounded transition"
        >
          Show {hiddenCount} older event{hiddenCount === 1 ? "" : "s"}
        </button>
      )}
    </div>
  );
}
