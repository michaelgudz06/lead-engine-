import "server-only";
import type { ApolloOrg, ApolloPerson } from "../providers/apollo";
import type { LinkedInCompany, LinkedInProfile } from "../providers/linkedin";
import { addEvent } from "../repo/events";
import { saveRaw } from "../repo/findings";
import { updateLead } from "../repo/leads";
import type { EventType, Lead, ProviderStatus, Settings } from "../types";
import type { DomainSource } from "./domain";
import { Deadline, errorMessage, withTimeout } from "./util";

/** What the pipeline knows about who it is researching. Built by identify, read by every later step. */
export interface Person {
  name: string | null;
  /** True when the name was only guessed from the LinkedIn URL slug. */
  nameIsGuess: boolean;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  domain: string | null;
  /** Where the domain came from (see domain.ts). Absent on a rebuilt context. */
  domainSource?: DomainSource | null;
  location: string | null;
  linkedinUrl: string;
  companyLinkedinUrl: string | null;
}

export interface RunContext {
  leadId: string;
  lead: Lead;
  settings: Settings;
  deadline: Deadline;
  person: Person;
  profile: LinkedInProfile | null;
  company: LinkedInCompany | null;
  apolloPerson: ApolloPerson | null;
  /** Apollo's company record matched by the company's LinkedIn URL during identify, when there is one. */
  apolloOrg?: ApolloOrg | null;
}

/** The lead was deleted while its research was running. Nothing is left to record against. */
export class LeadGoneError extends Error {
  constructor() {
    super("The lead was deleted while research was running");
    this.name = "LeadGoneError";
  }
}

/**
 * Progress goes to le_leads.research_step (the live label in the UI) and to
 * le_events (the timeline). Both are best-effort: a failed progress write must
 * never fail the research itself. The one exception: when the lead row is gone
 * (deleted mid-run), step() throws LeadGoneError so the run stops spending.
 */
export async function step(leadId: string, message: string): Promise<void> {
  const [res] = await Promise.allSettled([updateLead(leadId, { researchStep: message }), addEvent(leadId, "step", message)]);
  if (res.status === "fulfilled" && res.value === null) throw new LeadGoneError();
}

export async function note(leadId: string, type: EventType, message: string, data?: unknown): Promise<void> {
  try {
    await addEvent(leadId, type, message, data);
  } catch {
    // best-effort
  }
}

/** Stores a provider response for debugging. `request` must never hold keys or headers. */
export async function raw(leadId: string, provider: string, request: unknown, response: unknown): Promise<void> {
  try {
    await saveRaw(leadId, provider, request, response);
  } catch {
    // best-effort
  }
}

/** Whether a provider is usable. A status function that throws (or is not built yet) counts as "not configured". */
export function isConfigured(status: () => ProviderStatus): boolean {
  try {
    return status().configured === true;
  } catch {
    return false;
  }
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs one provider call with a timeout and turns any throw into a value, so one source cannot fail the run. */
export async function attempt<T>(label: string, timeoutMs: number, fn: () => Promise<T>): Promise<Attempt<T>> {
  if (timeoutMs <= 0) return { ok: false, error: `${label} skipped: no time left in this run` };
  try {
    return { ok: true, value: await withTimeout(fn, timeoutMs, label) };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
