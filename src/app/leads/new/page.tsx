"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { track } from "@/lib/analytics";
import { ApiError, createLead, errorMessage } from "@/lib/api-client";
import { normalizeLinkedinUrl } from "@/components/format";
import { Button, ButtonLink, Label, Notice, PageTitle } from "@/components/ui";

export default function NewLeadPage() {
  const router = useRouter();
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [notes, setNotes] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [existingId, setExistingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function validateUrl(value: string): string | null {
    if (!value.trim()) return "Paste the person's LinkedIn profile URL.";
    if (!normalizeLinkedinUrl(value)) return "That does not look like a LinkedIn profile. It should look like linkedin.com/in/their-name.";
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = validateUrl(linkedinUrl);
    setUrlError(problem);
    setError(null);
    setExistingId(null);
    if (problem) {
      document.getElementById("linkedinUrl")?.focus();
      return;
    }
    setBusy(true);
    try {
      const lead = await createLead({
        linkedinUrl: normalizeLinkedinUrl(linkedinUrl) ?? linkedinUrl.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(companyName.trim() ? { companyName: companyName.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      track("lead_created", { leadId: lead.id, withName: Boolean(name.trim()), withCompany: Boolean(companyName.trim()), withNotes: Boolean(notes.trim()) });
      router.push(`/leads/${lead.id}`);
      // Stay "busy" while the next page loads so the form cannot be sent twice.
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.existingId) setExistingId(err.existingId);
      else setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <Link href="/" className="mb-4 inline-block text-[13.5px] text-quiet hover:text-ink">
        ← Leads
      </Link>
      <PageTitle title="New lead" subtitle="One person at a time. Research starts as soon as you add them and takes one to three minutes." />

      <form onSubmit={onSubmit} noValidate className="card space-y-5 p-5 sm:p-6">
        <div>
          <Label htmlFor="linkedinUrl">LinkedIn URL</Label>
          <input
            id="linkedinUrl"
            name="linkedinUrl"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoFocus
            required
            className="field"
            placeholder="https://www.linkedin.com/in/their-name"
            value={linkedinUrl}
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? "linkedinUrl-error" : undefined}
            onChange={(e) => {
              setLinkedinUrl(e.target.value);
              if (urlError) setUrlError(validateUrl(e.target.value));
              setExistingId(null);
            }}
            onBlur={() => linkedinUrl.trim() && setUrlError(validateUrl(linkedinUrl))}
          />
          {urlError && (
            <p id="linkedinUrl-error" className="mt-1.5 text-[13px] text-danger">
              {urlError}
            </p>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="name" hint="Optional">
              Name
            </Label>
            <input id="name" name="name" className="field" autoComplete="off" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="companyName" hint="Optional">
              Company
            </Label>
            <input id="companyName" name="companyName" className="field" autoComplete="off" maxLength={200} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="notes" hint="Optional">
            Notes
          </Label>
          <textarea id="notes" name="notes" rows={5} className="field" maxLength={5000} placeholder="How you know them, what was said, what you want" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <p className="mt-1.5 text-[13px] text-quiet">The agent reads these and uses them in the brief and the drafts.</p>
        </div>

        {existingId && (
          <Notice tone="info" action={<ButtonLink href={`/leads/${existingId}`} size="sm">Open existing lead</ButtonLink>}>
            This person is already a lead.
          </Notice>
        )}
        {error && <Notice>{error}</Notice>}

        <div className="flex items-center justify-end gap-2 border-t border-hairline pt-5">
          <ButtonLink href="/" variant="ghost">
            Cancel
          </ButtonLink>
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? "Adding…" : "Add and research"}
          </Button>
        </div>
      </form>
    </div>
  );
}
