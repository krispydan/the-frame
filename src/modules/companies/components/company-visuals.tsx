"use client";

/**
 * Small, purposeful visuals for the company page.
 *
 * Hand-rolled SVG and divs, no chart library: this app runs against a hard
 * memory ceiling on its host, which is why every other chart in the repo is
 * built the same way (see components/charts/simple-charts.tsx).
 *
 * Each of these answers one question a rep actually asks. None of them is
 * decoration — a chart that does not change what you do next is just an
 * expensive way to draw a number you already printed.
 */
import { money, moneyFull, pluralize } from "@/modules/companies/lib/format";
import { cn } from "@/lib/utils";

/**
 * "What is the prize, and how much of it have we taken?"
 *
 * Two bars on one scale. A number pair — $55,140 and $0 — states the gap;
 * two bars on a shared axis make you feel it, which is the point of putting
 * it at the top of a page whose job is to get someone to pick up the phone.
 */
/** Hoisted: declaring this inside GapBar made it a new component type on
 *  every render, which remounts the bars rather than updating them. */
function GapRow({
  label, value, max, tone,
}: { label: string; value: number; max: number; tone: "ajm" | "jaxy" }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="h-6 min-w-0 flex-1 overflow-hidden rounded bg-muted">
        <div
          className={cn(
            "h-full rounded transition-[width]",
            tone === "ajm" ? "bg-amber-500/80" : "bg-emerald-500",
          )}
          style={{ width: `${Math.max((value / max) * 100, value > 0 ? 2 : 0)}%` }}
        />
      </div>
      <span className="w-20 shrink-0 text-right text-sm font-semibold tabular-nums">
        {moneyFull(value)}
      </span>
    </div>
  );
}

export function GapBar({
  ajmRevenue, jaxyRevenue, className,
}: { ajmRevenue: number; jaxyRevenue: number; className?: string }) {
  const max = Math.max(ajmRevenue, jaxyRevenue, 1);
  const captured = ajmRevenue > 0 ? Math.round((jaxyRevenue / ajmRevenue) * 100) : null;

  return (
    <div className={cn("space-y-2", className)}>
      <GapRow label="A.J. Morgan" value={ajmRevenue} max={max} tone="ajm" />
      <GapRow label="Jaxy" value={jaxyRevenue} max={max} tone="jaxy" />
      {captured !== null && (
        <p className="text-xs text-muted-foreground">
          {captured === 0
            ? "None of this book has moved to Jaxy yet."
            : `We have captured ${captured}% of what they spent with A.J. Morgan.`}
        </p>
      )}
    </div>
  );
}

/**
 * "Were they growing, steady, or already fading before A.J. Morgan closed?"
 *
 * A retailer whose spend halved two years running is a different call from
 * one that was still growing when the supplier disappeared.
 */
export function SpendByYear({
  data, className,
}: { data: Array<{ year: string; revenue: number; orders: number }>; className?: string }) {
  if (data.length < 2) return null;          // one bar is a number, not a chart
  const max = Math.max(...data.map((d) => d.revenue), 1);

  return (
    <div className={className}>
      <div className="flex h-24 items-end gap-1.5">
        {data.map((d) => (
          <div
            key={d.year}
            className="group/bar flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
            title={`${d.year}: ${moneyFull(d.revenue)} across ${pluralize(d.orders, "order")}`}
          >
            <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
              {money(d.revenue)}
            </span>
            <div
              className="w-full shrink-0 rounded-t bg-amber-500/70 transition-colors group-hover/bar:bg-amber-500"
              style={{ height: `${Math.max((d.revenue / max) * 100, 3)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5">
        {data.map((d) => (
          <span key={d.year} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground">
            {d.year}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Human labels for the importer's category slugs. */
const CATEGORY_LABEL: Record<string, string> = {
  sun: "Sunglasses",
  reading: "Readers",
  blue_light: "Blue-light",
  sunglass_reader: "Sun readers",
  accessory: "Accessories",
  no_detail: "No line detail",
  unclassified: "Unclassified",
};
const CATEGORY_TONE: Record<string, string> = {
  sun: "bg-sky-500",
  reading: "bg-emerald-500",
  blue_light: "bg-emerald-400",
  sunglass_reader: "bg-teal-500",
  accessory: "bg-violet-400",
  no_detail: "bg-muted-foreground/30",
  unclassified: "bg-muted-foreground/20",
};

/**
 * "Are they a sunglasses account or a readers account?"
 *
 * Jaxy's reader line launched Aug 2026 into a book that A.J. Morgan already
 * sold readers to. Which side of that line an account sits on decides which
 * catalogue you send.
 */
export function CategoryMix({
  data, className,
}: { data: Array<{ category: string; revenue: number }>; className?: string }) {
  const total = data.reduce((s, d) => s + d.revenue, 0);
  if (total <= 0) return null;
  // Anything we could not attribute is shown, not quietly dropped — a mix
  // that silently excludes a third of the money is a lie by omission.
  const shown = data.filter((d) => d.revenue / total >= 0.01);

  return (
    <div className={className}>
      <div className="flex h-2.5 overflow-hidden rounded-full">
        {shown.map((d) => (
          <div
            key={d.category}
            className={CATEGORY_TONE[d.category] ?? "bg-muted-foreground/20"}
            style={{ width: `${(d.revenue / total) * 100}%` }}
            title={`${CATEGORY_LABEL[d.category] ?? d.category}: ${moneyFull(d.revenue)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((d) => (
          <span key={d.category} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("size-2 shrink-0 rounded-full", CATEGORY_TONE[d.category] ?? "bg-muted-foreground/20")} />
            {CATEGORY_LABEL[d.category] ?? d.category}
            <span className="tabular-nums text-foreground">{Math.round((d.revenue / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Google's rating as stars, because "4.9" and "★★★★★" are not read the same way. */
export function Stars({ rating, className }: { rating: number; className?: string }) {
  const full = Math.round(rating);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} aria-hidden className={i <= full ? "text-amber-500" : "text-muted-foreground/30"}>★</span>
      ))}
    </span>
  );
}
