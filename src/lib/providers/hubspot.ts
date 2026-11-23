import "server-only";
import { hasEnv, optionalEnv } from "../env";
import type { Angle, Lead, ProviderStatus } from "../types";
import { metered, withUsageContext } from "../usage/ledger";
import { FREE } from "../usage/prices";

/**
 * HubSpot (V1). Needs HUBSPOT_ACCESS_TOKEN from a HubSpot private app with
 * CRM write scopes for contacts, companies and deals. Not tested against a live
 * account yet. CONTRACT: signatures fixed; owned by the api agent.
 *
 * One push writes the lead into the CRM:
 *   1. company  - found by domain (else by name), created when missing
 *   2. contact  - found by email (else by name + company), created when missing
 *   3. deal     - an open deal already linked to the contact is reused, else one
 *                 is created in the default pipeline's first open stage
 *   4. note     - the outreach that was sent (or the brief), linked to all three
 * Records a person already has in HubSpot are never overwritten: only empty fields
 * are filled in. The owner of new records is the HubSpot user whose email matches
 * the sender email in Settings, when there is one.
 *
 * API version: HubSpot's date-versioned CRM API (`2026-09`). Its contracts match the
 * classic /crm/v3 objects and /crm/v4 associations APIs, which HubSpot now marks as
 * legacy (v4 unsupported from March 2027, v3 from September 2027). Bump VERSION when
 * HubSpot retires 2026-09 (about 18 months after its release).
 *
 * Private app scopes: crm.objects.contacts.read/.write, crm.objects.companies.read/.write,
 * crm.objects.deals.read/.write. Optional: crm.objects.owners.read (record owner).
 */

const API_BASE = "https://api.hubapi.com";
const VERSION = "2026-09";
/** Per request. A push makes about 8 to 14 requests. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Whole push: stays well inside the route's 60 s limit. */
const PUSH_BUDGET_MS = 45_000;
/** hs_note_body allows 65,536 characters; leave room for markup. */
const NOTE_MAX_CHARS = 60_000;

type ObjectType = "contacts" | "companies" | "deals" | "notes";

/** Singular names, as in HubSpot's association path examples (/contact/{id}/associations/default/company/{id}). */
const SINGULAR: Record<ObjectType, string> = { contacts: "contact", companies: "company", deals: "deal", notes: "note" };

/** HubSpot-defined association type ids (HUBSPOT_DEFINED category). */
const ASSOCIATION = {
  contactToPrimaryCompany: 1,
  dealToContact: 3,
  dealToPrimaryCompany: 5,
  noteToCompany: 190,
  noteToContact: 202,
  noteToDeal: 214,
} as const;

// ------------------------------------------------------------------ public API

export interface HubSpotPushInput {
  lead: Lead;
  /** The angle that was sent (from the lead's last "sent" event), if any. */
  sentAngle?: Angle | null;
  /** Settings.senderEmail: used to find the HubSpot owner for new records. */
  senderEmail?: string | null;
  /** How sentAngle went out; decides which text the note quotes. Unknown: both. */
  channel?: "email" | "linkedin" | null;
  /** When it was sent (ISO). Places the note at that point of the HubSpot timeline. */
  sentAt?: string | null;
}

export interface HubSpotPushResult {
  ok: boolean;
  contactId?: string;
  companyId?: string;
  dealId?: string;
  noteId?: string;
  /** Records created by this push; the others already existed and were reused. */
  created: Array<"company" | "contact" | "deal" | "note">;
  /** Problems that did not stop the push, e.g. a property this HubSpot account lacks. */
  warnings: string[];
  error?: string;
}

/** The contract entry point. pushLeadToHubSpot returns the same plus created records and warnings. */
export async function pushToHubSpot(input: {
  lead: Lead;
  sentAngle?: Angle | null;
  senderEmail?: string | null;
}): Promise<{ ok: boolean; contactId?: string; companyId?: string; dealId?: string; error?: string }> {
  const r = await pushLeadToHubSpot(input);
  return {
    ok: r.ok,
    ...(r.contactId ? { contactId: r.contactId } : {}),
    ...(r.companyId ? { companyId: r.companyId } : {}),
    ...(r.dealId ? { dealId: r.dealId } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export function hubspotStatus(): ProviderStatus {
  const configured = hasEnv("HUBSPOT_ACCESS_TOKEN");
  return {
    id: "hubspot",
    label: "HubSpot",
    configured,
    detail: configured
      ? "Push a lead to HubSpot: company, contact, a deal in the default pipeline and a note with the sent message."
      : "Off: set HUBSPOT_ACCESS_TOKEN (a HubSpot private app token with read and write scopes for contacts, companies and deals).",
  };
}

/**
 * Pushes one lead. Never throws: failures come back as { ok: false, error } along
 * with the ids of anything already written, so a retry can pick up where it stopped
 * (every step looks for existing records first).
 */
export function pushLeadToHubSpot(input: HubSpotPushInput): Promise<HubSpotPushResult> {
  // Usage ledger: the push's requests are tagged to the lead and written before this returns.
  return withUsageContext(input?.lead?.id ?? null, () => pushLead(input));
}

async function pushLead(input: HubSpotPushInput): Promise<HubSpotPushResult> {
  const result: HubSpotPushResult = { ok: false, created: [], warnings: [] };
  const token = optionalEnv("HUBSPOT_ACCESS_TOKEN");
  if (!token) return { ...result, error: "HubSpot is not configured: set HUBSPOT_ACCESS_TOKEN." };

  const { lead } = input;
  const person = splitName(lead.name);
  const email = cleanEmail(lead.email);
  if (!email && !person.first && !person.last) {
    return { ...result, error: "This lead has no name or email yet, so HubSpot cannot create a contact. Run research or add them first." };
  }

  const hs = new HubSpotClient(token, result.warnings);
  try {
    // Both lookups are optional extras: a failure only costs the owner or the stage choice.
    const [ownerId, pipelines] = await Promise.all([
      input.senderEmail ? findOwnerId(hs, input.senderEmail) : Promise.resolve(null),
      hs.dealPipelines().catch((err: unknown) => {
        hs.warn(`Could not read the deal pipelines (${message(err)}); used the default pipeline.`);
        return null;
      }),
    ]);

    // The company is optional: the contact, deal and note still help without it.
    let companyId: string | null = null;
    try {
      companyId = await upsertCompany(hs, lead, ownerId, result);
    } catch (err) {
      hs.warn(`Company skipped: ${message(err)}`);
    }
    if (companyId) result.companyId = companyId;

    result.contactId = await step("Saving the contact", () => upsertContact(hs, lead, person, email, companyId, ownerId, result));
    result.dealId = await step("Saving the deal", () => upsertDeal(hs, lead, result.contactId!, companyId, ownerId, pipelines, result));
    result.noteId = await step("Adding the note", () =>
      createNote(hs, input, { contactId: result.contactId!, companyId, dealId: result.dealId! }, ownerId, result),
    );
    result.ok = true;
  } catch (err) {
    result.error = message(err);
  }
  return result;
}

// ------------------------------------------------------------------ steps

interface CrmObject {
  id: string;
  properties: Record<string, string | null | undefined>;
}

type Filter = { propertyName: string; operator: "EQ" | "NEQ" | "HAS_PROPERTY" | "NOT_HAS_PROPERTY"; value?: string };

interface AssociationSpec {
  toType: ObjectType;
  toId: string;
  typeId: number;
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${label}: ${message(err)}`);
  }
}

async function findOwnerId(hs: HubSpotClient, senderEmail: string): Promise<string | null> {
  const email = cleanEmail(senderEmail);
  if (!email) return null;
  try {
    const owner = await hs.ownerByEmail(email);
    if (!owner) hs.warn(`No HubSpot user has the sender email ${email}, so new records have no owner.`);
    return owner;
  } catch (err) {
    hs.warn(`Could not look up the HubSpot owner (${message(err)}); new records have no owner.`);
    return null;
  }
}

async function upsertCompany(hs: HubSpotClient, lead: Lead, ownerId: string | null, result: HubSpotPushResult): Promise<string | null> {
  // Each candidate on its own: a malformed companyDomain must not hide a good one in the company picture.
  const domain = normaliseDomain(lead.companyDomain) ?? normaliseDomain(lead.companyPicture?.domain);
  const name = clean(lead.companyName, 200) ?? clean(lead.companyPicture?.name, 200);
  if (!domain && !name) return null;

  const wanted = compact({
    name,
    domain,
    linkedin_company_page: cleanUrl(lead.companyLinkedinUrl),
    description: clean(lead.companyPicture?.oneLiner, 1000),
  });
  const read = Object.keys(wanted);

  let existing: CrmObject | null = null;
  if (domain) {
    // Two OR'd groups: HubSpot may hold the domain with or without "www.".
    existing = await hs.searchOne("companies", [[eq("domain", domain)], [eq("domain", `www.${domain}`)]], read);
    // A record with the same name and no domain yet is the same company; filling its domain links them.
    if (!existing && name) existing = await hs.searchOne("companies", [[eq("name", name), { propertyName: "domain", operator: "NOT_HAS_PROPERTY" }]], read);
  } else if (name) {
    existing = await hs.searchOne("companies", [[eq("name", name)]], read);
  }

  if (existing) {
    await hs.fillBlanks("companies", existing, wanted);
    return existing.id;
  }
  const created = await hs.create("companies", { ...wanted, ...(ownerId ? { hubspot_owner_id: ownerId } : {}) }, []);
  result.created.push("company");
  return created.id;
}

async function upsertContact(
  hs: HubSpotClient,
  lead: Lead,
  person: { first: string | null; last: string | null },
  email: string | null,
  companyId: string | null,
  ownerId: string | null,
  result: HubSpotPushResult,
): Promise<string> {
  const wanted = compact({
    email,
    firstname: person.first,
    lastname: person.last,
    jobtitle: clean(lead.title, 200),
    company: clean(lead.companyName, 200),
    // Not every HubSpot account has this property; create/update drop it when refused.
    hs_linkedin_url: cleanUrl(lead.linkedinUrl),
  });
  const read = Object.keys(wanted);

  let existing: CrmObject | null = null;
  if (email) {
    existing = await hs.getContactByEmail(email, read);
  } else {
    existing = await findContactByNameAndCompany(hs, person, companyId, clean(lead.companyName, 200), read);
  }

  if (existing) {
    await hs.fillBlanks("contacts", existing, wanted);
    if (companyId) await hs.associateOrWarn("contacts", existing.id, "companies", companyId);
    return existing.id;
  }

  try {
    const created = await hs.create(
      "contacts",
      { ...wanted, ...(ownerId ? { hubspot_owner_id: ownerId } : {}) },
      companyId ? [{ toType: "companies", toId: companyId, typeId: ASSOCIATION.contactToPrimaryCompany }] : [],
    );
    result.created.push("contact");
    return created.id;
  } catch (err) {
    // 409: another contact already holds this email (a race, or it is their secondary address). Use it.
    const existingId = err instanceof HubSpotError && err.status === 409 ? err.existingId : null;
    if (!existingId) throw err;
    if (companyId) await hs.associateOrWarn("contacts", existingId, "companies", companyId);
    return existingId;
  }
}

/**
 * Without an email, a contact is the same person only when the name matches AND
 * the company does (linked to the company record, or the same company text).
 * With no company to check against, no match is attempted: a new contact is safer
 * than attaching this lead to a namesake.
 */
async function findContactByNameAndCompany(
  hs: HubSpotClient,
  person: { first: string | null; last: string | null },
  companyId: string | null,
  companyName: string | null,
  read: string[],
): Promise<CrmObject | null> {
  const nameFilters: Filter[] = [];
  if (person.first) nameFilters.push(eq("firstname", person.first));
  if (person.last) nameFilters.push(eq("lastname", person.last));
  if (!nameFilters.length) return null;
  const byText = companyName ? [...nameFilters, eq("company", companyName)] : null;
  const byLink = companyId ? [...nameFilters, eq("associations.company", companyId)] : null;
  const groups = [byLink, byText].filter((g): g is Filter[] => g !== null);
  if (!groups.length) return null;
  try {
    return await hs.searchOne("contacts", groups, read);
  } catch (err) {
    if (!(err instanceof HubSpotError) || err.status !== 400 || !byLink) throw err;
    // Association filters are newer; if this account refuses them, match on the company text alone.
    if (byText) return hs.searchOne("contacts", [byText], read);
    hs.warn(`Could not search contacts by company (${message(err)}); created a new contact.`);
    return null;
  }
}

async function upsertDeal(
  hs: HubSpotClient,
  lead: Lead,
  contactId: string,
  companyId: string | null,
  ownerId: string | null,
  pipelines: Pipeline[] | null,
  result: HubSpotPushResult,
): Promise<string> {
  const dealname = dealName(lead);
  const target = chooseStage(pipelines);
  const closedStages = new Set((pipelines ?? []).flatMap((p) => p.stages.filter((s) => s.closed).map((s) => s.id)));

  // Pushing the same lead twice must not stack up deals: reuse an open deal already linked to the contact.
  let linked: CrmObject[] = [];
  try {
    linked = await hs.search("deals", [[eq("associations.contact", contactId)]], ["dealname", "pipeline", "dealstage", "hs_is_closed"], 20);
  } catch (err) {
    hs.warn(`Could not check for an existing deal (${message(err)}); created a new one.`);
  }
  const open = linked.filter(
    (d) => d.properties.hs_is_closed !== "true" && !(d.properties.dealstage && closedStages.has(d.properties.dealstage)),
  );
  const reuse =
    open.find((d) => sameText(d.properties.dealname, dealname)) ?? open.find((d) => d.properties.pipeline === target.pipeline) ?? null;
  if (reuse) {
    if (companyId) await hs.associateOrWarn("deals", reuse.id, "companies", companyId);
    return reuse.id;
  }

  const created = await hs.create(
    "deals",
    compact({
      dealname,
      pipeline: target.pipeline,
      dealstage: target.stage,
      hubspot_owner_id: ownerId,
      description: dealDescription(lead),
    }),
    [
      { toType: "contacts", toId: contactId, typeId: ASSOCIATION.dealToContact },
      ...(companyId ? [{ toType: "companies" as const, toId: companyId, typeId: ASSOCIATION.dealToPrimaryCompany }] : []),
    ],
    // Without these three HubSpot cannot place the deal; never drop them to get a create through.
    new Set(["dealname", "pipeline", "dealstage"]),
  );
  result.created.push("deal");
  return created.id;
}

async function createNote(
  hs: HubSpotClient,
  input: HubSpotPushInput,
  ids: { contactId: string; companyId: string | null; dealId: string },
  ownerId: string | null,
  result: HubSpotPushResult,
): Promise<string> {
  const sentMs = input.sentAt ? Date.parse(input.sentAt) : NaN;
  const created = await hs.create(
    "notes",
    compact({
      hs_timestamp: new Date(Number.isFinite(sentMs) ? sentMs : Date.now()).toISOString(),
      hs_note_body: noteBody(input),
      hubspot_owner_id: ownerId,
    }),
    [
      { toType: "contacts", toId: ids.contactId, typeId: ASSOCIATION.noteToContact },
      { toType: "deals", toId: ids.dealId, typeId: ASSOCIATION.noteToDeal },
      ...(ids.companyId ? [{ toType: "companies" as const, toId: ids.companyId, typeId: ASSOCIATION.noteToCompany }] : []),
    ],
    new Set(["hs_timestamp", "hs_note_body"]),
  );
  result.created.push("note");
  return created.id;
}

// ------------------------------------------------------------------ pipelines

interface Pipeline {
  id: string;
  displayOrder: number;
  stages: Array<{ id: string; displayOrder: number; closed: boolean }>;
}

/** The pipeline "default" (else the first one) and its first open stage. */
function chooseStage(pipelines: Pipeline[] | null): { pipeline: string; stage: string } {
  const sorted = [...(pipelines ?? [])].sort((a, b) => a.displayOrder - b.displayOrder);
  const pipeline = sorted.find((p) => p.id === "default") ?? sorted[0];
  const stages = [...(pipeline?.stages ?? [])].sort((a, b) => a.displayOrder - b.displayOrder);
  const stage = stages.find((s) => !s.closed) ?? stages[0];
  // Fallback when the pipelines could not be read: HubSpot's stock sales pipeline and its first stage.
  if (!pipeline || !stage) return { pipeline: "default", stage: "appointmentscheduled" };
  return { pipeline: pipeline.id, stage: stage.id };
}

function parsePipelines(raw: unknown): Pipeline[] {
  const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
  const out: Pipeline[] = [];
  for (const p of results) {
    if (!isRecord(p) || p.archived === true) continue;
    const id = idString(p.id);
    if (!id) continue;
    const stages: Pipeline["stages"] = [];
    for (const s of Array.isArray(p.stages) ? p.stages : []) {
      if (!isRecord(s) || s.archived === true) continue;
      const stageId = idString(s.id);
      if (!stageId) continue;
      const meta = isRecord(s.metadata) ? s.metadata : {};
      stages.push({ id: stageId, displayOrder: Number(s.displayOrder) || 0, closed: String(meta.isClosed) === "true" });
    }
    out.push({ id, displayOrder: Number(p.displayOrder) || 0, stages });
  }
  return out;
}

// ------------------------------------------------------------------ note and names

function dealName(lead: Lead): string {
  const company = clean(lead.companyName, 120);
  const person = clean(lead.name, 120);
  if (company && person) return `${company} (${person})`;
  return company ?? person ?? lead.linkedinSlug ?? "Lead Engine lead";
}

function dealDescription(lead: Lead): string | null {
  const summary = clean(lead.brief?.summary, 1500);
  return summary ? `${summary}\n\nFrom Lead Engine. LinkedIn: ${lead.linkedinUrl}` : `From Lead Engine. LinkedIn: ${lead.linkedinUrl}`;
}

/** hs_note_body is rich text: escaped HTML, paragraphs and line breaks. */
function noteBody(input: HubSpotPushInput): string {
  const { lead, sentAngle, channel } = input;
  const out: string[] = [];
  if (sentAngle) {
    // Stored JSON: read it defensively even though the type says every field is there.
    const subject = text(sentAngle.email?.subject);
    const body = text(sentAngle.email?.body);
    const linkedin = text(sentAngle.linkedinMessage);
    const how = channel === "email" ? " by email" : channel === "linkedin" ? " on LinkedIn" : "";
    out.push(`<p><strong>Lead Engine: outreach sent${how}</strong> (angle: ${esc(text(sentAngle.name) || "untitled")})</p>`);
    if (channel !== "linkedin" && (subject || body)) {
      out.push(`<p><strong>Subject:</strong> ${esc(subject)}</p>`);
      out.push(paragraphs(truncate(body, 20_000)));
    }
    if (channel !== "email" && linkedin.trim()) {
      out.push(`<p><strong>LinkedIn message:</strong></p>`);
      out.push(paragraphs(truncate(linkedin, 5000)));
    }
  } else {
    out.push(`<p><strong>Lead Engine: added to HubSpot</strong> (nothing marked as sent yet)</p>`);
  }
  const summary = clean(lead.brief?.summary, 3000);
  if (summary) out.push(`<p><strong>Why this lead:</strong> ${esc(summary)}</p>`);
  const link = cleanUrl(lead.linkedinUrl);
  if (link) out.push(`<p>LinkedIn: <a href="${esc(link)}">${esc(link)}</a></p>`);
  return truncate(out.join(""), NOTE_MAX_CHARS);
}

function paragraphs(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** "Dr. Jane van der Berg, PhD 🚀" -> { first: "Jane", last: "van der Berg" }. */
export function splitName(name: string | null | undefined): { first: string | null; last: string | null } {
  const cleaned = (name ?? "")
    .split(",")[0]
    .replace(/\([^)]*\)/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:dr|prof|mr|mrs|ms|mx)\.?\s+/i, "");
  if (!cleaned) return { first: null, last: null };
  const [first, ...rest] = cleaned.split(" ");
  return { first: first.slice(0, 100) || null, last: rest.join(" ").slice(0, 100) || null };
}

/** "https://www.Acme.com/about" -> "acme.com"; null for anything that is not a domain. */
export function normaliseDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host) ? host : null;
}

function cleanEmail(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

function cleanUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined, max: number): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sameText(a: string | null | undefined, b: string): boolean {
  return (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

function eq(propertyName: string, value: string): Filter {
  return { propertyName, operator: "EQ", value };
}

/** Drops empty values: HubSpot treats "" as "clear this field". */
function compact(props: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (typeof v === "string" && v.trim()) out[k] = v;
  return out;
}

function hasValue(v: unknown): boolean {
  return typeof v === "string" ? v.trim() !== "" : v != null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function idString(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ------------------------------------------------------------------ HTTP client

interface HubSpotErrorBody {
  message?: string;
  category?: string;
  errors?: Array<{ message?: string; context?: Record<string, unknown> }>;
}

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: HubSpotErrorBody | null,
  ) {
    super(message);
    this.name = "HubSpotError";
  }

  /** Property names HubSpot refused (does not exist, read-only, invalid value). */
  get invalidProperties(): string[] {
    const names = new Set<string>();
    const texts = [this.body?.message ?? "", ...(this.body?.errors ?? []).map((e) => e.message ?? "")];
    for (const text of texts) {
      // "Property values were not valid: [{...,"name":"hs_linkedin_url",...}]"
      for (const m of text.matchAll(/"name"\s*:\s*"([A-Za-z0-9_]+)"/g)) names.add(m[1]);
      // 'Property "hs_linkedin_url" does not exist'
      for (const m of text.matchAll(/[Pp]roperty \\?"([A-Za-z0-9_]+)\\?"/g)) names.add(m[1]);
    }
    for (const e of this.body?.errors ?? []) {
      const list = e.context?.propertyName;
      if (Array.isArray(list)) for (const n of list) if (typeof n === "string") names.add(n);
    }
    return [...names];
  }

  /** From a 409 "Contact already exists. Existing ID: 123". */
  get existingId(): string | null {
    return /Existing ID:\s*(\d+)/i.exec(this.body?.message ?? "")?.[1] ?? null;
  }

  get mentionsAssociation(): boolean {
    return /associat/i.test([this.body?.message ?? "", ...(this.body?.errors ?? []).map((e) => e.message ?? "")].join(" "));
  }

  static from(status: number, text: string): HubSpotError {
    let body: HubSpotErrorBody | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) body = parsed as HubSpotErrorBody;
    } catch {
      // not JSON (a gateway page): keep the snippet below
    }
    const detail = body?.message?.trim() || text.replace(/\s+/g, " ").trim().slice(0, 200);
    let msg: string;
    if (status === 401) msg = "HubSpot rejected the access token (401). Check HUBSPOT_ACCESS_TOKEN.";
    else if (status === 403) {
      const scopes = requiredScopes(body);
      msg = scopes.length
        ? `The HubSpot private app is missing a scope: ${scopes.join(", ")}.`
        : `HubSpot refused the request (403)${detail ? `: ${truncate(detail, 300)}` : ""}.`;
    } else if (status === 429) msg = "HubSpot's rate limit was reached. Try again in a minute.";
    else msg = `HubSpot answered ${status}${body?.category ? ` (${body.category})` : ""}${detail ? `: ${truncate(detail, 400)}` : ""}`;
    return new HubSpotError(msg, status, body);
  }
}

function requiredScopes(body: HubSpotErrorBody | null): string[] {
  const scopes = new Set<string>();
  for (const e of body?.errors ?? []) {
    for (const key of ["requiredGranularScopes", "requiredScopes", "requiredScope"]) {
      const list = e.context?.[key];
      if (Array.isArray(list)) for (const s of list) if (typeof s === "string") scopes.add(s);
    }
  }
  return [...scopes];
}

function parseObject(raw: unknown): CrmObject | null {
  if (!isRecord(raw)) return null;
  const id = idString(raw.id);
  if (!id) return null;
  const properties: CrmObject["properties"] = {};
  if (isRecord(raw.properties)) {
    for (const [k, v] of Object.entries(raw.properties)) properties[k] = v == null ? null : String(v);
  }
  return { id, properties };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ledger operation for a CRM path, e.g. "POST objects/contacts/search": no version, no record ids or emails. */
function hubspotOperation(method: string, path: string): string {
  const words = path
    .split("/")
    .filter((p) => /^[a-z_]{2,30}$/.test(p) && p !== "crm")
    .slice(0, 3);
  return `${method} ${words.join("/") || "request"}`;
}

class HubSpotClient {
  private readonly deadline = AbortSignal.timeout(PUSH_BUDGET_MS);

  constructor(
    private readonly token: string,
    private readonly warnings: string[],
  ) {}

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  /**
   * One HubSpot call. Retries once on 429 (the request was refused, so a retry is
   * always safe) and, for idempotent calls only, on 5xx and network errors: a
   * create is never sent twice, since a lost reply may hide a record that exists.
   */
  call(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; idempotent: boolean },
  ): Promise<unknown> {
    // Usage ledger: the CRM API is free; requests are counted. One row per call, its retry included.
    const used = () => ({ units: { requests: 1 }, ...FREE });
    return metered({ provider: "hubspot", operation: hubspotOperation(method, path), onOk: used, onFail: used }, () =>
      this.callUnmetered(method, path, opts),
    );
  }

  private async callUnmetered(
    method: "GET" | "POST" | "PATCH" | "PUT",
    path: string,
    opts: { body?: unknown; query?: Record<string, string>; idempotent: boolean },
  ): Promise<unknown> {
    const url = new URL(path, API_BASE);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    for (let attempt = 1; ; attempt++) {
      if (this.deadline.aborted) throw new HubSpotError(`The HubSpot push took longer than ${PUSH_BUDGET_MS / 1000} s and was stopped.`, 0, null);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.deadline]),
          cache: "no-store",
        });
      } catch (err) {
        if (this.deadline.aborted) throw new HubSpotError(`The HubSpot push took longer than ${PUSH_BUDGET_MS / 1000} s and was stopped.`, 0, null);
        if (attempt === 1 && opts.idempotent) {
          await sleep(800);
          continue;
        }
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        throw new HubSpotError(
          timedOut ? `HubSpot did not answer within ${REQUEST_TIMEOUT_MS / 1000} s.` : `Could not reach HubSpot (${message(err)}).`,
          0,
          null,
        );
      }
      const text = await res.text().catch(() => "");
      if (res.ok) {
        if (!text.trim()) return null;
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new HubSpotError("HubSpot sent a reply that is not JSON.", res.status, null);
        }
      }
      if (attempt === 1 && (res.status === 429 || (opts.idempotent && res.status >= 500))) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 1500);
        continue;
      }
      throw HubSpotError.from(res.status, text);
    }
  }

  async ownerByEmail(email: string): Promise<string | null> {
    // Filtered by email server-side; matched again here in case the filter is ignored.
    const raw = await this.call("GET", `/crm/owners/${VERSION}`, { query: { email, limit: "100", archived: "false" }, idempotent: true });
    const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
    const owner = results.find((o) => isRecord(o) && typeof o.email === "string" && o.email.toLowerCase() === email);
    return isRecord(owner) ? idString(owner.id) : null;
  }

  async dealPipelines(): Promise<Pipeline[]> {
    return parsePipelines(await this.call("GET", `/crm/pipelines/${VERSION}/deals`, { idempotent: true }));
  }

  async getContactByEmail(email: string, properties: string[]): Promise<CrmObject | null> {
    try {
      const raw = await this.call("GET", `/crm/objects/${VERSION}/contacts/${encodeURIComponent(email)}`, {
        query: { idProperty: "email", properties: properties.join(",") },
        idempotent: true,
      });
      return parseObject(raw);
    } catch (err) {
      if (err instanceof HubSpotError && err.status === 404) return null;
      throw err;
    }
  }

  /** OR across groups, AND within a group. Oldest record first: in a CRM with duplicates it is usually the real one. */
  async search(type: ObjectType, groups: Filter[][], properties: string[], limit = 1): Promise<CrmObject[]> {
    const raw = await this.call("POST", `/crm/objects/${VERSION}/${type}/search`, {
      body: {
        filterGroups: groups.map((filters) => ({ filters })),
        properties,
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
        limit,
      },
      idempotent: true, // a search changes nothing
    });
    const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
    return results.map(parseObject).filter((o): o is CrmObject => o !== null);
  }

  async searchOne(type: ObjectType, groups: Filter[][], properties: string[]): Promise<CrmObject | null> {
    return (await this.search(type, groups, properties, 1))[0] ?? null;
  }

  /**
   * Creates a record with its associations in one call, so a note is never left
   * unlinked. Two fallbacks: properties HubSpot refuses are dropped (except `keep`)
   * and the create retried once; an association HubSpot refuses is replaced by a
   * plain create plus the default association type.
   */
  async create(type: ObjectType, properties: Record<string, string>, associations: AssociationSpec[], keep: Set<string> = new Set()): Promise<CrmObject> {
    const send = (props: Record<string, string>, withAssociations: boolean) =>
      this.call("POST", `/crm/objects/${VERSION}/${type}`, {
        body: {
          properties: props,
          ...(withAssociations && associations.length
            ? {
                associations: associations.map((a) => ({
                  to: { id: a.toId },
                  types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: a.typeId }],
                })),
              }
            : {}),
        },
        idempotent: false,
      });

    let raw: unknown;
    try {
      raw = await this.withPropertyFallback(type, properties, keep, (props) => send(props, true));
    } catch (err) {
      if (!(err instanceof HubSpotError) || err.status !== 400 || !associations.length || !err.mentionsAssociation) throw err;
      raw = await this.withPropertyFallback(type, properties, keep, (props) => send(props, false));
      const bare = parseObject(raw);
      if (bare) for (const a of associations) await this.associateOrWarn(type, bare.id, a.toType, a.toId);
    }
    const created = parseObject(raw);
    if (!created) throw new HubSpotError(`HubSpot created the ${SINGULAR[type]} but sent back no id.`, 200, null);
    return created;
  }

  /** Sets only the fields that are empty on the existing record. Failures are warnings: the record exists either way. */
  async fillBlanks(type: ObjectType, existing: CrmObject, wanted: Record<string, string>): Promise<void> {
    const patch = Object.fromEntries(Object.entries(wanted).filter(([k]) => !hasValue(existing.properties[k])));
    if (!Object.keys(patch).length) return;
    try {
      await this.withPropertyFallback(
        type,
        patch,
        new Set(),
        (props) =>
          this.call("PATCH", `/crm/objects/${VERSION}/${type}/${encodeURIComponent(existing.id)}`, { body: { properties: props }, idempotent: true }),
        { emptyIsDone: true },
      );
    } catch (err) {
      this.warn(`Could not fill in empty fields on the existing ${SINGULAR[type]} (${message(err)}).`);
    }
  }

  /** Links two existing records with the default association type. Idempotent (PUT). */
  async associateOrWarn(fromType: ObjectType, fromId: string, toType: ObjectType, toId: string): Promise<void> {
    try {
      await this.call(
        "PUT",
        `/crm/objects/${VERSION}/${SINGULAR[fromType]}/${encodeURIComponent(fromId)}/associations/default/${SINGULAR[toType]}/${encodeURIComponent(toId)}`,
        { idempotent: true },
      );
    } catch (err) {
      this.warn(`Could not link the ${SINGULAR[fromType]} to the ${SINGULAR[toType]} (${message(err)}).`);
    }
  }

  /**
   * Sends once; on a 400 naming refused properties (e.g. one this HubSpot account
   * does not have), drops them, never those in `keep`, and sends once more. When
   * nothing is left to send, an update is simply done; a create still fails.
   */
  private async withPropertyFallback(
    type: ObjectType,
    properties: Record<string, string>,
    keep: Set<string>,
    send: (props: Record<string, string>) => Promise<unknown>,
    opts: { emptyIsDone?: boolean } = {},
  ): Promise<unknown> {
    try {
      return await send(properties);
    } catch (err) {
      if (!(err instanceof HubSpotError) || err.status !== 400) throw err;
      const refused = err.invalidProperties.filter((name) => name in properties && !keep.has(name));
      if (!refused.length) throw err;
      const rest = Object.fromEntries(Object.entries(properties).filter(([k]) => !refused.includes(k)));
      this.warn(`HubSpot refused ${refused.join(", ")} on the ${SINGULAR[type]}; left ${refused.length === 1 ? "that field" : "those fields"} out.`);
      if (!Object.keys(rest).length) {
        if (opts.emptyIsDone) return null;
        throw err;
      }
      return send(rest);
    }
  }
}
