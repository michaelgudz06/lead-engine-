"use client";

import { useEffect, useRef, useState } from "react";
import { formatUsd } from "@/lib/admin/format";
import type { DailySpend, UsageProvider } from "@/lib/usage/types";
import { SERIES, seriesOf, type SeriesId } from "./series";

/**
 * Daily spend as a stacked bar chart in plain SVG: one bar per UTC day, one segment per
 * provider (fixed colours, stacked in palette order), hairline axes, a legend, values on hover
 * through <title>, and the same numbers in a table under "Show the numbers". Days before the
 * selected window are faded, so the chart reads with the window selector above it.
 */

const HEIGHT = 216;
const M = { top: 10, right: 4, bottom: 26, left: 46 };
/** Surface gap between stacked segments. */
const GAP = 2;
/** Rounded data end at the top of each bar; the baseline end stays square. */
const RADIUS = 4;
const MAX_BAR = 24;

const INK_QUIET = "#767670";
const GRID = "#efefea";
const BASELINE = "#d3d3cc";

interface Segment {
  id: SeriesId;
  label: string;
  color: string;
  value: number;
}

interface Day {
  day: string;
  total: number;
  segments: Segment[];
}

export function dayLabel(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function toDays(daily: DailySpend[]): Day[] {
  return daily.map((d) => {
    const bySeries = new Map<SeriesId, number>();
    for (const [provider, value] of Object.entries(d.byProvider)) {
      if (typeof value !== "number" || !(value > 0)) continue;
      const id = seriesOf(provider as UsageProvider);
      bySeries.set(id, (bySeries.get(id) ?? 0) + value);
    }
    const segments = SERIES.filter((s) => (bySeries.get(s.id) ?? 0) > 0).map((s) => ({ ...s, value: bySeries.get(s.id) ?? 0 }));
    return { day: d.day, total: d.totalUsd, segments };
  });
}

/** Round tick steps (1, 2, 2.5, 5 x 10^n), about four of them, and how many decimals they need. */
function niceScale(max: number): { top: number; step: number; decimals: number } {
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const factor = [1, 2, 2.5, 5, 10].find((f) => f * mag >= rough) ?? 10;
  const step = factor * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  const raw = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) + (factor === 2.5 ? 1 : 0);
  return { top, step, decimals: step < 1 ? Math.max(2, raw) : raw };
}

function tickLabel(v: number, decimals: number): string {
  return v === 0 ? "$0" : `$${v.toFixed(decimals)}`;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function useWidth(ref: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function SpendChart({ daily, windowFrom, estimated }: { daily: DailySpend[]; windowFrom: string | null; estimated: ReadonlySet<SeriesId> }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const days = toDays(daily);
  const present = SERIES.filter((s) => days.some((d) => d.segments.some((x) => x.id === s.id)));
  const max = Math.max(0, ...days.map((d) => d.total));
  const fromDay = windowFrom ? windowFrom.slice(0, 10) : null;
  const peak = days.reduce<Day | null>((best, d) => (d.total > (best?.total ?? 0) ? d : best), null);
  const label = peak
    ? `Daily spend for the last ${days.length} days, stacked by provider. Highest: ${formatUsd(peak.total)} on ${dayLabel(peak.day)}.`
    : `No spend recorded in the last ${days.length} days.`;

  return (
    <div>
      {present.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" aria-label="Legend">
          {present.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: s.color }} />
              <span>{s.label}</span>
              {estimated.has(s.id) && <span className="text-quiet">est.</span>}
            </li>
          ))}
        </ul>
      )}
      <div ref={ref} className="relative w-full" style={{ height: HEIGHT }}>
        {width > 0 && <Plot days={days} width={width} max={max} fromDay={fromDay} label={label} />}
      </div>
      <details className="mt-3 group">
        <summary className="inline-flex cursor-pointer items-center gap-1 rounded text-[13px] text-quiet hover:text-ink">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
          Show the numbers
        </summary>
        <DailyTable days={days} present={present} />
      </details>
    </div>
  );
}

function Plot({ days, width, max, fromDay, label }: { days: Day[]; width: number; max: number; fromDay: string | null; label: string }) {
  const n = Math.max(1, days.length);
  const plotW = Math.max(10, width - M.left - M.right);
  const plotH = HEIGHT - M.top - M.bottom;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(MAX_BAR, slot * 0.62));
  const empty = max <= 0;
  const { top, step, decimals } = empty ? { top: 1, step: 1, decimals: 0 } : niceScale(max);
  const y = (v: number) => M.top + plotH * (1 - v / top);
  const ticks = empty ? [0] : Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  return (
    <svg width={width} height={HEIGHT} role="img" aria-label={label} className="block overflow-visible">
      {ticks.map((t) => (
        <g key={t}>
          {t > 0 && <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} shapeRendering="crispEdges" />}
          <text x={M.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fill={INK_QUIET} fontSize={11} style={{ fontVariantNumeric: "tabular-nums" }}>
            {tickLabel(t, decimals)}
          </text>
        </g>
      ))}

      {days.map((d, i) => {
        const slotX = M.left + i * slot;
        const x = slotX + (slot - barW) / 2;
        const inWindow = !fromDay || d.day >= fromDay;
        let cum = 0;
        const title = [`${dayLabel(d.day)}: ${formatUsd(d.total)}`, ...[...d.segments].reverse().map((s) => `${s.label}: ${formatUsd(s.value)}`)].join("\n");
        return (
          <g key={d.day} className="group">
            <title>{title}</title>
            <rect x={slotX} y={M.top} width={slot} height={plotH} fill="#f6f6f3" className="opacity-0 transition-opacity group-hover:opacity-100" />
            <g opacity={inWindow ? 1 : 0.32}>
              {d.segments.map((s, k) => {
                const y0 = y(cum);
                cum += s.value;
                const y1 = y(cum);
                const inset = k === 0 ? 0 : GAP;
                const h = Math.max(1, y0 - y1 - inset);
                const yTop = y0 - inset - h;
                return k === d.segments.length - 1 ? (
                  <path key={s.id} d={roundedTop(x, yTop, barW, h, RADIUS)} fill={s.color} />
                ) : (
                  <rect key={s.id} x={x} y={yTop} width={barW} height={h} fill={s.color} />
                );
              })}
            </g>
          </g>
        );
      })}

      <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke={BASELINE} strokeWidth={1} shapeRendering="crispEdges" />

      {days.map((d, i) => {
        // Every seventh day, counting back from today, so today is always labelled.
        if ((days.length - 1 - i) % 7 !== 0) return null;
        const last = i === days.length - 1;
        const cx = M.left + i * slot + slot / 2;
        return (
          <text key={d.day} x={last ? M.left + (i + 1) * slot : cx} y={HEIGHT - 8} textAnchor={last ? "end" : "middle"} fill={INK_QUIET} fontSize={11}>
            {dayLabel(d.day)}
          </text>
        );
      })}

      {empty && (
        <text x={M.left + plotW / 2} y={M.top + plotH / 2} textAnchor="middle" dominantBaseline="middle" fill={INK_QUIET} fontSize={13}>
          No spend recorded in these {days.length} days.
        </text>
      )}
    </svg>
  );
}

function DailyTable({ days, present }: { days: Day[]; present: ReadonlyArray<{ id: SeriesId; label: string }> }) {
  const withSpend = [...days].reverse().filter((d) => d.total > 0);
  if (!withSpend.length) return <p className="mt-2 text-[13px] text-quiet">No spend in these days.</p>;
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[420px] text-[12.5px]">
        <thead>
          <tr className="text-left text-quiet">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Day (UTC)
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Total
            </th>
            {present.map((s) => (
              <th key={s.id} scope="col" className="py-1.5 pr-3 text-right font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline tabular-nums">
          {withSpend.map((d) => (
            <tr key={d.day}>
              <td className="py-1.5 pr-3">{dayLabel(d.day)}</td>
              <td className="py-1.5 pr-3 text-right font-medium">{formatUsd(d.total)}</td>
              {present.map((s) => {
                const v = d.segments.find((x) => x.id === s.id)?.value ?? 0;
                return (
                  <td key={s.id} className="py-1.5 pr-3 text-right">
                    {v ? formatUsd(v) : <span className="text-quiet">–</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
