"use client";

import { useEffect, useId, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { ApiError, errorMessage, findEmail, getStatusCached, updateLead } from "@/lib/api-client";
import { looksLikeEmail } from "@/lib/import/columns";
import type { EmailStatus, Lead } from "@/lib/types";
import { normalizeLinkedinUrl } from "../format";
import { Button, ButtonLink, Chip, Label, Notice, cx } from "../ui";

/* ---------- LinkedIn ---------- */

/** Marks a lead whose profile is not known yet (an imported contact). */
export function NoLinkedinChip({ className }: { className?: string }) {
  return (
    <Chip tone="quiet" className={className} title="Research will try to find their profile from the name and company.">
      No LinkedIn yet
    </Chip>
  );
}

const NOT_A_PROFILE = "That does not look like a LinkedIn profile URL (linkedin.com/in/...).";

/**
 * Adds or changes the lead's LinkedIn URL. Shows the server's message when it refuses, and a
 * link to the other lead when that profile is already taken. Escape cancels when it can.
 */
export function LinkedinForm({
  lead,
  label,
  onLeadChange,
  onDone,
  onCancel,
  autoFocus,
}: {
  lead: Lead;
  label: string;
  onLeadChange: (lead: Lead) => void;
  onDone?: () => void;
  onCancel?: () => void;
  /** Focus the field when the form opens (it was opened on purpose, not shown by default). */
  autoFocus?: boolean;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(lead.linkedinUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setExistingId(null);
    const url = normalizeLinkedinUrl(value);
    if (!url) {
      setError(value.trim() ? NOT_A_PROFILE : "Paste the person's LinkedIn profile URL.");
      return;
    }
    if (url === lead.linkedinUrl) {
      onDone?.();
      return;
    }
    setBusy(true);
    try {
      const saved = await updateLead(lead.id, { linkedinUrl: url });
      if (!lead.linkedinUrl) track("linkedin_url_added");
      onLeadChange(saved);
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.existingId) setExistingId(err.existingId);
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // The row layout follows the form's own width, not the screen's: in the 296 px Details panel
    // the field stacks above the buttons, so the URL stays readable.
    <form onSubmit={onSubmit} noValidate className="@container">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex flex-col gap-2 @sm:flex-row">
        <input
          ref={inputRef}
          id={id}
          type="url"
          inputMode="url"
          autoComplete="off"
          className="field min-w-0"
          placeholder="https://www.linkedin.com/in/their-name"
          maxLength={500}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            setExistingId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && onCancel && !busy) onCancel();
          }}
        />
        <div className="flex shrink-0 gap-2">
          <Button type="submit" variant="primary" busy={busy}>
            Save
          </Button>
          {onCancel && (
            <Button onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <Notice action={existingId ? <ButtonLink href={`/leads/${existingId}`} size="sm">Open that lead</ButtonLink> : undefined}>{error}</Notice>
        </div>
      )}
    </form>
  );
}

/** Shown on a lead with no LinkedIn URL: add it here, or let research look for it. */
export function AddLinkedinCard({ lead, onLeadChange }: { lead: Lead; onLeadChange: (lead: Lead) => void }) {
  return (
    <section className="card px-4 py-4 sm:px-5" aria-label="Add LinkedIn URL">
      <LinkedinForm lead={lead} label="Add LinkedIn URL" onLeadChange={onLeadChange} />
      <p className="mt-2.5 text-[13px] text-quiet">
        This lead has no LinkedIn profile yet. Research will try to find it from their name and company. If you know the URL, add it here first.
      </p>
    </section>
  );
}

/* ---------- Email ---------- */

/** What kind of address the lead has, in full and in a few words. */
export const EMAIL_KINDS: Record<EmailStatus, { full: string; short: string }> = {
  found: { full: "Found by Hunter", short: "Found by Hunter" },
  verified: { full: "Verified from the company's email pattern", short: "Verified" },
  guess: { full: "Guess from the company's email pattern, not verified", short: "Guess, not verified" },
  imported: { full: "Imported", short: "Imported" },
  manual: { full: "Added by you", short: "Added by you" },
};

function confidenceText(lead: Pick<Lead, "emailConfidence">): string | null {
  return typeof lead.emailConfidence === "number" ? `${Math.round(lead.emailConfidence)}% sure` : null;
}

/** "Guess, not verified · 50% sure", or whichever part is known. Empty when nothing is. */
export function emailKindText(lead: Pick<Lead, "emailStatus" | "emailConfidence">, length: "full" | "short" = "full"): string {
  const kind = lead.emailStatus ? EMAIL_KINDS[lead.emailStatus]?.[length] : null;
  return [kind, confidenceText(lead)].filter(Boolean).join(" · ");
}

/**
 * The lead's email: the address with its kind, a way to change it, and "Find email" when
 * there is none. `variant="to"` is the one-line form shown next to Open in Gmail.
 */
export function EmailControl({
  lead,
  variant = "panel",
  running,
  onLeadChange,
  onActivity,
}: {
  lead: Lead;
  variant?: "panel" | "to";
  /** Research is running: it looks up the email itself, so a lookup would be refused. */
  running?: boolean;
  onLeadChange: (lead: Lead) => void;
  /** A lookup logs an event: lets the page refresh its activity list. */
  onActivity?: () => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ found: boolean; message: string } | null>(null);
  const [hunterOff, setHunterOff] = useState(false);

  useEffect(() => {
    let alive = true;
    getStatusCached().then(
      (s) => alive && setHunterOff(s.providers.some((p) => p.id === "hunter" && !p.configured)),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // When the form closes, focus goes back to the control that opens it, which mounts again
  // (Change, Edit or Add email): keyboard and screen-reader users keep their place.
  const returnFocus = useRef(false);
  const focusOnReturn = (el: HTMLElement | null) => {
    if (el && returnFocus.current) {
      returnFocus.current = false;
      el.focus();
    }
  };
  function close() {
    returnFocus.current = true;
    setEditing(false);
  }

  function startEdit() {
    setDraft(lead.email ?? "");
    setError(null);
    setResult(null);
    setEditing(true);
  }

  async function save(next: string | null) {
    if (saving) return;
    if (next !== null && !looksLikeEmail(next)) {
      setError("That does not look like an email address.");
      return;
    }
    if (next === lead.email) {
      close();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onLeadChange(await updateLead(lead.id, { email: next }));
      track("email_edited");
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function find() {
    if (finding) return;
    setFinding(true);
    setError(null);
    setResult(null);
    try {
      const res = await findEmail(lead.id);
      track("email_lookup_requested", { found: Boolean(res.email) });
      onLeadChange(res.lead);
      setResult({ found: Boolean(res.email), message: res.message || (res.email ? "Email found." : "No email found.") });
      onActivity?.();
    } catch (err) {
      track("email_lookup_requested", { found: false });
      setError(errorMessage(err));
    } finally {
      setFinding(false);
    }
  }

  const to = variant === "to";
  const kind = emailKindText(lead, "full");
  const findReason = running ? "Research is running. It looks up the email itself." : hunterOff ? "Email lookup is off: Hunter is not set up on the server." : null;

  if (editing) {
    return (
      <form
        className={cx(to && "mt-3")}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save(draft.trim().toLowerCase() || null);
        }}
      >
        <Label htmlFor={inputId}>{lead.email ? "Change email" : "Add email"}</Label>
        <div className={cx("flex gap-2", to ? "flex-col sm:flex-row" : "flex-col")}>
          <input
            ref={inputRef}
            id={inputId}
            type="email"
            inputMode="email"
            autoComplete="off"
            className="field min-w-0"
            placeholder="name@company.com"
            maxLength={320}
            value={draft}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Escape" && !saving && close()}
          />
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="submit" variant="primary" size={to ? "md" : "sm"} busy={saving}>
              Save
            </Button>
            <Button size={to ? "md" : "sm"} disabled={saving} onClick={close}>
              Cancel
            </Button>
            {lead.email && (
              <Button variant="ghost" size={to ? "md" : "sm"} className="text-quiet" disabled={saving} onClick={() => void save(null)}>
                Remove
              </Button>
            )}
          </div>
        </div>
        {error && <p className="mt-1.5 text-[13px] text-danger" role="alert">{error}</p>}
      </form>
    );
  }

  const feedback = (
    <>
      {result && <p className={cx("mt-1.5 text-[13px]", result.found ? "text-success" : "text-quiet")} role="status">{result.message}</p>}
      {error && <p className="mt-1.5 text-[13px] text-danger" role="alert">{error}</p>}
    </>
  );

  if (to) {
    return (
      <div className="mt-3 text-[13.5px]">
        {lead.email ? (
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 wrap-anywhere">
              <span className="text-quiet">To:</span> {lead.email}
            </span>
            {kind && <span className={cx("text-[13px]", lead.emailStatus === "guess" ? "text-ink" : "text-quiet")}>{kind}</span>}
            <button ref={focusOnReturn} type="button" className="text-[13px] text-quiet underline underline-offset-2 hover:text-ink" onClick={startEdit}>
              Change
            </button>
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-quiet">No email yet. Gmail opens without a recipient.</span>
            <span className="flex flex-wrap gap-2">
              <Button size="sm" busy={finding} disabledReason={findReason} onClick={() => void find()}>
                {finding ? "Looking…" : "Find email"}
              </Button>
              <Button ref={focusOnReturn} size="sm" disabled={finding} onClick={startEdit}>
                Add email
              </Button>
            </span>
          </div>
        )}
        {feedback}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-medium">
        <span>Email</span>
        {lead.email && (
          <button ref={focusOnReturn} type="button" className="font-normal text-quiet underline underline-offset-2 hover:text-ink" onClick={startEdit}>
            Edit
          </button>
        )}
      </div>
      {lead.email ? (
        <>
          <a href={`mailto:${encodeURIComponent(lead.email)}`} className="block text-link underline-offset-2 wrap-anywhere hover:underline">
            {lead.email}
          </a>
          {kind && <p className="mt-0.5 text-[13px] text-quiet">{kind}</p>}
        </>
      ) : (
        <>
          <p className="text-quiet">No email yet</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" busy={finding} disabledReason={findReason} onClick={() => void find()}>
              {finding ? "Looking…" : "Find email"}
            </Button>
            <Button ref={focusOnReturn} size="sm" disabled={finding} onClick={startEdit}>
              Add email
            </Button>
          </div>
        </>
      )}
      {feedback}
    </div>
  );
}
