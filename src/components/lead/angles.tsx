"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage, logEvent, markSent, updateLead } from "@/lib/api-client";
import { gmailComposeUrl } from "@/lib/compose";
import type { Angle, Finding, Lead } from "@/lib/types";
import { safeUrl } from "../format";
import { Button, ButtonLink, Chip, Label, Notice, cx } from "../ui";
import { Panel, PlainList, Sources, SubHeading } from "./panel";

const LINKEDIN_LIMIT = 300;
const CHANNEL_LABELS = { email: "Email", linkedin: "LinkedIn", either: "Email or LinkedIn" } as const;

/** Keep only angles that have the fields the editor reads, so odd rows cannot crash it. */
function cleanAngles(angles: Angle[]): Angle[] {
  return angles
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      ...a,
      name: typeof a.name === "string" ? a.name : "Angle",
      reasoning: typeof a.reasoning === "string" ? a.reasoning : "",
      findingIds: Array.isArray(a.findingIds) ? a.findingIds : [],
      email: { subject: a.email?.subject ?? "", body: a.email?.body ?? "" },
      linkedinMessage: typeof a.linkedinMessage === "string" ? a.linkedinMessage : "",
    }));
}

/**
 * A textarea that grows to show the whole draft, so the sign-off is never hidden
 * below the fold of a fixed-height box. `rows` is the minimum height.
 */
function AutoTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      // +2 for the top and bottom border, which scrollHeight leaves out.
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    // The text re-wraps when the column changes width (phone rotation, window resize).
    let width = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth !== width) {
        width = el.offsetWidth;
        fit();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea ref={ref} {...props} style={{ ...props.style, resize: "none", overflow: "hidden" }} />;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure origins: fall back to a hidden textarea.
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      el.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function AnglesSection({
  lead,
  findings,
  locked,
  onLeadChange,
  onActivity,
}: {
  lead: Lead;
  findings: Map<string, Finding>;
  /** True while research runs: the drafts are about to be replaced, so editing is off. */
  locked: boolean;
  onLeadChange: (lead: Lead) => void;
  onActivity: () => void;
}) {
  const serverKey = JSON.stringify(lead.angles);
  const [local, setLocal] = useState<Angle[]>(() => cleanAngles(lead.angles));
  const [syncedKey, setSyncedKey] = useState(serverKey);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Take new drafts from the server (a re-run, a steer) unless the person has
  // unsaved edits, which always win. Adjusting state during render is the
  // React-recommended way to reset state when a prop changes.
  if (serverKey !== syncedKey && !dirty && saveState !== "saving") {
    setSyncedKey(serverKey);
    setLocal(cleanAngles(lead.angles));
  }

  const version = useRef(0);
  const localRef = useRef(local);
  const dirtyRef = useRef(dirty);
  const savingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    localRef.current = local;
    dirtyRef.current = dirty;
  });

  async function save() {
    if (timer.current) clearTimeout(timer.current);
    if (!dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    const sentVersion = version.current;
    setSaveState("saving");
    setSaveError(null);
    try {
      const saved = await updateLead(lead.id, { angles: localRef.current });
      // Edits made while the request was in flight stay dirty and save next.
      if (version.current === sentVersion) {
        setDirty(false);
        dirtyRef.current = false;
        setSyncedKey(JSON.stringify(saved.angles));
      }
      setSaveState("saved");
      onLeadChange(saved);
    } catch (err) {
      setSaveState("error");
      setSaveError(errorMessage(err));
    } finally {
      savingRef.current = false;
      if (dirtyRef.current && version.current !== sentVersion) schedule();
    }
  }
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  function schedule() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), 900);
  }

  // Do not lose the last edit when leaving the page within the debounce window.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirtyRef.current) void updateLead(lead.id, { angles: localRef.current }).catch(() => {});
    };
  }, [lead.id]);

  function edit(id: string, change: (a: Angle) => Angle) {
    version.current += 1;
    setLocal((prev) => prev.map((a) => (a.id === id ? change(a) : a)));
    setDirty(true);
    dirtyRef.current = true;
    setSaveState("idle");
    schedule();
  }

  const recommendedId = lead.approach?.leadAngleId ?? null;
  const active = local.find((a) => a.id === activeId) ?? local.find((a) => a.id === recommendedId) ?? local[0] ?? null;

  if (!active) {
    return (
      <Panel title="Angles" id="angles">
        <p className="text-quiet">No angles were written. Re-run research, or use Steer below to tell the agent what to try.</p>
      </Panel>
    );
  }

  const profileUrl = safeUrl(lead.linkedinUrl);
  const liLength = active.linkedinMessage.length;
  const approach = lead.approach;

  async function copy(kind: "email" | "linkedin") {
    if (!active) return;
    const text = kind === "email" ? `${active.email.subject}\n\n${active.email.body}` : active.linkedinMessage;
    const ok = await copyText(text);
    if (!ok) {
      setActionError("Could not copy. Select the text and copy it by hand.");
      return;
    }
    setActionError(null);
    setCopied(kind);
    setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1800);
    // The copy itself already worked; logging it is best effort.
    logEvent(lead.id, "copied", `Copied the ${kind === "email" ? "email" : "LinkedIn message"} for "${active.name}"`).then(onActivity, () => {});
  }

  async function sent(channel: "email" | "linkedin") {
    if (!active || sending) return;
    setSending(true);
    setActionError(null);
    try {
      await saveRef.current();
      const updated = await markSent(lead.id, active.id, channel);
      onLeadChange(updated);
      onActivity();
      setSendOpen(false);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setSending(false);
    }
  }

  const status =
    locked ? "Editing is paused while research runs" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Not saved" : dirty ? "Unsaved changes" : saveState === "saved" ? "Saved" : "Edits save automatically";

  return (
    <Panel
      title="Angles"
      id="angles"
      aside={
        <span className={cx("text-[13px]", saveState === "error" ? "text-danger" : "text-quiet")} aria-live="polite">
          {status}
        </span>
      }
    >
      {approach && (approach.why || approach.dealBreakers?.length > 0) && (
        <div className="mb-4 rounded-lg bg-wash px-3.5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="eyebrow">Recommended approach</span>
            {approach.channel && <Chip>{CHANNEL_LABELS[approach.channel] ?? approach.channel}</Chip>}
          </div>
          {approach.why && <p className="mt-1.5">{approach.why}</p>}
          {Array.isArray(approach.dealBreakers) && approach.dealBreakers.length > 0 && (
            <div className="mt-3">
              <SubHeading>Deal breakers</SubHeading>
              <PlainList items={approach.dealBreakers} />
            </div>
          )}
          {Array.isArray(approach.firstCallQuestions) && approach.firstCallQuestions.length > 0 && !(lead.brief?.questions?.length) && (
            <div className="mt-3">
              <SubHeading>Questions for the first call</SubHeading>
              <PlainList items={approach.firstCallQuestions} />
            </div>
          )}
        </div>
      )}

      <div role="tablist" aria-label="Angles" className="-mx-4 flex gap-1 overflow-x-auto border-b border-hairline px-4 sm:-mx-5 sm:px-5">
        {local.map((a) => {
          const selected = a.id === active.id;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              id={`angle-tab-${a.id}`}
              aria-selected={selected}
              aria-controls="angle-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                setActiveId(a.id);
                setSendOpen(false);
                setActionError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const i = local.findIndex((x) => x.id === a.id);
                const next = local[(i + (e.key === "ArrowRight" ? 1 : local.length - 1)) % local.length];
                setActiveId(next.id);
                document.getElementById(`angle-tab-${next.id}`)?.focus();
              }}
              className={cx(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 pb-2.5 pt-1 text-[14px] transition-colors",
                selected ? "border-ink font-medium text-ink" : "border-transparent text-quiet hover:text-ink",
              )}
            >
              {a.name}
              {a.id === recommendedId && <Chip tone="solid" className="h-[18px] px-1.5 text-[10.5px]">Recommended</Chip>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id="angle-panel" aria-labelledby={`angle-tab-${active.id}`} className="pt-4">
        {active.reasoning && (
          <div className="mb-5">
            <SubHeading>Why this angle</SubHeading>
            <p>
              {active.reasoning}
              <Sources ids={active.findingIds} findings={findings} />
            </p>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <SubHeading>Email</SubHeading>
            <Label htmlFor="angle-subject">Subject</Label>
            <input
              id="angle-subject"
              className="field"
              value={active.email.subject}
              readOnly={locked}
              maxLength={300}
              onChange={(e) => edit(active.id, (a) => ({ ...a, email: { ...a.email, subject: e.target.value } }))}
              onBlur={() => void save()}
            />
            <div className="mt-3">
              <Label htmlFor="angle-body" hint={`${countWords(active.email.body)} words`}>
                Body
              </Label>
              <AutoTextarea
                id="angle-body"
                className="field"
                rows={8}
                value={active.email.body}
                readOnly={locked}
                maxLength={10000}
                onChange={(e) => edit(active.id, (a) => ({ ...a, email: { ...a.email, body: e.target.value } }))}
                onBlur={() => void save()}
              />
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => copy("email")}>{copied === "email" ? "Copied" : "Copy email"}</Button>
              <ButtonLink external href={gmailComposeUrl({ to: lead.email, subject: active.email.subject, body: active.email.body })} title={lead.email ? `To ${lead.email}` : "No email found: add the address in Gmail"}>
                Open in Gmail ↗
              </ButtonLink>
            </div>
            {!lead.email && <p className="mt-2 text-[13px] text-quiet">No email address was found, so the Gmail draft opens without a recipient.</p>}
          </div>

          <div>
            <SubHeading>LinkedIn</SubHeading>
            <Label htmlFor="angle-linkedin" hint={<span className={cx("tabular-nums", liLength > LINKEDIN_LIMIT && "font-medium text-danger")}>{liLength} / {LINKEDIN_LIMIT}</span>}>
              Message
            </Label>
            <AutoTextarea
              id="angle-linkedin"
              className="field"
              rows={5}
              value={active.linkedinMessage}
              readOnly={locked}
              maxLength={2000}
              aria-invalid={liLength > LINKEDIN_LIMIT || undefined}
              aria-describedby={liLength > LINKEDIN_LIMIT ? "angle-linkedin-help" : undefined}
              onChange={(e) => edit(active.id, (a) => ({ ...a, linkedinMessage: e.target.value }))}
              onBlur={() => void save()}
            />
            {liLength > LINKEDIN_LIMIT && (
              <p id="angle-linkedin-help" className="mt-1.5 text-[13px] text-danger">
                {liLength - LINKEDIN_LIMIT} over the limit for a connection note.
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => copy("linkedin")}>{copied === "linkedin" ? "Copied" : "Copy LinkedIn message"}</Button>
              {profileUrl && (
                <ButtonLink external href={profileUrl}>
                  Open LinkedIn profile ↗
                </ButtonLink>
              )}
            </div>
          </div>
        </div>

        {(saveError || actionError) && (
          <div className="mt-4">
            <Notice action={saveError ? <Button size="sm" onClick={() => void save()}>Retry save</Button> : undefined}>{saveError ? `Your edits were not saved: ${saveError}` : actionError}</Notice>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          {sendOpen ? (
            <>
              <span className="mr-1 text-[13.5px]">Sent by</span>
              <Button variant="primary" size="sm" busy={sending} onClick={() => sent("email")}>
                Email
              </Button>
              <Button variant="primary" size="sm" disabled={sending} onClick={() => sent("linkedin")}>
                LinkedIn
              </Button>
              <Button variant="ghost" size="sm" disabled={sending} onClick={() => setSendOpen(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button variant="primary" onClick={() => setSendOpen(true)} disabledReason={locked ? "Wait for research to finish before marking this as sent." : null}>
                Mark as sent
              </Button>
              <span className="text-[13px] text-quiet">Nothing is sent from here. Send it yourself, then mark it so the follow-up date is set.</span>
            </>
          )}
        </div>
      </div>
    </Panel>
  );
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}
