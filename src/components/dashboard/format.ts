/** Shared dashboard formatters. */

export function money(n: number | null | undefined, opts: { compact?: boolean; cents?: boolean } = {}): string {
  const v = n ?? 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: opts.compact ? "compact" : "standard",
      maximumFractionDigits: opts.compact ? 1 : opts.cents ? 2 : 0,
    }).format(v);
  } catch {
    return `$${Math.round(v)}`;
  }
}

export function num(n: number | null | undefined, compact = false): string {
  const v = n ?? 0;
  try {
    return new Intl.NumberFormat("en-US", { notation: compact ? "compact" : "standard", maximumFractionDigits: compact ? 1 : 0 }).format(v);
  } catch {
    return String(Math.round(v));
  }
}

export function pct(n: number | null | undefined, digits = 0): string {
  const v = n ?? 0;
  return `${v.toFixed(digits)}%`;
}

/** Percentage delta between current and prior. null when prior is 0/undefined. */
export function deltaPct(current: number, prior: number | null | undefined): number | null {
  if (prior == null || prior === 0) return null;
  return ((current - prior) / prior) * 100;
}
