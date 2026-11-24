"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, errorMessage } from "@/lib/api-client";
import { Button, Label, Notice, cx } from "../ui";

/** The longest reason the research route accepts. */
export const FOCUS_MAX = 1200;

/**
 * Quick picks: the label on the chip, and the sentence it adds to the reason. Only what a re-run
 * can act on: a wrong person needs a new LinkedIn URL (a re-run reads the saved profile again),
 * and a missing email is Find email's job, not the agent's.
 */
export const RERUN_PICKS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "Dig deeper into their models and robots", text: "Dig deeper into the models they run and the robots they build." },
  { label: "Look for newer news", text: "Look for news from the last few months." },
  { label: "Angles feel generic", text: "The angles feel generic. Tie each one to something specific about them or their company." },
];

function withPick(text: string, pick: string): string {
  const base = text.trimEnd();
  return (base ? `${base}\n${pick}` : pick).slice(0, FOCUS_MAX);
}

function withoutPick(text: string, pick: string): string {
  return text
    .replace(pick, "")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\n+/, "")
    .trimEnd();
}

/**
 * Asks why the research is being run again before it starts. The reason goes to the agent,
 * which looks into it first. An empty reason is a plain re-run. With onWrongPerson, a link
 * sends a wrong profile to the LinkedIn URL field instead.
 */
export function RerunPanel({ onSubmit, onCancel, onWrongPerson }: { onSubmit: (focus: string, picks: number) => Promise<void>; onCancel: () => void; onWrongPerson?: () => void }) {
  const [focus, setFocus] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const text = focus.trim();
    try {
      await onSubmit(text, RERUN_PICKS.filter((p) => text.includes(p.text)).length);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409 ? "Research is already running for this lead." : errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-label="Re-run research">
      <form
        onSubmit={submit}
        className="px-4 py-4 sm:px-5"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onCancel();
        }}
      >
        <Label htmlFor="rerun-focus" hint={<span className="whitespace-nowrap tabular-nums">{focus.length.toLocaleString("en-US")} / 1,200</span>}>
          Why re-run, and what should the agent try again?
        </Label>
        <textarea
          ref={ref}
          id="rerun-focus"
          rows={3}
          className="field"
          maxLength={FOCUS_MAX}
          placeholder="Optional. For example: the brief is about someone else with the same name."
          value={focus}
          disabled={busy}
          onChange={(e) => setFocus(e.target.value)}
        />
        <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
          {RERUN_PICKS.map((p) => {
            const on = focus.includes(p.text);
            return (
              <button
                key={p.label}
                type="button"
                aria-pressed={on}
                disabled={busy}
                className={cx("chip h-auto min-h-[26px] whitespace-normal py-1 text-left leading-snug transition-colors", on ? "border-ink bg-ink text-white" : "hover:bg-wash")}
                onClick={() => {
                  setFocus((t) => (t.includes(p.text) ? withoutPick(t, p.text) : withPick(t, p.text)));
                  ref.current?.focus();
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {onWrongPerson && (
          <p className="mt-2.5 text-[13px] text-quiet">
            Wrong person? A re-run reads the same LinkedIn profile again, so{" "}
            <button type="button" className="text-ink underline underline-offset-2 hover:no-underline disabled:opacity-60" disabled={busy} onClick={onWrongPerson}>
              change their LinkedIn URL
            </button>{" "}
            first.
          </p>
        )}
        {error && (
          <div className="mt-3">
            <Notice>{error}</Notice>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            Re-run research
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <span className="text-[13px] text-quiet">The agent looks into this first. Leave it empty for a plain re-run.</span>
        </div>
      </form>
    </section>
  );
}
