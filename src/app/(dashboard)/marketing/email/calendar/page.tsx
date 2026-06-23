"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight } from "lucide-react";

type Campaign = {
  id: string;
  audience: "retail" | "wholesale";
  scheduledDate: string;
  status: string;
  name: string | null;
  subject: string | null;
  heroHeadline: string | null;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Coarse status → dot color (greens = further along). Keys match the
// kanban statuses in the campaign workflow.
const STATUS_DOT: Record<string, string> = {
  draft: "bg-muted-foreground/40",
  copywriting: "bg-amber-500",
  photography: "bg-blue-500",
  design_review: "bg-violet-500",
  scheduled: "bg-teal-500",
  sent: "bg-green-600",
  analyzed: "bg-green-700",
};

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function EmailCalendarPage() {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const year = cursor.getUTCFullYear();
  const month = cursor.getUTCMonth();

  // The grid spans from the Monday on/before the 1st to the Sunday
  // on/after the last day.
  const { gridStart, weeks } = useMemo(() => {
    const first = new Date(Date.UTC(year, month, 1));
    const firstDow = (first.getUTCDay() + 6) % 7; // 0 = Monday
    const start = new Date(first);
    start.setUTCDate(first.getUTCDate() - firstDow);
    const last = new Date(Date.UTC(year, month + 1, 0));
    const lastDow = (last.getUTCDay() + 6) % 7;
    const end = new Date(last);
    end.setUTCDate(last.getUTCDate() + (6 - lastDow));
    const totalDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    return { gridStart: start, weeks: Math.ceil(totalDays / 7) };
  }, [year, month]);

  useEffect(() => {
    setLoading(true);
    const from = iso(gridStart);
    const to = iso(new Date(gridStart.getTime() + (weeks * 7 - 1) * 86400000));
    fetch(`/api/v1/marketing/email/campaigns?from=${from}&to=${to}&order=date_asc`)
      .then((r) => r.json())
      .then((d) => {
        setCampaigns(d.campaigns ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [gridStart, weeks]);

  const byDay = useMemo(() => {
    const map: Record<string, Campaign[]> = {};
    for (const c of campaigns) {
      (map[c.scheduledDate] ??= []).push(c);
    }
    return map;
  }, [campaigns]);

  const monthLabel = cursor.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const todayIso = iso(new Date());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Email Calendar</h1>
          <p className="text-muted-foreground">Month view of the send cadence — retail Mon/Thu, wholesale Tue/Fri.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setCursor(new Date(Date.UTC(year, month - 1, 1)))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="text-sm font-medium w-40 text-center">{monthLabel}</div>
          <Button variant="outline" size="icon" onClick={() => setCursor(new Date(Date.UTC(year, month + 1, 1)))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => { const d = new Date(); setCursor(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); }}>
            Today
          </Button>
          <Link href="/marketing/email"><Button variant="outline" size="sm">Dashboard</Button></Link>
        </div>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-7 gap-px text-xs font-medium text-muted-foreground mb-1">
            {DAY_LABELS.map((d) => <div key={d} className="px-2 py-1">{d}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-px bg-border rounded overflow-hidden">
            {Array.from({ length: weeks * 7 }).map((_, i) => {
              const day = new Date(gridStart.getTime() + i * 86400000);
              const dayIso = iso(day);
              const inMonth = day.getUTCMonth() === month;
              const items = byDay[dayIso] ?? [];
              return (
                <div
                  key={dayIso}
                  className={`min-h-[92px] bg-background p-1.5 ${inMonth ? "" : "opacity-40"} ${dayIso === todayIso ? "ring-1 ring-inset ring-foreground" : ""}`}
                >
                  <div className="text-xs text-muted-foreground mb-1">{day.getUTCDate()}</div>
                  <div className="space-y-1">
                    {items.map((c) => (
                      <Link
                        key={c.id}
                        href={`/marketing/email/campaigns/${c.id}`}
                        className="block rounded border px-1.5 py-1 hover:bg-accent text-[11px] leading-tight"
                        title={`${c.audience} · ${c.status}`}
                      >
                        <div className="flex items-center gap-1">
                          <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[c.status] ?? "bg-muted-foreground"}`} />
                          <span className={`shrink-0 px-1 rounded text-[9px] uppercase tracking-wide ${c.audience === "wholesale" ? "bg-foreground text-background" : "border"}`}>
                            {c.audience === "wholesale" ? "W" : "R"}
                          </span>
                          <span className="truncate">{c.name ?? c.subject ?? c.heroHeadline ?? "(untitled)"}</span>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {loading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {Object.entries(STATUS_DOT).map(([s, cls]) => (
          <div key={s} className="flex items-center gap-1">
            <span className={`inline-block w-2 h-2 rounded-full ${cls}`} />
            {s.replace(/_/g, " ")}
          </div>
        ))}
      </div>
    </div>
  );
}
