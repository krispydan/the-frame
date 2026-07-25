"use client";

/**
 * Dependency-free chart kit (inline SVG). The app ships no chart library and
 * runs under a strict no-CDN policy, so these are hand-built: responsive via
 * viewBox, hover tooltips computed from the SVG bounding rect, thin marks,
 * rounded data-ends, recessive grid. Colors come from the validated palette
 * (palette.ts). Every chart also renders direct value labels or a tooltip so
 * identity/magnitude never rely on color alone.
 */

import { useRef, useState } from "react";
import { seriesColor } from "./palette";

// ── Sparkline ── tiny inline trend, no axes
export function Sparkline({ data, color, width = 72, height = 24 }: { data: number[]; color?: string; width?: number; height?: number }) {
  if (!data.length) return <span className="text-xs text-muted-foreground">—</span>;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : width;
  const pts = data.map((v, i) => `${i * stepX},${height - ((v - min) / span) * height}`).join(" ");
  const stroke = color ?? seriesColor(0);
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Area / line trend with hover crosshair ──
export type TrendPoint = { label: string; value: number };
export function AreaTrend({
  data,
  color,
  height = 180,
  format = (v) => String(Math.round(v)),
}: {
  data: TrendPoint[];
  color?: string;
  height?: number;
  format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = 600; // viewBox width; scales to container
  const H = height;
  const padY = 14;
  const stroke = color ?? seriesColor(0);
  const id = `grad-${stroke.replace("#", "")}`;

  if (!data.length) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const stepX = data.length > 1 ? W / (data.length - 1) : W;
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const x = (i: number) => (data.length > 1 ? i * stepX : W / 2);
  const line = data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ");
  const area = `${line} ${x(data.length - 1)},${H} ${x(0)},${H}`;

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(rel * (data.length - 1)))));
  };

  const hp = hover != null ? data[hover] : null;
  return (
    <div ref={wrapRef} className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" className="block">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {[0.5, 1].map((f) => (
          <line key={f} x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} className="stroke-border" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
        ))}
        <polygon points={area} fill={`url(#${id})`} />
        <polyline points={line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hp && (
          <g>
            <line x1={x(hover!)} x2={x(hover!)} y1={padY} y2={H} className="stroke-muted-foreground/40" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover!)} cy={y(hp.value)} r={4} fill={stroke} stroke="var(--card)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: `${(hover! / Math.max(1, data.length - 1)) * 100}%` }}
        >
          <div className="font-medium tabular-nums">{format(hp.value)}</div>
          <div className="text-muted-foreground">{hp.label}</div>
        </div>
      )}
    </div>
  );
}

// ── Donut with center total + legend ──
export type Slice = { label: string; value: number; color: string };
export function Donut({ slices, total, centerLabel, size = 150 }: { slices: Slice[]; total?: number; centerLabel?: string; size?: number }) {
  const sum = total ?? slices.reduce((a, s) => a + s.value, 0);
  const [hover, setHover] = useState<number | null>(null);
  if (sum <= 0) return <Empty />;
  const r = size / 2;
  const stroke = size * 0.16;
  const rr = r - stroke / 2 - 2;
  const C = 2 * Math.PI * rr;
  const fracs = slices.map((s) => s.value / sum);
  // Cumulative offset per slice without a reassigned outer accumulator (the
  // React compiler flags `let offset += …` in render). n is tiny (channels).
  const arcs = slices.map((s, i) => ({
    s,
    i,
    dash: fracs[i] * C,
    offset: fracs.slice(0, i).reduce((a, b) => a + b, 0) * C,
  }));
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${r} ${r})`}>
          {arcs.map(({ s, i, dash, offset }) => (
            <circle
              key={i}
              cx={r}
              cy={r}
              r={rr}
              fill="none"
              stroke={s.color}
              strokeWidth={hover === i ? stroke + 3 : stroke}
              strokeDasharray={`${Math.max(0, dash - 2)} ${C}`}
              strokeDashoffset={-offset}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              className="transition-all"
            />
          ))}
        </g>
        <text x={r} y={r - 2} textAnchor="middle" className="fill-foreground text-lg font-semibold" style={{ fontSize: size * 0.16 }}>
          {hover != null ? `${Math.round((slices[hover].value / sum) * 100)}%` : centerLabel ?? ""}
        </text>
        <text x={r} y={r + size * 0.13} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: size * 0.075 }}>
          {hover != null ? slices[hover].label : "total"}
        </text>
      </svg>
      <ul className="flex-1 space-y-1 text-sm">
        {slices.map((s, i) => (
          <li key={i} className="flex items-center gap-2" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="flex-1 truncate text-muted-foreground">{s.label}</span>
            <span className="tabular-nums font-medium">{Math.round((s.value / sum) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Horizontal bar list (top sellers, funnels, breakdowns) ──
export type HBar = { label: string; value: number; sub?: string; color?: string };
export function HBars({ rows, format = (v) => String(Math.round(v)), max: maxOverride }: { rows: HBar[]; format?: (v: number) => string; max?: number }) {
  if (!rows.length) return <Empty />;
  const max = maxOverride ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={i} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate font-medium">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {format(r.value)}
              {r.sub && <span className="ml-1 text-xs">{r.sub}</span>}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(2, (r.value / max) * 100)}%`, backgroundColor: r.color ?? seriesColor(i) }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ── Meter (single ratio, e.g. connect rate, gross margin) ──
export function Meter({ value, label, color, sub }: { value: number; label?: string; color?: string; sub?: string }) {
  const pctv = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-semibold tabular-nums">{pctv.toFixed(0)}%</span>
        {label && <span className="text-xs text-muted-foreground">{label}</span>}
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${pctv}%`, backgroundColor: color ?? seriesColor(0) }} />
      </div>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Empty() {
  return <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">No data in this range</div>;
}
