"use client";

import { useId, useState } from "react";
import { UNQUALIFIED_REASONS, type Lead, type UnqualifiedReasonKey } from "@/lib/types";
import { formatDate } from "@/components/format";
import { Button, Modal, Notice, cx } from "@/components/ui";

/** "1 lead", "3 leads". */
export function leadCount(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "lead" : "leads"}`;
}

/** The text saved for a quick pick (the database stores the label, not the key). */
export function reasonLabel(key: UnqualifiedReasonKey | null): string | null {
  return UNQUALIFIED_REASONS.find((r) => r.key === key)?.label ?? null;
}

/** "Not a fit · Marked Nov 20": why and when a lead was marked, as the lists and the lead page say it. */
export function unqualifiedSummary(lead: Pick<Lead, "unqualifiedReason" | "unqualifiedAt">): { reason: string; marked: string } {
  const date = formatDate(lead.unqualifiedAt);
  return { reason: lead.unqualifiedReason?.trim() || "No reason given", marked: date ? `Marked ${date}` : "Marked just now" };
}

/** Quick picks for why a lead is not a fit. One at most; pressing the chosen one again clears it. */
export function ReasonChips({ value, onChange, disabled, labelledBy }: { value: UnqualifiedReasonKey | null; onChange: (key: UnqualifiedReasonKey | null) => void; disabled?: boolean; labelledBy?: string }) {
  return (
    <div role="group" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : "Reason (optional)"} className="flex flex-wrap gap-1.5">
      {UNQUALIFIED_REASONS.map((r) => {
        const on = r.key === value;
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? null : r.key)}
            className={cx(
              "h-8 rounded-full border px-3 text-[13px] transition-colors disabled:opacity-60",
              on ? "border-ink bg-ink text-white" : "border-hairline bg-white text-ink hover:border-[#d3d3cc] hover:bg-wash",
            )}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Asks why leads are not a fit (optional) before marking them unqualified. Each opening starts
 * with no reason picked. `note`: a sentence to add, such as how many of them a search hides.
 */
export function UnqualifyDialog({
  open,
  count,
  note,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  count: number;
  note?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: UnqualifiedReasonKey | null) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<UnqualifiedReasonKey | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setReason(null);
  }
  const titleId = useId();
  const one = count === 1;
  return (
    <Modal open={open} busy={busy} onClose={onCancel} labelledBy={titleId}>
      <div className="p-5">
        <h2 id={titleId} className="font-serif text-[21px] leading-snug">
          {one ? "Why is this lead not a fit?" : "Why are these leads not a fit?"}
        </h2>
        <p className="mt-2 text-quiet">
          Pick a reason if you like. {one ? "The lead leaves" : "They leave"} Active and the pipeline, and imports keep skipping {one ? "it" : "them"}. You can restore {one ? "it" : "them"} any time.
          {note}
        </p>
        <div className="mt-4">
          <ReasonChips value={reason} onChange={setReason} disabled={busy} />
        </div>
        {error && (
          <div className="mt-4">
            <Notice>{error}</Notice>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onConfirm(reason)} busy={busy}>
            Mark {leadCount(count)} unqualified
          </Button>
        </div>
      </div>
    </Modal>
  );
}
