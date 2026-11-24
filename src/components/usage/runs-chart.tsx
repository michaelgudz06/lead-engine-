"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { formatMs, formatUsd, plural } from "@/lib/usage/format";
import type { RunOutcome, RunUsage } from "@/lib/usage/types";
import { formatDateTime } from "@/components/format";
import { cx } from "@/components/ui";
import { Est } from "./bits";
import { CHART, ChartTooltip, TipRow, durationScale, roundedTop, usdScale, useWidth, type Scale } from "./chart-kit";

/**
 * Research and steer runs, oldest on the left: how long each took (top) and what its calls
 * cost (bottom). Two charts on one shared run axis instead of one chart with two scales.
 * Bars are ink; a failed run's bars are the danger red and say "Failed" in the legend, the
 * readout and the table. A run without an end (still running, or cut off) has no duration
 * bar, only a hollow marker on the baseline. Hover, or focus the chart and use the arrow
 * keys, to read a run; click or press Enter to open its lead. The table has every number.
 */

const M = { left: 48, right: 4 };
const DURATION_H = 140;
const COST_H = 96;
const PAD_TOP = 8;
const PAD_BOTTOM = 2;
const MAX_BAR = 24;
const RADIUS = 4;

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  done: "Done",
  failed: "Failed",
  running: "Still running",
  lost: "No end recorded",
};

const KIND_LABELS = { research: "Research", steer: "Steer" } as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

function runName(run: RunUsage): string {
  return run.leadName?.trim() || "Unnamed lead";
}

/** The typical run in a few words, for the chart's heading: "Median finished run: 1 min 13 s, $0.15. 1 run failed." */
export function runsSummary(runs: RunUsage[]): string {
  const durations = runs.filter((r) => r.outcome === "done" && r.durationMs !== null).map((r) => r.durationMs as number);
  const costs = runs.filter((r) => r.outcome === "done" && r.costUsd !== null).map((r) => r.costUsd as number);
  const failed = runs.filter((r) => r.outcome === "failed").length;
  const typical = [durations.length ? formatMs(median(durations)) : null, costs.length ? formatUsd(median(costs)) : null].filter(Boolean);
  return [typical.length ? `Median finished run: ${typical.join(", ")}.` : null, failed ? `${plural(failed, "run")} failed.` : null].filter(Boolean).join(" ");
}

export function RunsChart({ runs }: { runs: RunUsage[] }) {
  // The API sends newest first; the chart reads left to right in time.
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const [active, setActive] = useState<number | null>(null);
  // On a touch screen the first tap on a run shows its readout; a second tap opens the lead.
  const pointerType = useRef<string>("mouse");
  const router = useRouter();

  const n = ordered.length;
  const plotW = Math.max(10, width - M.left - M.right);
  const slot = plotW / Math.max(1, n);
  const barW = Math.max(2, Math.min(MAX_BAR, slot * 0.62));
  const center = (i: number) => M.left + i * slot + slot / 2;

  const durations = durationScale(Math.max(0, ...ordered.map((r) => r.durationMs ?? 0)));
  const costs = usdScale(Math.max(0, ...ordered.map((r) => r.costUsd ?? 0)));
  const outcomes = new Set(ordered.map((r) => r.outcome));
  // Runs from before the usage ledger have no cost: drawn hollow, never as a free run.
  const noCost = ordered.some((r) => r.costUsd === null);
  const current = active !== null ? ordered[active] : null;

  function indexAt(clientX: number, el: HTMLElement): number | null {
    const x = clientX - el.getBoundingClientRect().left;
    if (x < M.left || n === 0) return null;
    return Math.max(0, Math.min(n - 1, Math.floor((x - M.left) / slot)));
  }

  function open(i: number | null) {
    const run = i === null ? null : ordered[i];
    if (run) router.push(`/leads/${run.leadId}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!n) return;
    const at = active ?? n - 1;
    const next =
      e.key === "ArrowLeft" ? Math.max(0, at - 1) : e.key === "ArrowRight" ? Math.min(n - 1, at + 1) : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : null;
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(at);
    } else if (e.key === "Escape") {
      setActive(null);
    }
  }

  const label = `Duration and cost of ${plural(n, "run")}, oldest first. Arrow keys step through the runs, Enter opens the lead.`;

  return (
    <div>
      {(outcomes.has("failed") || outcomes.has("running") || outcomes.has("lost") || noCost) && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px]" aria-label="Legend">
          <LegendItem swatch={<span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: CHART.ink }} />} text="Done" />
          {outcomes.has("failed") && <LegendItem swatch={<span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: CHART.danger }} />} text="Failed" />}
          {(outcomes.has("running") || outcomes.has("lost")) && (
            <LegendItem
              swatch={<span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] bg-paper" style={{ borderColor: CHART.secondary }} />}
              text="Still running, or no end recorded"
            />
          )}
          {noCost && (
            <LegendItem
              swatch={<span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] bg-paper" style={{ borderColor: CHART.secondary }} />}
              text="No cost recorded"
            />
          )}
        </ul>
      )}

      <div
        ref={ref}
        role="group"
        tabIndex={0}
        aria-label={label}
        className="relative w-full cursor-pointer rounded-md"
        style={{ minHeight: PAD_TOP + DURATION_H + PAD_BOTTOM + COST_H + PAD_TOP + PAD_BOTTOM + 64 }}
        onPointerDown={(e) => {
          pointerType.current = e.pointerType;
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "mouse") setActive(indexAt(e.clientX, e.currentTarget));
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setActive(null);
        }}
        onClick={(e) => {
          const i = indexAt(e.clientX, e.currentTarget);
          if (pointerType.current !== "mouse" && i !== active) setActive(i);
          else open(i);
        }}
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          // Keyboard focus starts on the newest run; a click or tap picks its own run.
          if (focusVisible(e.currentTarget)) setActive((a) => a ?? (n ? n - 1 : null));
        }}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <>
            <PanelTitle>Duration of each run</PanelTitle>
            <Panel
              width={width}
              height={DURATION_H}
              scale={durations}
              runs={ordered}
              active={active}
              slot={slot}
              barW={barW}
              value={(r) => r.durationMs}
              hollowWhenMissing="unfinished"
            />
            <PanelTitle className="mt-3">Cost of each run (US dollars)</PanelTitle>
            <Panel width={width} height={COST_H} scale={costs} runs={ordered} active={active} slot={slot} barW={barW} value={(r) => r.costUsd} hollowWhenMissing="always" />
            {n > 0 && (
              <div className="relative mt-1 h-4 text-[11px] text-quiet" aria-hidden>
                <span className="absolute whitespace-nowrap" style={{ left: M.left }}>
                  {formatDateTime(ordered[0].startedAt)}
                </span>
                {n > 1 && (
                  <span className="absolute whitespace-nowrap" style={{ right: M.right }}>
                    {formatDateTime(ordered[n - 1].startedAt)}
                  </span>
                )}
              </div>
            )}
            {current && active !== null && (
              <ChartTooltip x={center(active)} width={width} top={PAD_TOP + 18}>
                <RunReadout run={current} />
              </ChartTooltip>
            )}
          </>
        )}
        <p id="runs-readout" className="sr-only" aria-live="polite">
          {current ? readoutText(current) : ""}
        </p>
      </div>

      <details className="group mt-3">
        <summary className="inline-flex cursor-pointer items-center gap-1 rounded text-[13px] text-quiet hover:text-ink">
          <span className="transition-transform group-open:rotate-90" aria-hidden>
            ›
          </span>
          Show the numbers
        </summary>
        <RunsTable runs={runs} />
      </details>
    </div>
  );
}

function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

function LegendItem({ swatch, text }: { swatch: React.ReactNode; text: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className="inline-flex">
        {swatch}
      </span>
      <span>{text}</span>
    </li>
  );
}

function PanelTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cx("text-[12px] text-quiet", className)} style={{ paddingLeft: M.left }} aria-hidden>
      {children}
    </p>
  );
}

function Panel({
  width,
  height,
  scale,
  runs,
  active,
  slot,
  barW,
  value,
  hollowWhenMissing,
}: {
  width: number;
  height: number;
  scale: Scale;
  runs: RunUsage[];
  active: number | null;
  slot: number;
  barW: number;
  value: (r: RunUsage) => number | null;
  /**
   * A hollow marker on the baseline where a run has no value, so it never looks like a zero:
   * "unfinished" only for runs still going or without an end (durations), "always" for any
   * run (costs, which are not recorded for runs from before the usage ledger).
   */
  hollowWhenMissing?: "unfinished" | "always";
}) {
  const full = PAD_TOP + height + PAD_BOTTOM;
  const y = (v: number) => PAD_TOP + height * (1 - v / scale.top);
  return (
    <svg width={width} height={full} aria-hidden className="block overflow-visible">
      {active !== null && <rect x={M.left + active * slot} y={0} width={slot} height={full} fill={CHART.hover} />}
      {scale.ticks.map((t) => (
        <g key={t}>
          {t > 0 && <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={CHART.grid} strokeWidth={1} shapeRendering="crispEdges" />}
          <text x={M.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fill={CHART.quiet} fontSize={11} style={{ fontVariantNumeric: "tabular-nums" }}>
            {scale.label(t)}
          </text>
        </g>
      ))}
      {runs.map((r, i) => {
        const v = value(r);
        const x = M.left + i * slot + (slot - barW) / 2;
        if (v === null) {
          if (!hollowWhenMissing || (hollowWhenMissing === "unfinished" && (r.outcome === "done" || r.outcome === "failed"))) return null;
          return <circle key={r.id} cx={x + barW / 2} cy={y(0) - 6} r={3.5} fill="#fff" stroke={CHART.secondary} strokeWidth={1.5} />;
        }
        const h = Math.max(v > 0 ? 1 : 0, y(0) - y(v));
        if (h <= 0) return null;
        return <path key={r.id} d={roundedTop(x, y(0) - h, barW, h, RADIUS)} fill={r.outcome === "failed" ? CHART.danger : CHART.ink} />;
      })}
      <line x1={M.left} x2={width - M.right} y1={y(0)} y2={y(0)} stroke={CHART.baseline} strokeWidth={1} shapeRendering="crispEdges" />
    </svg>
  );
}

function RunReadout({ run }: { run: RunUsage }) {
  return (
    <div className="space-y-0.5">
      <p className="max-w-[240px] truncate font-medium">{runName(run)}</p>
      <p className="text-quiet">
        {KIND_LABELS[run.kind]} · {formatDateTime(run.startedAt)}
      </p>
      <div className="pt-1">
        <TipRow value={run.durationMs === null ? "–" : formatMs(run.durationMs)} label={run.durationMs === null ? OUTCOME_LABELS[run.outcome].toLowerCase() : "from start to end"} />
        <TipRow
          value={
            <>
              {run.costUsd === null ? "–" : formatUsd(run.costUsd)}
              {run.costEstimated && <Est className="ml-1 align-[1px]" />}
            </>
          }
          label={run.costUsd === null ? "cost not recorded" : `for ${plural(run.calls, "call")}${run.failedCalls ? `, ${run.failedCalls} failed` : ""}`}
        />
      </div>
      {run.outcome === "failed" ? (
        <p className="max-w-[260px] pt-1 text-danger">
          <span className="font-medium">Failed</span>
          {run.endMessage ? `: ${run.endMessage.slice(0, 140)}` : ""}
        </p>
      ) : run.outcome === "done" && run.endMessage ? (
        <p className="max-w-[260px] pt-1 text-quiet">{run.endMessage.slice(0, 140)}</p>
      ) : null}
    </div>
  );
}

function readoutText(run: RunUsage): string {
  const took = run.durationMs === null ? OUTCOME_LABELS[run.outcome] : `${OUTCOME_LABELS[run.outcome]} in ${formatMs(run.durationMs)}`;
  const cost = run.costUsd === null ? "cost not recorded" : `${formatUsd(run.costUsd)}${run.costEstimated ? " (estimated)" : ""} for ${plural(run.calls, "call")}`;
  return `${runName(run)}, ${KIND_LABELS[run.kind].toLowerCase()} started ${formatDateTime(run.startedAt)}: ${took}, ${cost}.`;
}

function RunsTable({ runs }: { runs: RunUsage[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full min-w-[640px] text-[12.5px]">
        <thead>
          <tr className="text-left text-quiet">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Started
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Lead
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Run
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Result
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Took
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Calls
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {runs.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="whitespace-nowrap py-1.5 pr-3 text-quiet tabular-nums" title={r.startedAt}>
                {formatDateTime(r.startedAt)}
              </td>
              <td className="max-w-[200px] truncate py-1.5 pr-3">
                <Link href={`/leads/${r.leadId}`} className="underline-offset-2 hover:underline">
                  {runName(r)}
                </Link>
                {r.company && <span className="text-quiet"> · {r.company}</span>}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-quiet">{KIND_LABELS[r.kind]}</td>
              <td className={cx("max-w-[260px] py-1.5 pr-3", r.outcome === "failed" ? "text-danger" : "text-quiet")} title={r.endMessage ?? undefined}>
                <span className={cx(r.outcome === "failed" && "font-medium")}>{OUTCOME_LABELS[r.outcome]}</span>
                {r.outcome === "failed" && r.endMessage ? <span className="block truncate">{r.endMessage}</span> : null}
              </td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{r.durationMs === null ? <span className="text-quiet">–</span> : formatMs(r.durationMs)}</td>
              <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                {r.costUsd === null && r.calls === 0 ? <span className="text-quiet">–</span> : r.calls}
                {r.failedCalls > 0 && <span className="text-danger"> ({r.failedCalls} failed)</span>}
              </td>
              <td className="whitespace-nowrap py-1.5 text-right tabular-nums">
                {r.costUsd === null ? <span className="text-quiet">not recorded</span> : formatUsd(r.costUsd)}
                {r.costEstimated && <Est className="ml-1 align-[1px]" />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
