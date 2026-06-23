"use client";

/**
 * Marketing calendar — the "what's coming up" register that AI
 * consults when drafting campaign copy.
 *
 * Layout: simple ordered list by date_start ASC, grouped by month.
 * Each event card shows type/audience/title/date-range/description
 * + edit + delete affordances. A "+ Add event" button opens a
 * modal with the create form.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, Calendar as CalendarIcon, RefreshCw } from "lucide-react";

interface CalendarEvent {
  id: string;
  eventType: "holiday" | "sale" | "launch" | "promotion";
  dateStart: string;
  dateEnd: string;
  audience: "all" | "retail" | "wholesale";
  title: string;
  description: string | null;
  productSkus: string | null;
  linkUrl: string | null;
  priority: number;
  tag: string | null;
}

const TYPE_COLORS: Record<string, string> = {
  holiday: "bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100",
  sale: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  launch: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  promotion: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
};

const TYPE_LABELS: Record<string, string> = {
  holiday: "Holiday",
  sale: "Sale",
  launch: "Launch",
  promotion: "Promo",
};

function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
function formatDateRange(start: string, end: string): string {
  if (start === end) return new Date(start + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `${new Date(start + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${new Date(end + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

export default function CalendarPage() {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [audienceFilter, setAudienceFilter] = useState<string>("");

  const load = useCallback(() => {
    setLoading(true);
    // 12-month window so the calendar shows the full upcoming year
    const today = new Date().toISOString().slice(0, 10);
    const toDate = new Date();
    toDate.setFullYear(toDate.getFullYear() + 1);
    const to = toDate.toISOString().slice(0, 10);
    const qs = new URLSearchParams({ from: today, to });
    if (typeFilter) qs.set("event_type", typeFilter);
    if (audienceFilter) qs.set("audience", audienceFilter);
    fetch(`/api/v1/marketing/calendar/events?${qs.toString()}`)
      .then(r => r.json())
      .then(data => {
        setEvents(data.events ?? []);
        setLoading(false);
      });
  }, [typeFilter, audienceFilter]);

  useEffect(() => { load(); }, [load]);

  async function deleteEvent(id: string) {
    if (!confirm("Delete this calendar event?")) return;
    await fetch(`/api/v1/marketing/calendar/events/${id}`, { method: "DELETE" });
    load();
  }

  // Group events by month
  const byMonth = events.reduce<Record<string, CalendarEvent[]>>((acc, e) => {
    const key = monthKey(e.dateStart);
    (acc[key] = acc[key] ?? []).push(e);
    return acc;
  }, {});
  const monthKeys = Object.keys(byMonth).sort();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Marketing calendar</h1>
          <p className="text-muted-foreground">
            Holidays, sales, launches + promotions. Auto-injected into
            email AI when a campaign&apos;s scheduled date falls within ±14
            days of an event.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/marketing/email">
            <Button variant="outline" size="sm">← Email assistant</Button>
          </Link>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={() => setModalOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add event
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <span className="text-muted-foreground text-xs">Filter:</span>
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All types</option>
          <option value="holiday">Holidays</option>
          <option value="sale">Sales</option>
          <option value="launch">Launches</option>
          <option value="promotion">Promotions</option>
        </select>
        <select
          value={audienceFilter}
          onChange={e => setAudienceFilter(e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All audiences</option>
          <option value="retail">Retail only</option>
          <option value="wholesale">Wholesale only</option>
        </select>
        <span className="text-muted-foreground text-xs ml-auto">
          {events.length} event{events.length === 1 ? "" : "s"} in the next 12 months
        </span>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading calendar…</div>
      ) : monthKeys.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <CalendarIcon className="h-8 w-8 mx-auto mb-2 opacity-50" />
            No upcoming events. Add holidays, sales, launches, or promotions to
            give the AI more context for email generation.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {monthKeys.map(mk => (
            <div key={mk}>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                {monthLabel(mk)}
              </h2>
              <div className="space-y-2">
                {byMonth[mk].map(e => (
                  <EventCard key={e.id} event={e} onDelete={() => deleteEvent(e.id)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <AddEventModal
          onClose={() => setModalOpen(false)}
          onCreated={() => { setModalOpen(false); load(); }}
        />
      )}
    </div>
  );
}

function EventCard({ event, onDelete }: { event: CalendarEvent; onDelete: () => void }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className={`text-xs ${TYPE_COLORS[event.eventType]}`}>
                {TYPE_LABELS[event.eventType]}
              </Badge>
              {event.audience !== "all" && (
                <Badge variant="outline" className="text-xs">{event.audience}</Badge>
              )}
              {event.priority === 1 && (
                <Badge variant="default" className="text-xs">★ Primary</Badge>
              )}
              {event.priority === 3 && (
                <Badge variant="outline" className="text-xs opacity-60">Background</Badge>
              )}
              {event.tag && (
                <Badge variant="outline" className="text-xs">#{event.tag}</Badge>
              )}
            </div>
            <div className="font-medium mt-1.5">{event.title}</div>
            <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
              {formatDateRange(event.dateStart, event.dateEnd)}
            </div>
            {event.description && (
              <div className="text-xs text-muted-foreground mt-2">{event.description}</div>
            )}
            {event.productSkus && (
              <div className="text-xs text-muted-foreground mt-1">
                <strong>SKUs:</strong> <code className="text-[10px]">{event.productSkus}</code>
              </div>
            )}
            {event.linkUrl && (
              <a href={event.linkUrl} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground hover:text-foreground mt-1 inline-block">
                {event.linkUrl}
              </a>
            )}
          </div>
          <button
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
            title="Delete event"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function AddEventModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    eventType: "promotion" as "holiday" | "sale" | "launch" | "promotion",
    dateStart: today,
    dateEnd: today,
    audience: "all" as "all" | "retail" | "wholesale",
    title: "",
    description: "",
    productSkus: "",
    linkUrl: "",
    priority: 2,
    tag: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Escape closes (with confirm if dirty). Body scroll lock while open.
  useEffect(() => {
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (!dirty || confirm("Discard this event?")) onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = origOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [dirty, onClose]);

  function attemptClose() {
    if (!dirty || confirm("Discard this event?")) onClose();
  }

  function update<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm(f => ({ ...f, [k]: v }));
    setDirty(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/marketing/calendar/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          dateEnd: form.dateEnd || form.dateStart,
          description: form.description || undefined,
          productSkus: form.productSkus || undefined,
          linkUrl: form.linkUrl || undefined,
          tag: form.tag || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={attemptClose}>
      <div
        className="bg-background border rounded-lg max-w-xl w-full max-h-[90vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <form onSubmit={submit} className="p-6 space-y-4">
          <div>
            <h2 className="text-xl font-semibold">Add calendar event</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Once added, any campaign scheduled within ±14 days will see this in
              the AI prompt.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Type</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.eventType}
                onChange={e => update("eventType", e.target.value as typeof form.eventType)}
              >
                <option value="holiday">Holiday</option>
                <option value="sale">Sale</option>
                <option value="launch">Launch</option>
                <option value="promotion">Promotion</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Audience</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.audience}
                onChange={e => update("audience", e.target.value as typeof form.audience)}
              >
                <option value="all">Both</option>
                <option value="retail">Retail only</option>
                <option value="wholesale">Wholesale only</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date start</label>
              <input
                type="date"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.dateStart}
                onChange={e => update("dateStart", e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date end (optional)</label>
              <input
                type="date"
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.dateEnd}
                onChange={e => update("dateEnd", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">Title</label>
            <input
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              placeholder="e.g. Memorial Day 30% off readers"
              value={form.title}
              onChange={e => update("title", e.target.value)}
              required
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">Description (1–3 sentences for the AI)</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              rows={3}
              placeholder="30% off all readers, sitewide. Final 48 hours hard sell — emphasize the deadline."
              value={form.description}
              onChange={e => update("description", e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Product SKUs (optional)</label>
              <input
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                placeholder="JX-001,JX-002"
                value={form.productSkus}
                onChange={e => update("productSkus", e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Link URL (optional)</label>
              <input
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                placeholder="https://getjaxy.com/collections/readers"
                value={form.linkUrl}
                onChange={e => update("linkUrl", e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Priority</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.priority}
                onChange={e => update("priority", parseInt(e.target.value))}
              >
                <option value={1}>1 — Primary (lead with this)</option>
                <option value={2}>2 — Secondary (mention if natural)</option>
                <option value={3}>3 — Background (FYI only)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Tag (optional)</label>
              <input
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                placeholder="BFCM-2026"
                value={form.tag}
                onChange={e => update("tag", e.target.value)}
              />
            </div>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={attemptClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add to calendar"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
