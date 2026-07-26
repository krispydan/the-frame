/**
 * Loading skeletons that mirror the real widget shapes.
 *
 * A skeleton that matches the final layout keeps the page from reflowing when
 * data lands, which reads as "fast" far more than a spinner does. Each shape
 * here corresponds to a widget body: stat tiles, a chart, a ranked list, or a
 * donut with a legend.
 */

function Bar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

/** KPI strip — six tiles. */
export function KpiSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <Bar className="h-3 w-20" />
          <Bar className="h-7 w-24" />
          <Bar className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Area/line chart body. */
export function ChartSkeleton({ height = 180 }: { height?: number }) {
  return (
    <div className="space-y-2">
      <Bar className="h-6 w-32" />
      <div className="relative w-full overflow-hidden rounded-lg bg-muted/50" style={{ height }}>
        <div className="absolute inset-0 animate-pulse bg-gradient-to-t from-muted to-transparent" />
      </div>
    </div>
  );
}

/** Ranked list with progress bars (top sellers, funnels, breakdowns). */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="flex justify-between gap-2">
            <Bar className="h-3.5 w-2/5" />
            <Bar className="h-3.5 w-16" />
          </div>
          <Bar className="h-2 w-full" />
        </div>
      ))}
    </div>
  );
}

/** Donut + legend. */
export function DonutSkeleton() {
  return (
    <div className="flex items-center gap-4">
      <div className="h-[150px] w-[150px] shrink-0 animate-pulse rounded-full border-[24px] border-muted" />
      <div className="flex-1 space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Bar className="h-2.5 w-2.5 rounded-sm" />
            <Bar className="h-3 flex-1" />
            <Bar className="h-3 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Stat row + meters (finance, business health). */
export function StatsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-1.5 rounded-lg bg-muted/40 p-2">
            <Bar className="h-5 w-16" />
            <Bar className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="space-y-1.5">
        <Bar className="h-6 w-20" />
        <Bar className="h-2.5 w-full" />
        <Bar className="h-2.5 w-3/4" />
      </div>
    </div>
  );
}

/** Pick the shape that best matches a widget's body. */
export function WidgetSkeleton({ widgetId }: { widgetId: string }) {
  switch (widgetId) {
    case "revenue-trend":
      return <ChartSkeleton />;
    case "channel-mix":
      return <DonutSkeleton />;
    case "finance":
    case "business-health":
      return <StatsSkeleton />;
    case "top-sellers":
    case "movers":
      return <ListSkeleton rows={5} />;
    default:
      return <ListSkeleton rows={4} />;
  }
}
