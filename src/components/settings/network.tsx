"use client";

import { useEffect, useId, useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { ConnectionsUploadError, deleteConnections, errorMessage, getNetwork, readOwnProfile, syncX, uploadConnections } from "@/lib/api-client";
import { normaliseLinkedinUrl } from "@/lib/linkedin-url";
import { shortDate } from "@/lib/paths/copy";
import { connectionTuples, parseConnectionsCsv } from "@/lib/paths/csv";
import { cleanInstagramHandle, isReservedInstagramPath } from "@/lib/paths/links";
import type { NetworkStatus } from "@/lib/paths/types";
import { cleanXHandle } from "@/lib/research/util";
import type { Settings } from "@/lib/types";
import { timeAgo } from "@/components/format";
import { Button, Chip, ConfirmDialog, Label, Notice, Skeleton, cx } from "@/components/ui";
import { useLoad } from "@/components/use-load";

/** The three Settings fields this section edits. They save with the rest of the form. */
export type NetworkField = "linkedinUrl" | "xHandle" | "instagramHandle";
export type NetworkFieldErrors = Partial<Record<NetworkField, string>>;

/** The same rules as PUT /api/settings (cleanNetworkSettings), so a mistake shows before saving. */
export function networkFieldErrors(form: Pick<Settings, NetworkField>): NetworkFieldErrors {
  const errors: NetworkFieldErrors = {};
  const url = form.linkedinUrl.trim();
  if (url && !normaliseLinkedinUrl(url)) errors.linkedinUrl = "Use your profile link, such as linkedin.com/in/your-name.";
  const x = form.xHandle.trim();
  if (x && !cleanXHandle(x)) errors.xHandle = "Letters, digits and _ only, up to 15.";
  const ig = form.instagramHandle.trim();
  if (ig && !cleanInstagramHandle(ig)) {
    errors.instagramHandle = isReservedInstagramPath(ig) ? "That is an Instagram page, not a username." : "Letters, digits, dots and _ only, up to 30.";
  }
  return errors;
}

/** The notice for a deploy without a password (the wording the README uses). */
export const OPEN_NOTICE = "While Lead Engine is open to anyone with its link, they can see the people shown on lead pages. Set APP_PASSWORD to close it.";

/** A file far larger than 30,000 connections can be is not read at all. */
const MAX_FILE_BYTES = 30 * 1024 * 1024;

const count = (n: number) => n.toLocaleString("en-US");
/** "$0.18", "$1.00": the day's X budget always shows cents. */
const money = (n: number) => `$${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
const people = (n: number) => `${count(n)} ${n === 1 ? "connection" : "connections"}`;

/** "3 pm" today, "Nov 26, 3 pm" another day. */
function untilText(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined }).toLowerCase();
  return d.toDateString() === new Date(now).toDateString() ? time : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

type UploadState =
  | { step: "idle" }
  | { step: "reading" }
  | { step: "sending"; part: number; parts: number; sent: number; total: number }
  | { step: "done"; total: number; skipped: number; connectedLeads: number }
  | { step: "error"; message: string };

/**
 * Settings > Your network: where research looks for people who can introduce you. The three
 * handles belong to the Settings form and save with it; the upload, Read now and Refresh now act
 * at once and use what is saved. Only counts and states are shown: GET /api/network never returns
 * a contact. Connections.csv is read in this browser, and its email column is never sent.
 */
export function NetworkSettings({
  form,
  saved,
  set,
  errors,
  serverError,
  open,
  accountUnknown,
}: {
  form: Settings;
  saved: Settings;
  set: (key: NetworkField, value: string) => void;
  /** Mistakes in what is typed (networkFieldErrors). */
  errors: NetworkFieldErrors;
  /** The field the server refused on the last save, with its message. */
  serverError: { field: NetworkField; message: string } | null;
  /** True when no team password is set; null while that is not known. */
  open: boolean | null;
  /** True when Unipile did not answer (GET /api/status), so the state of your LinkedIn account is not known. */
  accountUnknown: boolean;
}) {
  const network = useLoad(getNetwork, (n) => (n?.x.running ? 3000 : null));
  const { reload } = network;
  const [now, setNow] = useState(() => Date.now());

  // What is stored follows the saved handles: a new X handle drops the lists, a new URL the read.
  const savedKey = `${saved.linkedinUrl}|${saved.xHandle}|${saved.instagramHandle}`;
  const firstKey = useRef(savedKey);
  useEffect(() => {
    if (firstKey.current === savedKey) return;
    firstKey.current = savedKey;
    void reload();
  }, [savedKey, reload]);

  // "refreshed 3h ago" stays true while the page is open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // The section arrives after the settings load, so the browser's own jump to #network misses it.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (globalThis.location?.hash === "#network") ref.current?.scrollIntoView({ block: "start" });
  }, []);

  const data = network.data;
  const fieldError = (field: NetworkField) => errors[field] ?? (serverError?.field === field ? serverError.message : null);

  return (
    <section ref={ref} id="network" className="card scroll-mt-32 sm:scroll-mt-20" aria-labelledby="network-title">
      <div className="border-b border-hairline px-5 py-4">
        <h2 id="network-title" className="font-serif text-[20px] leading-snug">
          Your network
        </h2>
        <p className="mt-0.5 text-[13.5px] text-quiet">Research uses these to find people who can introduce you. Read only: nothing is posted, followed or sent.</p>
      </div>
      <div className="divide-y divide-hairline">
        {open === true && (
          <div className="p-5">
            <Notice tone="info">{OPEN_NOTICE}</Notice>
          </div>
        )}
        {!network.loading && !data && (
          <div className="p-5">
            <Notice action={<Button size="sm" onClick={() => void reload()}>Try again</Button>}>Could not load your network: {network.error ?? "unknown error"}</Notice>
          </div>
        )}

        <Group title="LinkedIn">
          <OwnProfile
            value={form.linkedinUrl}
            savedValue={saved.linkedinUrl}
            onChange={(v) => set("linkedinUrl", v)}
            error={fieldError("linkedinUrl")}
            self={data?.linkedin.self ?? null}
            loading={network.loading}
            onRead={reload}
          />
          <Connections connections={data?.linkedin.connections ?? null} loading={network.loading} loaded={Boolean(data)} onChanged={reload} />
          <OwnAccount account={data?.linkedin.account ?? null} unknown={accountUnknown} loading={network.loading} now={now} />
        </Group>

        <Group title="X">
          <OwnX
            value={form.xHandle}
            savedValue={saved.xHandle}
            onChange={(v) => set("xHandle", v)}
            error={fieldError("xHandle")}
            x={data?.x ?? null}
            loading={network.loading}
            now={now}
            onSynced={reload}
          />
        </Group>

        <Group title="Instagram" optional>
          {/* One block, so the error and the help sit under the field (Group spaces its children apart). */}
          <div>
            <div className="max-w-sm">
              <Label htmlFor="instagramHandle">Your Instagram handle</Label>
              <HandleInput id="instagramHandle" value={form.instagramHandle} maxLength={30} onChange={(v) => set("instagramHandle", v)} error={fieldError("instagramHandle")} describedBy="instagramHandle-help" />
            </div>
            <FieldError id="instagramHandle-error" message={fieldError("instagramHandle")} />
            <p id="instagramHandle-help" className="mt-1.5 text-[13px] text-quiet">
              Only used to show an Instagram row on leads. Instagram&rsquo;s lists are never read.
            </p>
          </div>
        </Group>
      </div>
    </section>
  );
}

function Group({ title, optional, children }: { title: string; optional?: boolean; children: React.ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="p-5">
      <h3 id={id} className="mb-4 text-[15px] font-semibold">
        {title}
        {optional && <span className="ml-1.5 font-normal text-quiet">(optional)</span>}
      </h3>
      <div className="space-y-6">{children}</div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1.5 text-[13px] text-danger">
      {message}
    </p>
  );
}

/** A handle field with a fixed "@" in front. A typed or pasted "@" is dropped. */
function HandleInput({ id, value, maxLength, onChange, error, describedBy }: { id: string; value: string; maxLength: number; onChange: (value: string) => void; error: string | null; describedBy?: string }) {
  return (
    <div className="relative">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 flex w-8 items-center justify-center text-quiet">
        @
      </span>
      <input
        id={id}
        className="field pl-8"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        // Room for a pasted profile link; the handle itself is checked against its own length.
        maxLength={Math.max(maxLength, 200)}
        value={value}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={[error ? `${id}-error` : null, describedBy].filter(Boolean).join(" ") || undefined}
        onChange={(e) => onChange(e.target.value.replace(/^\s*@+/, ""))}
      />
    </div>
  );
}

// ------------------------------------------------------------------ LinkedIn: your profile

function OwnProfile({
  value,
  savedValue,
  onChange,
  error,
  self,
  loading,
  onRead,
}: {
  value: string;
  savedValue: string;
  onChange: (value: string) => void;
  error: string | null;
  self: NetworkStatus["linkedin"]["self"];
  loading: boolean;
  onRead: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const unsaved = value.trim() !== savedValue.trim();
  // The button is disabled while it reads, which drops focus: give it back once the read settles.
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) button.current?.focus();
  }, [busy]);

  async function read() {
    if (busy) return;
    refocus.current = true;
    setBusy(true);
    setFailure(null);
    setDone(false);
    try {
      await readOwnProfile();
      setDone(true);
    } catch (err) {
      setFailure(errorMessage(err));
    }
    await onRead();
    setBusy(false);
  }

  const reason = unsaved ? "Save settings first." : !savedValue.trim() ? "Add your profile link and save first." : null;
  const counts = self?.readAt
    ? `Read ${shortDate(self.readAt)}: ${count(self.roles)} ${self.roles === 1 ? "role" : "roles"}, ${count(self.schools)} ${self.schools === 1 ? "school" : "schools"}.`
    : null;

  return (
    <div>
      <Label htmlFor="linkedinUrl">Your LinkedIn profile</Label>
      <div className="flex flex-wrap items-start gap-2">
        <input
          id="linkedinUrl"
          type="url"
          inputMode="url"
          className="field min-w-0 flex-1 basis-64"
          placeholder="https://www.linkedin.com/in/your-name"
          autoComplete="off"
          spellCheck={false}
          maxLength={300}
          value={value}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={`${error ? "linkedinUrl-error " : ""}linkedinUrl-help`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button ref={button} onClick={() => void read()} busy={busy} disabledReason={busy ? null : reason} tipEnd>
          {busy ? "Reading…" : "Read now"}
        </Button>
      </div>
      <FieldError id="linkedinUrl-error" message={error} />
      <div id="linkedinUrl-help" className="mt-1.5 text-[13px] text-quiet" aria-live="polite">
        {busy ? (
          "Reading your profile. This can take a few minutes."
        ) : loading ? (
          <Skeleton className="h-3.5 w-56" />
        ) : unsaved ? (
          "Read once a month for your roles and schools. Save settings, then use Read now."
        ) : counts ? (
          <>
            {done ? <span className="text-success">{counts}</span> : counts} It is read again once a month.
          </>
        ) : (
          "Read once a month for your roles and schools, to find where you and a lead overlap."
        )}
      </div>
      {!busy && !failure && !unsaved && self?.error && !self.readAt && <p className="mt-1.5 text-[13px] text-danger">The last read failed. Use Read now to try again.</p>}
      {failure && (
        <div className="mt-2.5">
          <Notice>{failure}</Notice>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ LinkedIn: your connections

function ExportSteps() {
  return (
    <>
      On a computer: Me &gt; Settings &amp; Privacy &gt; Data privacy &gt; Download your data &gt; Connections &gt; Request archive. LinkedIn emails a link within 48 hours; it works for 72 hours. Unzip it and choose
      Connections.csv.
    </>
  );
}

function Connections({ connections, loading, loaded, onChanged }: { connections: NetworkStatus["linkedin"]["connections"]; loading: boolean; loaded: boolean; onChanged: () => Promise<void> }) {
  const [state, setState] = useState<UploadState>({ step: "idle" });
  const [confirm, setConfirm] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const working = state.step === "reading" || state.step === "sending";
  const refocus = useRef(false);

  async function onFile(file: File | undefined) {
    if (!file || working) return;
    setRemoved(null);
    refocus.current = true;
    setState({ step: "reading" });
    try {
      if (file.size > MAX_FILE_BYTES) throw new Error("This file is too large to be Connections.csv. Choose the file from LinkedIn's export.");
      // Read and parsed here, in the browser. Only the rows below are sent: the email column is never read.
      const parsed = parseConnectionsCsv(await file.text());
      if (parsed.error) throw new Error(parsed.error);
      const rows = connectionTuples(parsed.rows);
      setState({ step: "sending", part: 1, parts: 0, sent: 0, total: rows.length });
      const result = await uploadConnections(rows, {
        exportedAt: file.lastModified || null,
        onProgress: (p) => setState({ step: "sending", part: Math.min(p.part + 1, p.parts), parts: p.parts, sent: p.sent, total: p.total }),
      });
      track("network_connections_uploaded", { count: result.total });
      await onChanged();
      setState({ step: "done", total: result.total, skipped: parsed.skipped.noUrl + parsed.skipped.duplicate + parsed.skipped.overLimit, connectedLeads: result.connectedLeads });
    } catch (err) {
      const message = err instanceof ConnectionsUploadError && err.parts > 1 ? `Part ${err.part} of ${err.parts} did not upload. ${err.message}` : errorMessage(err);
      setState({ step: "error", message });
      // Some parts may be stored already: show what the server holds now.
      if (err instanceof ConnectionsUploadError) await onChanged();
    }
  }

  // The button is disabled while a file uploads, which drops focus: give it back once it is live again.
  useEffect(() => {
    if (working || !refocus.current) return;
    refocus.current = false;
    choose.current?.focus();
  }, [working]);

  // After Remove, the button that opened the dialog is gone: focus the one that takes its place,
  // once the dialog has closed (its own effect closes it first, which would drop focus again).
  const focusChoose = useRef(false);
  useEffect(() => {
    if (confirm || !focusChoose.current) return;
    focusChoose.current = false;
    choose.current?.focus();
  }, [confirm]);

  async function remove() {
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await deleteConnections();
      await onChanged();
      setRemoved(res.removed);
      setState({ step: "idle" });
      focusChoose.current = true;
      setConfirm(false);
    } catch (err) {
      setRemoveError(errorMessage(err));
    } finally {
      setRemoving(false);
    }
  }

  const when = connections ? shortDate(connections.exportedAt) : "";
  const uploadedOn = connections ? shortDate(connections.uploadedAt) : "";

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium">Your connections</h4>
        {loading ? (
          <Skeleton className="h-5 w-24 rounded-full" />
        ) : loaded ? (
          <Chip tone={connections ? "success" : "quiet"}>
            <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", connections ? "bg-success" : "bg-hairline")} />
            {connections ? "Uploaded" : "Not uploaded"}
          </Chip>
        ) : null}
      </div>

      {loading ? (
        <Skeleton className="h-3.5 w-64" />
      ) : connections ? (
        <>
          <p>
            <span className="font-medium">{people(connections.count)}</span>
            {when ? `, export of ${when}` : uploadedOn ? `, uploaded ${uploadedOn}` : ""}
          </p>
          <p className="mt-1 text-[13px] text-quiet">Upload a new export about once a month. The new file replaces this one.</p>
          <details className="mt-1 text-[13px] text-quiet">
            <summary className="cursor-pointer underline-offset-2 hover:underline">How to get the file</summary>
            <p className="mt-1">
              <ExportSteps />
            </p>
          </details>
        </>
      ) : (
        <p className="text-[13.5px] text-quiet">
          <ExportSteps />
        </p>
      )}
      <p className="mt-1 text-[13px] text-quiet">The file is read in this browser. Email addresses never leave it.</p>

      <input ref={input} type="file" accept=".csv,text/csv" hidden aria-label="Connections.csv" data-testid="connections-file" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; void onFile(file); }} />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button ref={choose} onClick={() => input.current?.click()} busy={working} disabled={removing}>
          {working ? "Uploading…" : connections ? "Upload a new file" : "Choose Connections.csv"}
        </Button>
        {connections && (
          <Button variant="danger" onClick={() => { setRemoveError(null); setConfirm(true); }} disabled={working}>
            Remove
          </Button>
        )}
      </div>

      <div className="mt-2.5 text-[13.5px] empty:hidden" role="status" aria-live="polite">
        {state.step === "reading" ? (
          "Reading the file…"
        ) : state.step === "sending" ? (
          <>
            <span>{state.parts > 1 ? `Uploading part ${state.part} of ${state.parts}. ` : "Uploading. "}</span>
            <span className="text-quiet">
              {count(state.sent)} of {people(state.total)} sent.
            </span>
            <span
              className="mt-1.5 block h-1 w-full max-w-sm overflow-hidden rounded-full bg-hairline"
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={state.total}
              aria-valuenow={state.sent}
            >
              <span className="block h-full rounded-full bg-ink transition-[width]" style={{ width: `${state.total ? Math.round((state.sent / state.total) * 100) : 0}%` }} />
            </span>
          </>
        ) : state.step === "done" ? (
          <span className="text-success">
            {people(state.total)} uploaded.
            {state.skipped > 0 ? ` ${count(state.skipped)} ${state.skipped === 1 ? "row was" : "rows were"} left out (no profile link, or listed twice).` : ""}
            {state.connectedLeads > 0 ? ` ${count(state.connectedLeads)} of your leads ${state.connectedLeads === 1 ? "is" : "are"} among them.` : ""}
          </span>
        ) : removed !== null ? (
          <span>{removed > 0 ? `${people(removed)} removed.` : "Your connections are removed."}</span>
        ) : null}
      </div>
      {state.step === "error" && (
        <div className="mt-2.5">
          <Notice>{state.message}</Notice>
        </div>
      )}

      <ConfirmDialog open={confirm} title="Remove your connections?" confirmLabel="Remove" busy={removing} error={removeError} onConfirm={() => void remove()} onCancel={() => setConfirm(false)}>
        This removes the {connections ? people(connections.count) : "connections"} stored here and the warm paths found from them. Nothing changes on LinkedIn. You can upload the file again at any time.
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------ LinkedIn: your account

function OwnAccount({ account, unknown, loading, now }: { account: NetworkStatus["linkedin"]["account"] | null; unknown: boolean; loading: boolean; now: number }) {
  // GET /api/network says "needs_reconnect" for anything that is not connected, also when Unipile
  // itself did not answer. GET /api/status tells the two apart.
  const state = account?.state === "needs_reconnect" && unknown ? "unknown" : (account?.state ?? "not_set_up");
  const plan = account?.salesNavigator ? "Sales Navigator" : account?.premium === true ? "Premium" : account?.premium === false ? "free account" : null;
  const label =
    state === "connected"
      ? `Connected${plan ? ` (${plan})` : ""}`
      : state === "needs_reconnect"
        ? "Needs reconnecting"
        : state === "paused"
          ? `Paused${account?.pausedUntil ? ` until ${untilText(account.pausedUntil, now)}` : ""}`
          : state === "unknown"
            ? "Could not check"
            : "Not set up";
  const limit = account?.checksLimit ?? 10;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-medium">
          Your LinkedIn account <span className="font-normal text-quiet">(optional)</span>
        </h4>
        {loading ? (
          <Skeleton className="h-5 w-24 rounded-full" />
        ) : account ? (
          <Chip tone={state === "connected" ? "success" : state === "needs_reconnect" ? "urgent" : "quiet"} className="shrink-0">
            <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", state === "connected" ? "bg-success" : state === "needs_reconnect" ? "bg-danger" : "bg-hairline")} />
            {label}
          </Chip>
        ) : null}
      </div>
      <p className="text-[13.5px] text-quiet">
        Lists the people you share with a lead. It reads LinkedIn as you, for at most {limit > 0 ? count(limit) : 10} leads a day. LinkedIn may restrict accounts that use automation.
      </p>
      {account && (
        <p className="mt-1 text-[13px] text-quiet">
          {state === "not_set_up"
            ? "Off. It turns on when your account is linked in Unipile and UNIPILE_NETWORK_ACCOUNT_ID is set on the server."
            : state === "needs_reconnect"
              ? "LinkedIn signed this account out. Reconnect it in Unipile. Until then, only your uploaded connections are used."
              : state === "unknown"
                ? "Unipile did not answer, so the state of your account is not known. Your uploaded connections are still used."
              : state === "paused"
                ? `${
                    account.pauseKind === "auth"
                      ? "Unipile refused the key or this account (401). Check UNIPILE_API_KEY and the account in Unipile."
                      : account.pauseKind === "error"
                        ? "LinkedIn or Unipile had an error, so checks wait an hour."
                        : "LinkedIn slowed this account down, so checks wait."
                  } Your uploaded connections are still used.`
                : limit === 0
                  ? "Checks are paused (WARM_PATH_LINKEDIN_CHECKS_PER_DAY is 0)."
                  : `${count(account.checksToday)} of ${count(limit)} checks used today.`}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ X

function OwnX({
  value,
  savedValue,
  onChange,
  error,
  x,
  loading,
  now,
  onSynced,
}: {
  value: string;
  savedValue: string;
  onChange: (value: string) => void;
  error: string | null;
  x: NetworkStatus["x"] | null;
  loading: boolean;
  now: number;
  onSynced: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const unsaved = value.trim().toLowerCase() !== savedValue.trim().toLowerCase();
  const running = busy || Boolean(x?.running);
  // The button is disabled while it refreshes, which drops focus: give it back once it settles.
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (running || !refocus.current) return;
    refocus.current = false;
    if (!document.activeElement || document.activeElement === document.body) button.current?.focus();
  }, [running]);

  async function sync() {
    if (busy) return;
    refocus.current = true;
    setBusy(true);
    setFailure(null);
    setNote(null);
    setDone(false);
    try {
      const res = await syncX();
      if (res.refreshed) {
        setDone(true);
        track("network_x_synced", { following: res.following, followers: res.followers });
      } else {
        setNote(res.note ?? "Your lists were not refreshed. The stored ones are kept.");
      }
    } catch (err) {
      setFailure(errorMessage(err));
    }
    await onSynced();
    setBusy(false);
  }

  const off = x !== null && !x.configured;
  const paused = x !== null && x.configured && x.usdLimit === 0;
  const reason = off
    ? "X follows are off on this server."
    : unsaved
      ? "Save settings first."
      : !savedValue.trim()
        ? "Add your X handle and save first."
        : paused
          ? "X checks are paused on this server."
          : null;
  const synced = x !== null && x.following !== null && x.followers !== null;

  return (
    <div>
      <div className="max-w-sm">
        <Label htmlFor="xHandle">Your X handle</Label>
        <HandleInput id="xHandle" value={value} maxLength={15} onChange={onChange} error={error} describedBy="xHandle-status" />
      </div>
      <FieldError id="xHandle-error" message={error} />

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div id="xHandle-status" className="min-w-0 text-[13.5px]" aria-live="polite">
          {loading ? (
            <Skeleton className="h-3.5 w-64" />
          ) : running ? (
            "Refreshing your lists. This can take a minute."
          ) : unsaved ? (
            <span className="text-quiet">Save settings to use this handle.</span>
          ) : synced ? (
            <span className={done ? "text-success" : undefined}>
              Following {count(x.following ?? 0)} · Followers {count(x.followers ?? 0)}
              {x.syncedAt ? ` · refreshed ${timeAgo(x.syncedAt, now)}` : ""}
            </span>
          ) : savedValue.trim() && off ? (
            <span className="text-quiet">Not read while X follows are off.</span>
          ) : savedValue.trim() ? (
            <span className="text-quiet">Not read yet. Research reads who you follow when it checks a lead, at most once a day.</span>
          ) : (
            <span className="text-quiet">Add your handle to compare who you follow with who a lead follows.</span>
          )}
        </div>
        <Button ref={button} size="sm" onClick={() => void sync()} busy={running} disabledReason={running ? null : reason}>
          {running ? "Refreshing…" : "Refresh now"}
        </Button>
      </div>

      {x && (
        <p className="mt-2 text-[13px] text-quiet">
          {off
            ? "X follows are off on this server. They turn on when TWITTERAPI_IO_KEY is set. Your handle is still saved."
            : paused
              ? "X checks are paused (WARM_PATH_X_USD_PER_DAY is 0)."
              : `From twitterapi.io: about $0.03 a refresh. Today ${money(x.usdToday)} of ${money(x.usdLimit)}.`}
        </p>
      )}
      {note && (
        <div className="mt-2.5">
          <Notice tone="info">{note}</Notice>
        </div>
      )}
      {failure ? (
        <div className="mt-2.5">
          <Notice>{failure}</Notice>
        </div>
      ) : (
        !running && !unsaved && !done && !note && x?.error && <p className="mt-1.5 text-[13px] text-danger">The last refresh failed. Use Refresh now to try again.</p>
      )}
    </div>
  );
}
