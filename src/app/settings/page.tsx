"use client";

import { useEffect, useState } from "react";
import { errorMessage, getSettings, getStatus, saveSettings, type StatusResponse } from "@/lib/api-client";
import type { Settings } from "@/lib/types";
import { modelLabel } from "@/components/format";
import { Button, Chip, ErrorState, Label, Notice, PageTitle, Skeleton } from "@/components/ui";
import { useLoad } from "@/components/use-load";

export default function SettingsPage() {
  const settings = useLoad(getSettings);
  const status = useLoad(getStatus);

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle title="Settings" subtitle="Who the drafts are from, what the agent may use, and which sources are connected." />
      <div className="space-y-8">
        {settings.loading ? (
          <FormSkeleton />
        ) : !settings.data ? (
          <ErrorState title="Settings did not load" message={settings.error ?? "Please try again."} onRetry={settings.reload} />
        ) : (
          <SettingsForm initial={settings.data} onSaved={settings.setData} />
        )}
        <Integrations state={status} />
      </div>
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="border-b border-hairline px-5 py-4">
        <h2 className="font-serif text-[20px] leading-snug">{title}</h2>
        {description && <p className="mt-0.5 text-[13.5px] text-quiet">{description}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function SettingsForm({ initial, onSaved }: { initial: Settings; onSaved: (s: Settings) => void }) {
  const [form, setForm] = useState<Settings>(initial);
  const [saved, setSaved] = useState<Settings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);

  // Leaving with unsaved edits is easy to do by accident on a long form.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setJustSaved(false);
  }

  const emailOk = !form.senderEmail.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.senderEmail.trim());
  const calendlyOk = !form.calendlyUrl.trim() || /^https?:\/\/\S+\.\S+/i.test(form.calendlyUrl.trim());
  const daysOk = Number.isInteger(form.followUpDays) && form.followUpDays >= 1 && form.followUpDays <= 60;
  const valid = emailOk && calendlyOk && daysOk;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const next = await saveSettings({
        senderName: form.senderName.trim(),
        senderEmail: form.senderEmail.trim(),
        calendlyUrl: form.calendlyUrl.trim(),
        signature: form.signature,
        followUpDays: form.followUpDays,
        // Empty rows are just unfinished edits, not rules.
        criteria: form.criteria.map((c) => c.trim()).filter(Boolean),
      });
      setForm(next);
      setSaved(next);
      onSaved(next);
      setJustSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-8">
      <Section title="Sender" description="Used to sign the drafts and to fill in your booking link.">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="senderName">Your name</Label>
            <input id="senderName" className="field" autoComplete="name" maxLength={120} value={form.senderName} onChange={(e) => set("senderName", e.target.value)} />
          </div>
          <div>
            <Label htmlFor="senderEmail">Your email</Label>
            <input id="senderEmail" type="email" className="field" autoComplete="email" maxLength={200} value={form.senderEmail} aria-invalid={!emailOk || undefined} onChange={(e) => set("senderEmail", e.target.value)} />
            {!emailOk && <p className="mt-1.5 text-[13px] text-danger">This does not look like an email address.</p>}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="calendlyUrl">Calendly link</Label>
            <input id="calendlyUrl" type="url" inputMode="url" className="field" placeholder="https://calendly.com/you/intro" maxLength={300} value={form.calendlyUrl} aria-invalid={!calendlyOk || undefined} onChange={(e) => set("calendlyUrl", e.target.value)} />
            {!calendlyOk ? (
              <p className="mt-1.5 text-[13px] text-danger">Use a full link that starts with https://.</p>
            ) : (
              <p className="mt-1.5 text-[13px] text-quiet">Without one, drafts keep a [your booking link] placeholder.</p>
            )}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="signature">Email signature</Label>
            <textarea id="signature" rows={3} className="field" maxLength={1000} value={form.signature} onChange={(e) => set("signature", e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="followUpDays">Follow up after</Label>
            <div className="flex items-center gap-2">
              <input
                id="followUpDays"
                type="number"
                min={1}
                max={60}
                step={1}
                className="field w-24"
                value={Number.isFinite(form.followUpDays) ? form.followUpDays : ""}
                aria-invalid={!daysOk || undefined}
                onChange={(e) => set("followUpDays", e.target.value === "" ? NaN : Number(e.target.value))}
              />
              <span className="text-quiet">days after a message is marked as sent</span>
            </div>
            {!daysOk && <p className="mt-1.5 text-[13px] text-danger">Use a whole number from 1 to 60.</p>}
          </div>
        </div>
      </Section>

      <Section title="Criteria" description="Plain-English rules. A finding that breaks one stays out of the brief and the drafts.">
        <ul className="space-y-2">
          {form.criteria.map((rule, i) => (
            <li key={i} className="flex items-start gap-2">
              <textarea
                rows={2}
                className="field"
                aria-label={`Rule ${i + 1}`}
                maxLength={500}
                value={rule}
                onChange={(e) => set("criteria", form.criteria.map((r, j) => (j === i ? e.target.value : r)))}
              />
              <Button variant="ghost" className="shrink-0 text-quiet" aria-label={`Remove rule ${i + 1}`} onClick={() => set("criteria", form.criteria.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        {form.criteria.length === 0 && <p className="mb-3 text-quiet">No rules. Every finding the agent keeps can appear in the brief.</p>}
        <div className="mt-3">
          <Button size="sm" onClick={() => set("criteria", [...form.criteria, ""])} disabledReason={form.criteria.length >= 20 ? "Twenty rules is the limit. Remove one first." : null}>
            + Add rule
          </Button>
        </div>
      </Section>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <div className="mr-auto min-w-0 text-[13.5px]" aria-live="polite">
          {error ? <span className="text-danger">{error}</span> : justSaved && !dirty ? <span className="text-success">Saved.</span> : dirty ? <span className="text-quiet">Unsaved changes</span> : null}
        </div>
        <Button onClick={() => { setForm(saved); setError(null); }} disabled={!dirty || busy}>
          Discard
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabledReason={!valid ? "Fix the highlighted fields first." : !dirty ? "Nothing to save yet." : null} tipEnd>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </form>
  );
}

function Integrations({ state }: { state: ReturnType<typeof useLoad<StatusResponse>> }) {
  const { data, error, loading, reload } = state;
  return (
    <Section title="Integrations" description="Sources the agent can use. Keys are set as environment variables on the server, never here.">
      {loading ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading integrations">
          {[70, 55, 62, 48].map((w, i) => (
            <div key={i} className="flex items-center gap-4">
              <div className="flex-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="mt-2 h-3.5" style={{ width: `${w}%` }} />
              </div>
              <Skeleton className="h-5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      ) : !data ? (
        <Notice action={<Button size="sm" onClick={reload}>Try again</Button>}>Could not check the integrations: {error ?? "unknown error"}</Notice>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-wash px-3.5 py-2.5">
            <span className="text-[13px] text-quiet">Model</span>
            <span className="font-medium">
              {modelLabel(data.model.name)}
              {data.model.effort ? `, ${data.model.effort} effort` : ""}
            </span>
          </div>
          {data.providers.length === 0 ? (
            <p className="text-quiet">The server did not report any integrations.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {data.providers.map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="font-medium">{p.label || p.id}</div>
                    {p.detail && <div className="text-[13.5px] text-quiet">{p.detail}</div>}
                  </div>
                  <Chip tone={p.configured ? "success" : "quiet"} className="mt-0.5 shrink-0">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${p.configured ? "bg-success" : "bg-hairline"}`} />
                    {p.configured ? "Connected" : "Not set up"}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 border-t border-hairline pt-3 text-[13px] text-quiet">
            Access: {data.authEnabled ? "protected by the team password." : "open, because no team password is set. Set APP_PASSWORD before sharing the link."}
          </p>
        </>
      )}
    </Section>
  );
}

function FormSkeleton() {
  return (
    <div className="card p-5" aria-busy="true" aria-label="Loading settings">
      <Skeleton className="h-5 w-24" />
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-9" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-5 h-20" />
    </div>
  );
}
