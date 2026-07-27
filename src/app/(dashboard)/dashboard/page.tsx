"use client";

/**
 * The Frame — main dashboard.
 *
 * A role-aware, customizable widget grid. Layout (which widgets, in what order)
 * is loaded from /api/v1/dashboard/layout (role default until the user
 * customizes) and the data bundle from /api/v1/dashboard?range=. Customize mode
 * lets the user drag to reorder, hide widgets, and re-add allowed ones;
 * changes persist per user. The server only returns datasets the role may see.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useUser } from "@/hooks/use-user";
import { Button } from "@/components/ui/button";
import { WidgetFrame } from "@/components/dashboard/widget-frame";
import { WIDGETS, SIZE_CLASS, groupByCategory, type WidgetId } from "@/modules/dashboard/widgets";
import { HEAVY_WIDGETS } from "@/modules/dashboard/lib/metrics";
import { KpiSkeleton, WidgetSkeleton } from "@/components/dashboard/skeletons";
import {
  type Bundle,
  KpisWidget, TargetsWidget, RevenueTrendWidget, ChannelMixWidget, TopSellersWidget, MoversWidget,
  InventoryHealthWidget, ReorderAlertsWidget, OutreachWidget, MetaLeadsWidget,
  PipelineWidget, CustomersWidget, FinanceWidget, BusinessHealthWidget, ActivityWidget,
} from "@/modules/dashboard/components/widgets";
import Link from "next/link";
import { RefreshCw, Settings2, RotateCcw, Plus, Check, ChevronDown, ArrowUpRight } from "lucide-react";

const COMPONENTS: Record<WidgetId, React.FC<{ data: Bundle }>> = {
  kpis: KpisWidget,
  targets: TargetsWidget,
  "revenue-trend": RevenueTrendWidget,
  "channel-mix": ChannelMixWidget,
  "top-sellers": TopSellersWidget,
  movers: MoversWidget,
  "inventory-health": InventoryHealthWidget,
  "reorder-alerts": ReorderAlertsWidget,
  outreach: OutreachWidget,
  "meta-leads": MetaLeadsWidget,
  pipeline: PipelineWidget,
  customers: CustomersWidget,
  finance: FinanceWidget,
  "business-health": BusinessHealthWidget,
  activity: ActivityWidget,
};

const RANGES: { id: string; label: string }[] = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "ytd", label: "YTD" },
];

export default function DashboardPage() {
  const { user } = useUser();
  const [range, setRange] = useState("30d");
  // Two-phase load: `core` is cheap indexed aggregates and paints the page;
  // `heavy` (product performance, FIFO P&L, business health) scans whole
  // tables and arrives behind per-card skeletons. Both are cached server-side.
  const [core, setCore] = useState<Bundle | null>(null);
  const [heavy, setHeavy] = useState<Bundle | null>(null);
  const [heavyPending, setHeavyPending] = useState(true);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState<WidgetId[]>([]);
  const [allowed, setAllowed] = useState<WidgetId[]>([]);
  const [customizing, setCustomizing] = useState(false);
  const [dragId, setDragId] = useState<WidgetId | null>(null);
  // Collapsed sections are a local viewing preference, not part of the shared
  // layout — keep them in localStorage rather than round-tripping to the API.
  const [collapsed, setCollapsed] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("dashboard:collapsed");
      if (raw) setCollapsed(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
  }, []);

  const toggleSection = (id: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id];
      try { localStorage.setItem("dashboard:collapsed", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // Load the user's layout once.
  useEffect(() => {
    fetch("/api/v1/dashboard/layout")
      .then((r) => r.json())
      .then((d) => {
        setLayout(d.layout ?? []);
        setAllowed(d.allowed ?? []);
      })
      .catch(() => {});
  }, []);

  const [nonce, setNonce] = useState(0);
  const loadData = useCallback(() => setNonce((n) => n + 1), []);

  // Both parts are requested in parallel; core resolves first and paints.
  // Nothing setStates synchronously in the effect body — state only settles in
  // the async continuations, so switching range keeps the old cards on screen
  // (stale-while-revalidate) instead of flashing an empty page.
  useEffect(() => {
    let cancelled = false;
    const fresh = nonce > 0 ? "&fresh=1" : "";

    (async () => {
      try {
        const res = await fetch(`/api/v1/dashboard?range=${range}&part=core${fresh}`);
        const d = await res.json();
        if (!cancelled) setCore(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    (async () => {
      try {
        const res = await fetch(`/api/v1/dashboard?range=${range}&part=heavy${fresh}`);
        const d = await res.json();
        if (!cancelled) setHeavy(d.error ? null : d);
      } catch { /* keep prior */ } finally {
        if (!cancelled) setHeavyPending(false);
      }
    })();

    return () => { cancelled = true; };
  }, [range, nonce]);

  // Merge the two payloads into the single bundle the widgets consume.
  const data = useMemo<Bundle | null>(() => {
    if (!core && !heavy) return null;
    const base = core ?? heavy!;
    return { ...base, widgets: { ...(core?.widgets ?? {}), ...(heavy?.widgets ?? {}) } };
  }, [core, heavy]);

  const persist = useCallback((next: WidgetId[]) => {
    setLayout(next);
    fetch("/api/v1/dashboard/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ widgets: next }),
    }).catch(() => {});
  }, []);

  const hide = (id: WidgetId) => persist(layout.filter((w) => w !== id));
  const add = (id: WidgetId) => persist([...layout, id]);
  const reset = () => {
    fetch("/api/v1/dashboard/layout", { method: "DELETE" })
      .then((r) => r.json())
      .then((d) => setLayout(d.layout ?? []))
      .catch(() => {});
  };

  const onDrop = (targetId: WidgetId) => {
    if (!dragId || dragId === targetId) return;
    const next = [...layout];
    const from = next.indexOf(dragId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setDragId(null);
    persist(next);
  };

  const hiddenAllowed = allowed.filter((id) => !layout.includes(id));
  const firstName = (user?.name || "").split(" ")[0];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {firstName ? `Welcome back, ${firstName}` : "Dashboard"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {greeting()} · here&apos;s how Jaxy is doing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${range === r.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadData}
            aria-label="Refresh"
            title={core?.cached ? "Showing cached figures — click to recompute" : "Refresh"}
          >
            <RefreshCw className={`h-4 w-4 ${loading || heavyPending ? "animate-spin" : ""}`} />
          </Button>
          <Button variant={customizing ? "default" : "outline"} size="sm" onClick={() => setCustomizing((v) => !v)}>
            {customizing ? <><Check className="mr-1 h-4 w-4" /> Done</> : <><Settings2 className="mr-1 h-4 w-4" /> Customize</>}
          </Button>
        </div>
      </div>

      {/* Customize toolbar */}
      {customizing && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm">
          <span className="font-medium">Drag to reorder · hide from each card.</span>
          {hiddenAllowed.length > 0 && (
            <>
              <span className="text-muted-foreground">Add:</span>
              {hiddenAllowed.map((id) => (
                <button
                  key={id}
                  onClick={() => add(id)}
                  className="inline-flex items-center gap-1 rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-muted"
                >
                  <Plus className="h-3 w-3" /> {WIDGETS[id].title}
                </button>
              ))}
            </>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset to default</Button>
        </div>
      )}

      {/* Grid */}
      {loading && !data ? (
        // First paint: mirror the real layout (KPI strip + a section of cards)
        // so nothing jumps when the data lands.
        <div className="space-y-6">
          <KpiSkeleton />
          <div className="space-y-3">
            <div className="flex items-center gap-2 border-b pb-1.5">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="rounded-xl border bg-card">
                  <div className="border-b px-4 py-2.5"><div className="h-4 w-28 animate-pulse rounded bg-muted" /></div>
                  <div className="p-4"><WidgetSkeleton widgetId="default" /></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {groupByCategory(layout).map(({ category, widgets }) => {
            const isCollapsed = collapsed.includes(category.id);
            return (
              <section key={category.id} className="space-y-3">
                {/* Section header — orientation + a way into the full area */}
                <div className="flex items-center gap-2 border-b pb-1.5">
                  <button
                    onClick={() => toggleSection(category.id)}
                    className="flex min-w-0 items-center gap-1.5 text-left"
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                    <span className="text-sm font-semibold">{category.title}</span>
                    <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {category.blurb}</span>
                  </button>
                  <div className="flex-1" />
                  {category.href && (
                    <Link
                      href={category.href}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      Open <ArrowUpRight className="h-3.5 w-3.5" />
                    </Link>
                  )}
                </div>

                {!isCollapsed && (
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {widgets.map((id) => {
                      const def = WIDGETS[id];
                      if (!def || !data) return null;
                      const Comp = COMPONENTS[id];
                      const spanClass = SIZE_CLASS[def.size];
                      const dragProps = customizing
                        ? {
                            draggable: true,
                            onDragStart: () => setDragId(id),
                            onDragOver: (e: React.DragEvent) => e.preventDefault(),
                            onDrop: () => onDrop(id),
                            onDragEnd: () => setDragId(null),
                          }
                        : {};

                      // A heavy widget whose payload hasn't arrived yet shows
                      // its own shaped skeleton rather than blocking the page.
                      const awaitingHeavy = HEAVY_WIDGETS.includes(id) && heavyPending && !heavy;

                      // KPI strip renders full-width without the card frame.
                      if (id === "kpis") {
                        return (
                          <div key={id} className={`${spanClass} ${dragId === id ? "opacity-50" : ""}`} {...dragProps}>
                            {customizing && (
                              <div className="mb-1 flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                                <span>⋮⋮ Key metrics</span>
                                <button onClick={() => hide(id)} className="hover:text-foreground">Hide</button>
                              </div>
                            )}
                            <Comp data={data} />
                          </div>
                        );
                      }

                      return (
                        <div key={id} className={`${spanClass} ${dragId === id ? "opacity-50" : ""}`} {...dragProps}>
                          <WidgetFrame
                            title={def.title}
                            subtitle={def.subtitle}
                            href={def.href}
                            linkLabel={def.linkLabel}
                            customizing={customizing}
                            onHide={() => hide(id)}
                            className="h-full"
                          >
                            {awaitingHeavy ? <WidgetSkeleton widgetId={id} /> : <Comp data={data} />}
                          </WidgetFrame>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {layout.length === 0 && !loading && (
        <div className="rounded-xl border p-10 text-center text-muted-foreground">
          No widgets on your dashboard. Click <strong>Customize</strong> to add some.
        </div>
      )}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
