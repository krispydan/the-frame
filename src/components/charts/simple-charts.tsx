"use client";

/**
 * Minimal SVG charts.
 *
 * Deliberately dependency-free: the app runs on a tight memory ceiling (an
 * OOM restart loop took production down in Aug 2026), so pulling in a charting
 * library for a handful of bar/line charts isn't worth the footprint. These
 * cover grouped bars, stacked bars and multi-series lines, which is everything
 * the comparison pages need.
 *
 * All charts are responsive via viewBox, theme-aware via currentColor for
 * axes/text, and show values on hover through native <title> tooltips.
 */
import { useId } from "react";

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

const fmtMoney = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000 ? `$${Math.round(n / 1_000)}k`
  : `$${Math.round(n)}`;

const fmtFull = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);

/** Nice round axis maximum so gridlines land on readable numbers. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function Legend({ series }: { series: SeriesDef[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="inline-block w-3 h-3 rounded-sm" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Grouped bars — the side-by-side comparison (e.g. AJM vs Jaxy per year).
 * Each row of `data` is one category on the x-axis.
 */
export function GroupedBarChart({
  data, series, xKey, height = 260, valueFormat = fmtMoney,
}: {
  data: Array<Record<string, string | number>>;
  series: SeriesDef[];
  xKey: string;
  height?: number;
  valueFormat?: (n: number) => string;
}) {
  const id = useId();
  const W = 800, H = height, padL = 56, padR = 12, padT = 12, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const groupW = innerW / Math.max(1, data.length);
  const barW = Math.max(2, (groupW * 0.7) / series.length);
  const y = (v: number) => padT + innerH - (v / max) * innerH;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: Math.max(320, data.length * 60) }} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={padL - 6} y={y(max * f) + 4} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.55}>
              {valueFormat(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const gx = padL + i * groupW;
          return (
            <g key={`${id}-${i}`}>
              {series.map((s, si) => {
                const v = Number(d[s.key]) || 0;
                const bx = gx + groupW * 0.15 + si * barW;
                const bh = Math.max(0, padT + innerH - y(v));
                return (
                  <rect key={s.key} x={bx} y={y(v)} width={barW - 1} height={bh} fill={s.color} rx={1}>
                    <title>{`${d[xKey]} · ${s.label}: ${fmtFull(v)}`}</title>
                  </rect>
                );
              })}
              <text x={gx + groupW / 2} y={H - 10} textAnchor="middle" fontSize={11} fill="currentColor" fillOpacity={0.7}>
                {String(d[xKey])}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
    </div>
  );
}

/** Stacked bars — composition over time (e.g. AJM revenue split by channel). */
export function StackedBarChart({
  data, series, xKey, height = 260, valueFormat = fmtMoney,
}: {
  data: Array<Record<string, string | number>>;
  series: SeriesDef[];
  xKey: string;
  height?: number;
  valueFormat?: (n: number) => string;
}) {
  const W = 800, H = height, padL = 56, padR = 12, padT = 12, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const totals = data.map((d) => series.reduce((s, k) => s + (Number(d[k.key]) || 0), 0));
  const max = niceMax(Math.max(1, ...totals));
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.max(3, slot * 0.62);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const showEvery = data.length > 26 ? Math.ceil(data.length / 13) : 1;

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: Math.max(320, data.length * 24) }} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={padL - 6} y={y(max * f) + 4} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.55}>
              {valueFormat(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const bx = padL + i * slot + (slot - barW) / 2;
          let acc = 0;
          return (
            <g key={i}>
              {series.map((s) => {
                const v = Number(d[s.key]) || 0;
                if (v <= 0) return null;
                const yTop = y(acc + v), h = Math.max(0, y(acc) - y(acc + v));
                acc += v;
                return (
                  <rect key={s.key} x={bx} y={yTop} width={barW} height={h} fill={s.color}>
                    <title>{`${d[xKey]} · ${s.label}: ${fmtFull(v)}`}</title>
                  </rect>
                );
              })}
              {i % showEvery === 0 && (
                <text x={bx + barW / 2} y={H - 10} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.7}>
                  {String(d[xKey]).replace(/^\d{4}-/, "")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Legend series={series} />
    </div>
  );
}

/** Multi-series line — trends over many periods (e.g. monthly AJM vs Jaxy). */
export function LineChart({
  data, series, xKey, height = 260, valueFormat = fmtMoney,
}: {
  data: Array<Record<string, string | number>>;
  series: SeriesDef[];
  xKey: string;
  height?: number;
  valueFormat?: (n: number) => string;
}) {
  const W = 800, H = height, padL = 56, padR = 12, padT = 12, padB = 34;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const x = (i: number) => padL + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const showEvery = data.length > 24 ? Math.ceil(data.length / 12) : Math.max(1, Math.ceil(data.length / 12));

  return (
    <div className="w-full overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }} role="img">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W - padR} y1={y(max * f)} y2={y(max * f)} stroke="currentColor" strokeOpacity={0.12} />
            <text x={padL - 6} y={y(max * f) + 4} textAnchor="end" fontSize={10} fill="currentColor" fillOpacity={0.55}>
              {valueFormat(max * f)}
            </text>
          </g>
        ))}
        {series.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            points={data.map((d, i) => `${x(i)},${y(Number(d[s.key]) || 0)}`).join(" ")}
          />
        ))}
        {data.map((d, i) =>
          series.map((s) => (
            <circle key={`${s.key}-${i}`} cx={x(i)} cy={y(Number(d[s.key]) || 0)} r={2.5} fill={s.color}>
              <title>{`${d[xKey]} · ${s.label}: ${fmtFull(Number(d[s.key]) || 0)}`}</title>
            </circle>
          )),
        )}
        {data.map((d, i) =>
          i % showEvery === 0 ? (
            <text key={`lbl-${i}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize={10} fill="currentColor" fillOpacity={0.7}>
              {String(d[xKey])}
            </text>
          ) : null,
        )}
      </svg>
      <Legend series={series} />
    </div>
  );
}
