"use client";

import Link from "next/link";
import { useState } from "react";
import type { ImportResult } from "@/lib/api-client";
import type { ImportRow } from "@/lib/import/columns";
import type { ImportSource } from "@/lib/types";
import { Button, ButtonLink, Notice } from "../ui";
import { plural, rowLabel, rowName } from "./rows";

/** Everything the result view needs about one import. */
export interface ImportOutcome {
  source: ImportSource;
  /** The rows that were sent; the result's indexes point into this list. */
  sent: ImportRow[];
  result: ImportResult;
  /** The server's message when a batch failed. The batches before it were imported. */
  error: string | null;
  /** Rows that never reached the server because a batch failed. */
  notSent: number;
  /** Rows the screen left out because they cannot become a lead, with why. */
  leftOut: Array<{ row: ImportRow; reason: string }>;
  /** Rows the person unticked. */
  unchecked: number;
}

const LIST_FIRST = 50;

/** A titled list that shows its first rows and the rest on request. */
function ResultList<T>({ title, items, render }: { title: string; items: T[]; render: (item: T, i: number) => React.ReactNode }) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, LIST_FIRST);
  return (
    <section className="card" aria-label={title}>
      <h2 className="border-b border-hairline px-4 py-3 font-serif text-[20px] leading-snug sm:px-5">{title}</h2>
      <ul className="divide-y divide-hairline">
        {shown.map((item, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 text-[13.5px] sm:px-5">
            {render(item, i)}
          </li>
        ))}
      </ul>
      {items.length > LIST_FIRST && (
        <div className="border-t border-hairline px-4 py-2.5 sm:px-5">
          <Button size="sm" variant="ghost" className="-ml-2 text-quiet" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${items.length.toLocaleString("en-US")}`}
          </Button>
        </div>
      )}
    </section>
  );
}

function Who({ row, source }: { row: ImportRow | undefined; source: ImportSource }) {
  if (!row) return <span className="font-medium">A contact</span>;
  const label = rowLabel(row, source);
  return (
    <span className="min-w-0 wrap-anywhere">
      <span className="font-medium">{rowName(row)}</span>
      {(row.company || label) && <span className="text-quiet"> · {[row.company, label].filter(Boolean).join(" · ")}</span>}
    </span>
  );
}

/** What an import did: leads added, people who were already leads, and rows left out, each with its reason. */
export function ResultView({ outcome, onAgain }: { outcome: ImportOutcome; onAgain: () => void }) {
  const { result, sent, source, error, notSent, leftOut, unchecked } = outcome;
  const skipped = [...result.skipped.map((s) => ({ row: sent[s.index], reason: s.reason })), ...leftOut];
  const created = [...result.createdRows].sort((a, b) => a.index - b.index);

  return (
    <div className="space-y-5">
      {error && (
        <Notice>
          <span className="font-medium">The import stopped part-way.</span> {error}
          {notSent > 0 && ` ${plural(notSent, "contact")} ${notSent === 1 ? "was" : "were"} not imported.`}
        </Notice>
      )}

      <div className="card px-4 py-5 sm:px-6">
        <h2 className="font-serif text-[24px] leading-snug">{result.created === 0 ? "No leads were added" : `${plural(result.created, "lead")} added`}</h2>
        <dl className="mt-3 grid grid-cols-3 gap-3 border-t border-hairline pt-3 sm:max-w-md">
          <Count label="Added" value={result.created} />
          <Count label="Already leads" value={result.duplicates.length} />
          <Count label="Skipped" value={skipped.length} />
        </dl>
        {unchecked > 0 && <p className="mt-3 text-[13px] text-quiet">{plural(unchecked, "contact")} you unticked {unchecked === 1 ? "was" : "were"} left out.</p>}
        <p className="mt-3 max-w-2xl text-[13.5px]">
          Importing does not start research. Research runs when someone opens a lead and presses Run research, up to 25 a day.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <ButtonLink href="/" variant="primary">
            Go to leads
          </ButtonLink>
          <Button onClick={onAgain}>Import more</Button>
        </div>
      </div>

      <ResultList
        title={`Added (${created.length.toLocaleString("en-US")})`}
        items={created}
        render={(c) => (
          <>
            <Who row={sent[c.index]} source={source} />
            <Link href={`/leads/${c.id}`} className="shrink-0 text-link underline-offset-2 hover:underline">
              Open lead
            </Link>
          </>
        )}
      />

      <ResultList
        title={`Already leads (${result.duplicates.length.toLocaleString("en-US")})`}
        items={result.duplicates}
        render={(d) => (
          <>
            <span className="min-w-0">
              <Who row={sent[d.index]} source={source} />
              <span className="block text-[13px] text-quiet">{d.reason}</span>
            </span>
            {d.existingId && (
              <Link href={`/leads/${d.existingId}`} className="shrink-0 text-link underline-offset-2 hover:underline">
                Open existing lead
              </Link>
            )}
          </>
        )}
      />

      <ResultList
        title={`Skipped (${skipped.length.toLocaleString("en-US")})`}
        items={skipped}
        render={(s) => (
          <span className="min-w-0">
            <Who row={s.row} source={source} />
            <span className="block text-[13px] text-quiet">{s.reason}</span>
          </span>
        )}
      />
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-0.5 text-[20px] tabular-nums">{value.toLocaleString("en-US")}</dd>
    </div>
  );
}
