/**
 * Page-shaped loading skeletons.
 *
 * These replace the centred-spinner pattern the dashboard used everywhere:
 * the whole page blanked to one spinner, then everything appeared at once.
 * That reads as slow even when it isn't, because for the whole wait there is
 * nothing to look at and no sign of what's coming.
 *
 * A skeleton doesn't make anything load faster — the request takes exactly as
 * long. What it buys is the page arriving in a recognisable shape immediately,
 * so the wait is spent reading layout instead of staring at a blank panel, and
 * the content lands without the page jumping.
 *
 * That last part is the constraint that matters: a skeleton whose shape is
 * WRONG is worse than a spinner, because the content arrives and everything
 * moves. Match the real layout — same grid, same column count, roughly the
 * same row height — or don't use one.
 */
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/** Page title + subtitle. */
export function HeaderSkeleton({ action = false }: { action?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-2">
        <Skeleton className="h-7 w-52" />
        <Skeleton className="h-4 w-72" />
      </div>
      {action ? <Skeleton className="h-9 w-28" /> : null}
    </div>
  );
}

/** A row of KPI stat cards. `count` should match the real page exactly. */
export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardContent className="pt-6 space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-16" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * A table. `cols` drives the header; rows are uniform bars rather than
 * per-cell blocks — cell-accurate skeletons flicker more than they help at
 * this row count.
 */
export function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-4">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

/** Table wrapped in a card, which is how most list pages render one. */
export function TableCardSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
      </CardHeader>
      <CardContent>
        <TableSkeleton rows={rows} cols={cols} />
      </CardContent>
    </Card>
  );
}

/** A large block standing in for a map or chart. */
export function ChartSkeleton({ height = "h-[420px]" }: { height?: string }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-44" />
      </CardHeader>
      <CardContent>
        <Skeleton className={`w-full ${height}`} />
      </CardContent>
    </Card>
  );
}

/**
 * The standard list page: header, optional KPI row, then a table.
 * Covers most of the dashboard's index pages.
 */
export function ListPageSkeleton({
  kpis = 0,
  rows = 8,
  cols = 5,
  action = false,
}: {
  kpis?: number;
  rows?: number;
  cols?: number;
  action?: boolean;
}) {
  return (
    <div className="space-y-6 p-6">
      <HeaderSkeleton action={action} />
      {kpis > 0 ? <KpiSkeleton count={kpis} /> : null}
      <TableCardSkeleton rows={rows} cols={cols} />
    </div>
  );
}

/**
 * The standard detail page: title block, then a two-column body with the
 * main content left and a sidebar right — the shape used by the prospect,
 * order, catalog and brand detail pages.
 */
export function DetailPageSkeleton({ sidebar = true }: { sidebar?: boolean }) {
  return (
    <div className="space-y-6 p-6">
      <HeaderSkeleton action />
      <div className={sidebar ? "grid grid-cols-1 lg:grid-cols-3 gap-6" : ""}>
        <div className={`space-y-4 ${sidebar ? "lg:col-span-2" : ""}`}>
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-36" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
        {sidebar ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }, (_, i) => (
              <Card key={i}>
                <CardHeader>
                  <Skeleton className="h-5 w-28" />
                </CardHeader>
                <CardContent className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-4/5" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
