import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Directional delta pill. `goodWhenUp` inverts the color for metrics where a
 * decrease is good (e.g. days-of-stock risk, churn). Color is paired with an
 * arrow icon — never color-alone.
 */
export function Delta({
  value,
  goodWhenUp = true,
  suffix = "%",
  className,
}: {
  value: number | null | undefined;
  goodWhenUp?: boolean;
  suffix?: string;
  className?: string;
}) {
  if (value == null || !isFinite(value)) {
    return <span className={cn("inline-flex items-center gap-0.5 text-xs text-muted-foreground", className)}><Minus className="h-3 w-3" />—</span>;
  }
  const up = value > 0;
  const flat = Math.abs(value) < 0.05;
  const positive = flat ? null : up === goodWhenUp;
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        positive == null ? "text-muted-foreground" : positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {up ? "+" : ""}{value.toFixed(1)}{suffix}
    </span>
  );
}
