"use client";

import { useEffect, useState } from "react";

/**
 * Shared pieces of the Usage tab's charts: chrome colours, scales, the width hook and the
 * tooltip. The charts are plain SVG and HTML in the app's black-and-white look: one ink mark
 * colour, gray for secondary marks and furniture, and the danger red only for failures
 * (always with a label beside it). The same hexes as the tokens in src/app/globals.css.
 */
export const CHART = {
  /** --color-ink: the mark colour. */
  ink: "#22221f",
  /** --color-quiet: axis text. */
  quiet: "#767670",
  /** --color-danger: failed runs. */
  danger: "#b42318",
  /** Gridlines, one step off the white surface. */
  grid: "#efefea",
  /** The baseline. */
  baseline: "#d3d3cc",
  /** Secondary marks, such as the 95th percentile whisker and markers for runs without an end. */
  secondary: "#a3a39c",
  /** --color-wash: the hovered slot. */
  hover: "#f6f6f3",
} as const;

/** Width of an element, kept current as it resizes. 0 until measured. */
export function useWidth(ref: React.RefObject<HTMLElement | null>): number {
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

export interface Scale {
  /** The axis top, a round number at or above the largest value. */
  top: number;
  /** Ticks from 0 to top. */
  ticks: number[];
  label: (value: number) => string;
}

/** Round money ticks (1, 2, 2.5, 5 x 10^n), about four of them: "$0", "$0.10", "$0.20". */
export function usdScale(max: number): Scale {
  if (!(max > 0)) return { top: 1, ticks: [0], label: () => "$0" };
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const factor = [1, 2, 2.5, 5, 10].find((f) => f * mag >= rough) ?? 10;
  const step = factor * mag;
  const top = Number((Math.ceil(max / step - 1e-9) * step).toPrecision(12));
  const raw = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) + (factor === 2.5 ? 1 : 0);
  const decimals = step < 1 ? Math.max(2, raw) : raw;
  return { top, ticks: ticksOf(top, step), label: (v) => (v === 0 ? "$0" : `$${v.toFixed(decimals)}`) };
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800];

/** Round duration ticks, about four of them, from milliseconds: "0", "30 s", "60 s"; minutes from 5 minutes up. */
export function durationScale(maxMs: number): Scale {
  const max = maxMs / 1000;
  if (!(max > 0)) return { top: 1000, ticks: [0], label: () => "0" };
  const step = SECOND_STEPS.find((s) => s * 4 >= max) ?? Math.ceil(max / 4 / 1800) * 1800;
  const top = Math.ceil(max / step - 1e-9) * step;
  const minutes = top >= 300;
  return {
    top: top * 1000,
    ticks: ticksOf(top, step).map((t) => t * 1000),
    label: (ms) => (ms === 0 ? "0" : minutes ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`),
  };
}

function ticksOf(top: number, step: number): number[] {
  const count = Math.round(top / step);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

/** A bar's path with a rounded data end at the top and a square end on the baseline. */
export function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * The hover and focus readout, inside a relatively positioned chart container. It sits beside
 * the pointer's x, on whichever side has more room, so it never needs measuring or clipping.
 * Purely visual (aria-hidden): every value it shows is also in the chart's table view.
 */
export function ChartTooltip({ x, width, top = 0, children }: { x: number; width: number; top?: number; children: React.ReactNode }) {
  const leftSide = x > width / 2;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10 w-max max-w-[min(280px,80vw)] rounded-lg border border-hairline bg-paper px-3 py-2 text-[12.5px] leading-snug"
      style={leftSide ? { right: Math.max(0, width - x + 12), top } : { left: Math.max(0, x + 12), top }}
    >
      {children}
    </div>
  );
}

/** One readout line: the value first and strong, the label after it in quiet ink. */
export function TipRow({ value, label }: { value: React.ReactNode; label: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 whitespace-nowrap">
      <span className="font-medium tabular-nums">{value}</span>
      <span className="text-quiet">{label}</span>
    </div>
  );
}
