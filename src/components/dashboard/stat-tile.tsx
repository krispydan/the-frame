import Link from "next/link";
import { cn } from "@/lib/utils";
import { Delta } from "./delta";
import type { LucideIcon } from "lucide-react";

/**
 * KPI stat tile: a big headline number with an optional label, delta vs a
 * prior period, an icon, and an optional link. The headline number IS the
 * mark — no chart. Optionally accepts a compact sparkline node.
 */
export function StatTile({
  label,
  value,
  icon: Icon,
  delta,
  deltaGoodWhenUp = true,
  sub,
  href,
  spark,
  accent,
}: {
  label: string;
  value: string;
  icon?: LucideIcon;
  delta?: number | null;
  deltaGoodWhenUp?: boolean;
  sub?: string;
  href?: string;
  spark?: React.ReactNode;
  /** hex accent for the icon chip */
  accent?: string;
}) {
  const body = (
    <div className="group flex flex-col gap-1 rounded-xl border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
        {Icon && (
          <span
            className="rounded-md p-1"
            style={accent ? { backgroundColor: `${accent}1a`, color: accent } : undefined}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {spark}
      </div>
      <div className="flex items-center gap-2">
        {delta !== undefined && <Delta value={delta} goodWhenUp={deltaGoodWhenUp} />}
        {sub && <span className="text-xs text-muted-foreground truncate">{sub}</span>}
      </div>
    </div>
  );
  return href ? (
    <Link href={href} className={cn("block")}>{body}</Link>
  ) : body;
}
