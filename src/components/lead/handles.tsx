"use client";

import { useState } from "react";
import { Label } from "../ui";

/**
 * A lead's public handle on X or Instagram, in the Details panel. Saves when focus leaves it, like
 * the other fields there. A value the server refuses stays in the field, with the reason under it.
 * `clean` returns the handle as it is saved, or null for one that cannot be a handle.
 */
export function HandleField({
  id,
  label,
  initial,
  placeholder,
  maxLength,
  note,
  clean,
  invalid,
  onSave,
}: {
  id: string;
  label: string;
  /** The saved handle without "@", or "". */
  initial: string;
  placeholder: string;
  maxLength: number;
  /** A quiet line under the field, e.g. where a handle came from. */
  note?: string;
  clean: (value: string) => string | null;
  /** What to say about a value `clean` refuses. */
  invalid: (value: string) => string;
  /** Saves the handle (null clears it). Resolves to null when saved, else to the reason it was not. */
  onSave: (handle: string | null) => Promise<string | null>;
}) {
  const [value, setValue] = useState(initial);
  const [seen, setSeen] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  // The saved handle changed underneath (a save came back, research found one): follow it unless mid-edit.
  if (initial !== seen) {
    setSeen(initial);
    if (value === seen || clean(value) === initial) setValue(initial);
  }

  async function commit() {
    if (state === "saving") return;
    const typed = value.trim();
    const next = typed ? clean(typed) : "";
    if (next === null) {
      setError(invalid(typed));
      return;
    }
    setError(null);
    if (next === initial) {
      setValue(initial);
      return;
    }
    setState("saving");
    const problem = await onSave(next || null);
    if (problem) {
      setError(problem);
      setState("idle");
      return;
    }
    setValue(next);
    setState("saved");
  }

  const hint = state === "saving" ? "Saving…" : error ? undefined : state === "saved" && value === initial ? "Saved" : value.trim().replace(/^@/, "") !== initial ? "Unsaved" : undefined;
  return (
    <div>
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-quiet">
          @
        </span>
        <input
          id={id}
          className="field pl-[26px]"
          maxLength={maxLength}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : note ? `${id}-note` : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
            setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-[13px] text-danger">
          {error}
        </p>
      ) : (
        note && (
          <p id={`${id}-note`} className="mt-1.5 text-[13px] text-quiet">
            {note}
          </p>
        )
      )}
    </div>
  );
}
