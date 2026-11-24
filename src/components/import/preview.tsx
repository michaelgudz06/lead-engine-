"use client";

import { useState } from "react";
import type { ImportRow } from "@/lib/import/columns";
import type { ImportSource } from "@/lib/types";
import { Button, Chip, cx } from "../ui";
import { plural, rowLabel, rowName, type RowStatus } from "./rows";

/** Rows shown at first, and how many more each "Show more" adds. */
const FIRST = 20;
const STEP = 100;

const GRID = "grid grid-cols-[20px_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 sm:px-5 md:grid-cols-[20px_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.1fr)] md:items-center";

function StatusCell({ status }: { status: RowStatus }) {
  if (status.kind === "ready") return <Chip tone="success">Ready</Chip>;
  if (status.kind === "no_linkedin") {
    return (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Chip>No LinkedIn</Chip>
        <span className="text-[12.5px] text-quiet">Research will look it up</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <Chip tone="urgent">Skipped</Chip>
      <span className="text-[12.5px] text-quiet">{status.reason}</span>
    </span>
  );
}

/** The contacts as they will be imported, with a status and a tick box each. */
export function PreviewList({
  items,
  statuses,
  source,
  unticked,
  disabled,
  onToggle,
  onToggleAll,
}: {
  items: ImportRow[];
  statuses: RowStatus[];
  source: ImportSource;
  unticked: ReadonlySet<number>;
  disabled?: boolean;
  onToggle: (index: number) => void;
  onToggleAll: (on: boolean) => void;
}) {
  const [shown, setShown] = useState(FIRST);
  const importable = statuses.filter((s) => s.kind !== "skipped").length;
  const ticked = statuses.filter((s, i) => s.kind !== "skipped" && !unticked.has(i)).length;
  const visible = items.slice(0, shown);
  const rest = items.length - visible.length;

  return (
    <>
      <div className={cx(GRID, "border-b border-hairline py-2.5")}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[#22221f] md:mt-0"
          aria-label="Select every contact that can be imported"
          checked={importable > 0 && ticked === importable}
          ref={(el) => {
            if (el) el.indeterminate = ticked > 0 && ticked < importable;
          }}
          disabled={disabled || importable === 0}
          onChange={(e) => onToggleAll(e.target.checked)}
        />
        <span className="text-[13px] md:hidden">
          {ticked.toLocaleString("en-US")} of {importable.toLocaleString("en-US")} selected
        </span>
        <span className="eyebrow hidden md:block">Name</span>
        <span className="eyebrow hidden md:block">Company</span>
        <span className="eyebrow hidden md:block">Email and LinkedIn</span>
        <span className="eyebrow hidden md:block">Status · {ticked.toLocaleString("en-US")} selected</span>
      </div>
      <ul className="divide-y divide-hairline">
        {visible.map((row, i) => {
          const status = statuses[i];
          const skipped = status.kind === "skipped";
          const name = rowName(row);
          const label = rowLabel(row, source);
          const slug = row.linkedinUrl ? (/linkedin\.com\/(in\/[^/?#]+)/i.exec(row.linkedinUrl)?.[1] ?? row.linkedinUrl) : null;
          return (
            <li key={i} className={cx(GRID, "py-2.5 text-[13.5px]", skipped && "bg-wash/60")}>
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[#22221f] md:mt-0"
                aria-label={`Import ${name}${label ? `, ${label.toLowerCase()}` : ""}`}
                checked={!skipped && !unticked.has(i)}
                disabled={disabled || skipped}
                onChange={() => onToggle(i)}
              />
              <div className="min-w-0">
                <div className={cx("truncate font-medium", skipped && "text-quiet")}>{name}</div>
                {(row.title || label) && <div className="truncate text-[12.5px] text-quiet">{[row.title, label].filter(Boolean).join(" · ")}</div>}
              </div>
              <div className={cx("col-start-2 min-w-0 truncate md:col-start-auto", !row.company && "hidden md:block")}>{row.company || <span className="text-quiet">No company</span>}</div>
              <div className={cx("col-start-2 min-w-0 md:col-start-auto", !row.email && !slug && "hidden md:block")}>
                {row.email && <div className="truncate">{row.email}</div>}
                {slug && <div className="truncate text-[12.5px] text-quiet">{slug}</div>}
                {!row.email && !slug && <span className="text-quiet">None</span>}
              </div>
              <div className="col-start-2 min-w-0 md:col-start-auto">
                <StatusCell status={status} />
              </div>
            </li>
          );
        })}
      </ul>
      {rest > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-hairline px-4 py-3 text-[13px] text-quiet sm:px-5">
          <span>
            Showing the first {visible.length.toLocaleString("en-US")}. {plural(rest, "more row")} {rest === 1 ? "is" : "are"} included the same way.
          </span>
          <Button size="sm" variant="ghost" className="-ml-2 text-quiet" onClick={() => setShown((n) => n + STEP)}>
            Show {Math.min(STEP, rest).toLocaleString("en-US")} more
          </Button>
        </div>
      )}
    </>
  );
}
