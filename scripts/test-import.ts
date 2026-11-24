/**
 * Tests for bulk import, leads without a LinkedIn URL, and the email lookup.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-import.ts
 *   ... scripts/test-import.ts --unit      the pure parts only (no database, no network)
 *
 * 1. csv        parseCsv, parseCsvTable, detectDelimiter
 * 2. columns    guessMapping, toImportRows and the cell cleaners
 * 3. prepare    prepareImport: what is skipped and why, LinkedIn normalisation, repeats in a batch
 * 4. hunter     the email pattern: building addresses (pure), then the fallback against a mocked
 *               Hunter API: accept-all guess, verified, undeliverable dropped, no pattern, 202 polls,
 *               reported credits, and the usage-ledger rows (written for a temp lead, then removed)
 * 5. sheet      Google Sheet links, then POST /api/import/sheet with a mocked fetch: a public sheet,
 *               a private one, a non-Google link, a redirect off Google, the size cap, a timeout
 * 6. hubspot    GET /api/import/hubspot with a mocked HubSpot API: no token, paging, LinkedIn
 *               property detection, a missing schema scope
 * 7. import     POST /api/leads/import against Neon with temp leads: created, skipped, duplicates
 *               (existing and within the batch), events, no research, and the daily cap with a burst
 * 8. linkedin   research for a lead without a LinkedIn URL, with a mocked Exa: found and saved, not
 *               found (the run ends with the message), and a profile another lead already has
 * 9. email      POST /api/leads/[id]/email against Neon with a mocked Hunter: saved with its kind,
 *               an address the team added is kept, refusals, and the daily lookup cap
 *
 * Every outside API is mocked: no Hunter, Exa or HubSpot credit is spent, and usage rows from the
 * mocks are kept out of the ledger (USAGE_LEDGER_DISABLED=1), except for one ledger check whose
 * rows are deleted again. Temp leads, their events and the quota rows they took are removed at
 * the end. Prints statuses and short snippets only, never a key.
 */
// First, as in Next's own server: installs globalThis.AsyncLocalStorage for the request scope.
import "next/dist/server/node-environment-baseline";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import * as importRoute from "../src/app/api/leads/import/route";
import * as sheetRoute from "../src/app/api/import/sheet/route";
import * as hubspotImportRoute from "../src/app/api/import/hubspot/route";
import * as emailRoute from "../src/app/api/leads/[id]/email/route";
import { CSV_DELIMITERS, detectDelimiter, parseCsv, parseCsvTable } from "../src/lib/import/csv";
import { cellEmail, cellHubspotId, cellText, guessMapping, IMPORT_FIELDS, normaliseHeader, toImportRows, type ColumnMapping } from "../src/lib/import/columns";
import { duplicateReason, prepareImport, SKIP_REASONS } from "../src/lib/import/prepare";
import { downloadSheetCsv, isAllowedSheetHost, parseSheetLink, SHEET_MESSAGES, SheetError, sheetExportUrl } from "../src/lib/import/sheet";
import { linkedinPropertyNames } from "../src/lib/providers/hubspot";
import { domainInfo, emailFromPattern, emailPart, findEmail, patternName } from "../src/lib/providers/hunter";
import { query } from "../src/lib/db";
import { listEvents } from "../src/lib/repo/events";
import { IMPORT_EVENT_MESSAGES } from "../src/lib/repo/import";
import { createLead, deleteLead, getLead, updateLead } from "../src/lib/repo/leads";
import { creditUnits, DEFAULT_HUNTER_CREDITS_PER_DAY, DEFAULT_IMPORTS_PER_DAY, emailLookupLimitMessage, importLimitMessage, LOOKUP_MAX_UNITS, quotaLimit, quotaUsed } from "../src/lib/repo/quota";
import { ResearchStop } from "../src/lib/research/context";
import { identify, PROFILE_NOT_FOUND } from "../src/lib/research/identify";
import { runResearch } from "../src/lib/research/pipeline";
import { Deadline, splitName } from "../src/lib/research/util";
import { withUsageContext } from "../src/lib/usage/ledger";
import { DEFAULT_SETTINGS, type Lead } from "../src/lib/types";

// ------------------------------------------------------------------ compile-time checks
// The shape Next's generated route validator requires; `npx tsc --noEmit` fails here if a handler drifts.
type RouteHandler<P> = (request: NextRequest, context: { params: Promise<P> }) => Promise<Response | void> | Response | void;
type RouteHandlerConfig<P> = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS", RouteHandler<P>>>;
void (importRoute satisfies RouteHandlerConfig<Record<string, never>>);
void (sheetRoute satisfies RouteHandlerConfig<Record<string, never>>);
void (hubspotImportRoute satisfies RouteHandlerConfig<Record<string, never>>);
void (emailRoute satisfies RouteHandlerConfig<{ id: string }>);

// ------------------------------------------------------------------ tiny harness

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else failed++;
  const extra = !ok && detail !== undefined ? ` -- ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 400)}` : "";
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}

const UNIT_ONLY = process.argv.includes("--unit");
const RUN = randomBytes(3).toString("hex");

/** Env vars the tests change; restored at the end. */
const ENV_KEYS = [
  "VERCEL",
  "ALLOW_OPEN_ACCESS",
  "APP_PASSWORD",
  "SESSION_SECRET",
  "HUBSPOT_ACCESS_TOKEN",
  "HUNTER_API_KEY",
  "IMPORT_LIMIT_PER_DAY",
  "HUNTER_CREDITS_PER_DAY",
  "UNIPILE_API_KEY",
  "UNIPILE_DSN",
  "UNIPILE_ACCOUNT_ID",
  "APIFY_TOKEN",
  "APOLLO_API_KEY",
  "EXA_API_KEY",
  "USAGE_LEDGER_DISABLED",
] as const;
type EnvName = (typeof ENV_KEYS)[number];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<EnvName, string | undefined>;
function setEnv(vars: Partial<Record<EnvName, string | undefined>>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv(): void {
  setEnv(originalEnv);
}

// ------------------------------------------------------------------ fetch mocks

const realFetch = globalThis.fetch;

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string | null;
}

type Responder = (req: Seen, signal: AbortSignal | null) => Response | Promise<Response> | null | undefined;

/** Swaps fetch: requests to the given hosts go to the responders (in order); anything else (Neon) goes to the network. */
function mockFetch(hosts: (host: string) => boolean, responders: Responder[]): { calls: Seen[]; restore: () => void } {
  const calls: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!hosts(url.hostname)) return realFetch(input, init);
    const req: Seen = { method: init?.method ?? "GET", url, headers: new Headers(init?.headers), body: init?.body ? String(init.body) : null };
    calls.push(req);
    for (const r of responders) {
      const res = await r(req, init?.signal ?? null);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: `not mocked: ${req.method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
}

const jsonReply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// ------------------------------------------------------------------ route harness (as in scripts/test-api.ts)

/** Tasks handed to next/server after() during route calls. Recorded only, never run. */
const afterTasks: unknown[] = [];

interface CallResult {
  status: number;
  data: Record<string, unknown> | null;
}

type Handler = (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const asHandler = (fn: unknown) => fn as Handler;

async function callRoute(handler: Handler, opts: { method?: string; path: string; body?: unknown; rawBody?: string; id?: string; headers?: Record<string, string> }): Promise<CallResult> {
  const method = opts.method ?? "GET";
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const request = new NextRequest(new URL(opts.path, "http://localhost:3000"), {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: method === "GET" ? undefined : body,
  });
  const ctx = { params: Promise.resolve({ id: opts.id ?? "" }) };
  const workStore = { route: opts.path, forceStatic: false, dynamicShouldError: false, afterContext: { after: (task: unknown) => void afterTasks.push(task) } };
  const unitStore = { type: "request", phase: "action" };
  const res = await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(unitStore as never, () => handler(request, ctx)));
  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

/** Temp leads (and so the quota rows tagged with them) to remove at the end. */
const tempLeadIds = new Set<string>();

async function tempLead(fields: Partial<Lead> & { linkedinUrl?: string | null } = {}): Promise<Lead> {
  const url = fields.linkedinUrl === undefined ? `https://www.linkedin.com/in/le-import-test-${RUN}-${randomBytes(3).toString("hex")}` : fields.linkedinUrl;
  let lead: Lead;
  if (url) {
    lead = await createLead({ linkedinUrl: url, name: fields.name ?? null, companyName: fields.companyName ?? null });
  } else {
    const rows = await query<{ id: string }>("insert into le_leads (linkedin_url, name, company_name, source) values (null, $1, $2, 'csv') returning id", [
      fields.name ?? null,
      fields.companyName ?? null,
    ]);
    lead = (await getLead(rows[0].id))!;
  }
  tempLeadIds.add(lead.id);
  const { linkedinUrl: _ignored, ...rest } = fields;
  void _ignored;
  const patch = Object.fromEntries(Object.entries(rest).filter(([k]) => !["id", "name", "companyName", "linkedinSlug", "source", "hubspotContactId", "createdAt", "updatedAt"].includes(k)));
  if (Object.keys(patch).length) lead = (await updateLead(lead.id, patch))!;
  return lead;
}

// ------------------------------------------------------------------ 1. csv

function testCsv(): void {
  section("1. csv");
  eq("simple", parseCsv("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]);
  eq("CRLF line ends", parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  eq("lone CR line ends (old Mac Excel)", parseCsv("a,b\r1,2\r3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
  eq("no line break at the end", parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  eq("quoted fields with delimiters and line breaks", parseCsv('name,notes\n"Doe, Jane","line one\nline two"\n'), [["name", "notes"], ["Doe, Jane", "line one\nline two"]]);
  eq("escaped quotes", parseCsv('a\n"She said ""hi"""\n'), [["a"], ['She said "hi"']]);
  eq("empty quoted field and empty fields", parseCsv('a,b,c\n"",,x\n'), [["a", "b", "c"], ["", "", "x"]]);
  eq("CRLF inside quotes is kept", parseCsv('a\n"x\r\ny"\r\n'), [["a"], ["x\r\ny"]]);
  eq("a quote inside an unquoted field is a character", parseCsv('a\n5" screen\n'), [["a"], ['5" screen']]);
  eq("text after a closing quote joins the field", parseCsv('a\n"abc"def\n'), [["a"], ["abcdef"]]);
  eq("an unclosed quote runs to the end", parseCsv('a\n"open, field\nmore'), [["a"], ["open, field\nmore"]]);
  eq("UTF-8 BOM is dropped", parseCsv("﻿name,email\nJane,j@x.co"), [["name", "email"], ["Jane", "j@x.co"]]);
  eq("blank lines inside stay as blank records", parseCsv("a\n\nb\n"), [["a"], [""], ["b"]]);
  eq("empty text", parseCsv(""), []);
  eq("maxRecords", parseCsv("a\nb\nc\n", { maxRecords: 2 }), [["a"], ["b"]]);

  eq("detects a comma", detectDelimiter("name,company,email\nJane,Acme,j@acme.com\n"), ",");
  eq("detects a semicolon (European Excel)", detectDelimiter("Name;Company;Score\nJane;Acme;1,5\nRick;Roe Inc;2,5\n"), ";");
  eq("detects a tab (pasted from a sheet)", detectDelimiter("Name\tCompany\tNotes\nJane\tAcme, Inc\tmet, twice\n"), "\t");
  eq("a comma inside quotes does not make a column", detectDelimiter('"Doe, Jane"\n"Roe, Rick"\n'), ",");
  eq("one column defaults to a comma", detectDelimiter("linkedin\nhttps://linkedin.com/in/a\n"), ",");
  eq("delimiters on offer", [...CSV_DELIMITERS], [",", ";", "\t"]);

  const table = parseCsvTable("﻿\n\n First Name ;Last Name;Email\nJane;Doe;jane@acme.com\n;;\nRick;Roe;rick@roe.io\n\n\n");
  eq("table: semicolon file, header after blank lines, trimmed headers", table.headers, ["First Name", "Last Name", "Email"]);
  eq("table: delimiter", table.delimiter, ";");
  eq("table: headerRow counts the blank lines above", table.headerRow, 3);
  eq("table: blank record inside kept, trailing blank records dropped", table.rows, [["Jane", "Doe", "jane@acme.com"], ["", "", ""], ["Rick", "Roe", "rick@roe.io"]]);
  eq("table: empty text", parseCsvTable(""), { headers: [], rows: [], delimiter: ",", headerRow: 1 });
  const big = `a,b\n${"x,y\n".repeat(200_000)}`;
  const t0 = Date.now();
  const bigTable = parseCsvTable(big);
  check(`table: 200,000 rows parse quickly (${Date.now() - t0} ms)`, bigTable.rows.length === 200_000 && Date.now() - t0 < 5_000);
}

// ------------------------------------------------------------------ 2. columns

function mapped(mapping: ColumnMapping, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of IMPORT_FIELDS) if (mapping[f] !== null) out[f] = headers[mapping[f]!];
  return out;
}

function testColumns(): void {
  section("2. columns");
  eq("normaliseHeader", normaliseHeader("  E-mail Address "), "e mail address");

  const apollo = ["First Name", "Last Name", "Title", "Company", "Company Name for Emails", "Email", "Email Status", "Email Confidence", "Person Linkedin Url", "Website", "Company Linkedin Url", "City"];
  eq("Apollo export", mapped(guessMapping(apollo), apollo), {
    linkedinUrl: "Person Linkedin Url",
    firstName: "First Name",
    lastName: "Last Name",
    company: "Company",
    title: "Title",
    email: "Email",
  });
  const hubspot = ["Record ID", "First Name", "Last Name", "Email", "Phone Number", "Company Name", "Job Title", "Lead Status", "Create Date"];
  eq("HubSpot export", mapped(guessMapping(hubspot), hubspot), {
    firstName: "First Name",
    lastName: "Last Name",
    company: "Company Name",
    title: "Job Title",
    email: "Email",
    hubspotId: "Record ID",
  });
  const ours = ["HubSpot ID", "First name", "Last name", "Email", "Company", "Job title", "LinkedIn URL"];
  eq("our HubSpot listing maps every column", mapped(guessMapping(ours), ours), {
    linkedinUrl: "LinkedIn URL",
    firstName: "First name",
    lastName: "Last name",
    company: "Company",
    title: "Job title",
    email: "Email",
    hubspotId: "HubSpot ID",
  });
  const sheet = ["Full Name", "Organisation", "Position", "E-mail", "LinkedIn", "Comments"];
  eq("a hand-made sheet", mapped(guessMapping(sheet), sheet), {
    linkedinUrl: "LinkedIn",
    name: "Full Name",
    company: "Organisation",
    title: "Position",
    email: "E-mail",
    notes: "Comments",
  });
  const loose = ["Contact Full Name", "Current Employer", "Primary E-mail (work)", "LinkedIn Profile Link", "Email Verified"];
  eq("loose header names", mapped(guessMapping(loose), loose), {
    linkedinUrl: "LinkedIn Profile Link",
    name: "Contact Full Name",
    company: "Current Employer",
    email: "Primary E-mail (work)",
  });
  const companyOnly = ["Name", "Company LinkedIn URL", "Email Status"];
  eq("a company's LinkedIn page and an email status are not the person's", mapped(guessMapping(companyOnly), companyOnly), { name: "Name" });
  const connections = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
  const sample = [
    ["Jane", "Doe", "https://www.linkedin.com/in/janedoe", "", "Acme", "CTO", "01 Jan 2026"],
    ["Rick", "Roe", "https://www.linkedin.com/in/rickroe", "rick@roe.io", "Roe", "CEO", "02 Jan 2026"],
  ];
  eq("LinkedIn's own export: the URL column is read from its values", mapped(guessMapping(connections, sample), connections).linkedinUrl, "URL");
  eq("without rows a bare URL column stays unmapped", guessMapping(connections).linkedinUrl, null);
  eq("case-insensitive", mapped(guessMapping(["EMAIL", "NAME"]), ["EMAIL", "NAME"]), { name: "NAME", email: "EMAIL" });

  eq("cellText trims and collapses", cellText("  Acme \n Robotics ", 100), "Acme Robotics");
  eq("cellText placeholders are empty", ["N/A", "-", "none", " ", "#N/A", "null"].map((v) => cellText(v, 10)), [null, null, null, null, null, null]);
  eq("cellText caps the length", cellText("abcdef", 3), "abc");
  eq("cellText keeps line breaks in notes", cellText("one\r\ntwo  \n\n\n\nthree", 100, { multiline: true }), "one\ntwo\n\nthree");
  eq("cellEmail", ["mailto:Jane@Acme.com", "Jane Doe <jane@acme.com>", "jane@acme.com; jd@old.io", "not an email"].map(cellEmail), ["jane@acme.com", "jane@acme.com", "jane@acme.com", "not an email"]);
  eq("cellHubspotId", ["12345", "12345.0", " 1,234 ", "abc"].map(cellHubspotId), ["12345", "12345", "1234", "abc"]);

  const headers = ["First", "Last", "Company", "Email", "LinkedIn", "Notes", "Record ID"];
  const mapping = guessMapping(headers);
  const rows = toImportRows(
    [
      ["Jane", "Doe", "Acme", "JANE@ACME.COM", "linkedin.com/in/janedoe", "Met at CoRL", "101"],
      ["", "", "", "", "", "", ""],
      ["Rick", "", "Roe Inc", "n/a", "", "", ""],
    ],
    mapping,
    5,
  );
  eq("toImportRows: first and last joined, email lower case, blank row left out, row numbers kept", rows, [
    { linkedinUrl: "linkedin.com/in/janedoe", name: "Jane Doe", company: "Acme", title: null, email: "jane@acme.com", notes: "Met at CoRL", hubspotId: "101", row: 5 },
    { linkedinUrl: null, name: "Rick", company: "Roe Inc", title: null, email: null, notes: null, hubspotId: null, row: 7 },
  ]);
  const full = toImportRows([["Jane Doe", "J", "D"]], { ...guessMapping(["Name", "First name", "Last name"]) });
  eq("toImportRows: a full-name column wins over first and last", full[0]?.name, "Jane Doe");
}

// ------------------------------------------------------------------ 3. prepare

function testPrepare(): void {
  section("3. prepare");
  let n = 0;
  const ids = () => `id-${++n}`;
  const p = prepareImport(
    [
      { linkedinUrl: "https://www.LinkedIn.com/in/Jane-Doe/?trk=x", name: "Jane" },
      { name: "Rick Roe", company: "Roe Inc" },
      { name: "Sam Lee", email: "SAM@LEE.IO" },
      { name: "Only Name" },
      { company: "Acme", email: "x@acme.com" },
      { linkedinUrl: "https://www.linkedin.com/company/acme", name: "Co", company: "Acme" },
      { linkedinUrl: "jane-doe", name: "Slug Only", company: "Acme" },
      { name: "Bad Email", company: "Acme", email: "jane at acme" },
      { linkedinUrl: "linkedin.com/in/jane-doe", name: "Jane again" },
      { name: "Sam again", company: "Other", email: "sam@lee.io", linkedinUrl: "linkedin.com/in/sam-lee" },
      { name: "Sam third", company: "Other", linkedinUrl: "https://linkedin.com/in/SAM-LEE" },
      { name: "HS", company: "Acme", hubspotId: 777 },
      { name: "HS dup", company: "Acme", hubspotId: "777.0" },
      { name: "HS junk id", company: "Acme", hubspotId: "abc" },
      { linkedinUrl: "N/A", name: "Placeholder", company: "Acme" },
      {},
      { name: "Rick  ROE", company: "roe inc" },
    ],
    ids,
  );
  eq(
    "kept rows (index: url | name | email | hubspot)",
    p.candidates.map((c) => `${c.index}:${c.linkedinUrl ?? "-"}|${c.name ?? "-"}|${c.email ?? "-"}|${c.hubspotContactId ?? "-"}`),
    [
      "0:https://www.linkedin.com/in/jane-doe|Jane|-|-",
      "1:-|Rick Roe|-|-",
      "2:-|Sam Lee|sam@lee.io|-",
      "11:-|HS|-|777",
      "13:-|HS junk id|-|-",
      "14:-|Placeholder|-|-",
    ],
  );
  eq("ids come from the generator, in order", p.candidates.map((c) => c.id), ["id-1", "id-2", "id-3", "id-4", "id-5", "id-6"]);
  eq("skipped with reasons", p.skipped, [
    { index: 3, reason: SKIP_REASONS.notEnough },
    { index: 4, reason: SKIP_REASONS.notEnough },
    { index: 5, reason: SKIP_REASONS.badLinkedin },
    { index: 6, reason: SKIP_REASONS.badLinkedin },
    { index: 7, reason: SKIP_REASONS.badEmail },
    { index: 15, reason: SKIP_REASONS.notEnough },
  ]);
  eq("repeats: same profile, same email (and its profile then), same HubSpot id", p.repeats, [
    { index: 8, duplicateOf: 0, match: "linkedin" },
    { index: 9, duplicateOf: 2, match: "email" },
    { index: 10, duplicateOf: 2, match: "linkedin" },
    { index: 12, duplicateOf: 11, match: "hubspot" },
    { index: 16, duplicateOf: 1, match: "name" },
  ]);
  eq("a name key only for rows with nothing else", p.candidates.map((c) => c.nameKey), [null, "rick roe|roe inc", null, null, "hs junk id|acme", "placeholder|acme"]);
  eq(
    "duplicate reasons",
    [duplicateReason("email", false), duplicateReason("linkedin", true), duplicateReason("name", false)],
    ["Already a lead with this email.", "Same LinkedIn profile as an earlier row in this import.", "Already a lead with this name and company."],
  );
  const long = prepareImport([{ name: "x".repeat(500), company: "Acme", notes: "n".repeat(9000) }], ids);
  check("long values are cut to the field limits", long.candidates[0]?.name?.length === 200 && long.candidates[0]?.notes?.length === 5000);
}

// ------------------------------------------------------------------ 4. hunter

const HUNTER = (host: string) => host === "api.hunter.io";

interface HunterScript {
  finder?: unknown;
  finderStatus?: number;
  domain?: unknown;
  domainHeaders?: Record<string, string>;
  verifier?: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}

function hunterMock(script: HunterScript) {
  let verifies = 0;
  return mockFetch(HUNTER, [
    (r) => (r.url.pathname === "/v2/email-finder" ? jsonReply(script.finder ?? { data: { email: null, score: null } }, script.finderStatus ?? 200) : null),
    (r) => (r.url.pathname === "/v2/domain-search" ? jsonReply(script.domain ?? { data: { pattern: null, accept_all: false, emails: [] } }, 200, script.domainHeaders) : null),
    (r) => {
      if (r.url.pathname !== "/v2/email-verifier") return null;
      const step = script.verifier?.[Math.min(verifies++, (script.verifier?.length ?? 1) - 1)] ?? { status: 200, body: { data: { status: "unknown" } } };
      return jsonReply(step.body ?? {}, step.status, step.headers);
    },
  ]);
}

const DOMAIN = (pattern: string | null, acceptAll: boolean, extra: Record<string, unknown> = {}) => ({
  data: { domain: "mecka.ai", pattern, accept_all: acceptAll, webmail: false, disposable: false, emails: [{ value: "someone@mecka.ai" }], ...extra },
});

async function testHunter(): Promise<void> {
  section("4. hunter (pattern fallback)");
  const name = { first: "Jane", last: "Doe" };
  eq(
    "patterns",
    ["{first}", "{last}", "{first}.{last}", "{f}{last}", "{first}{l}", "{first}_{last}", "{first}-{last}", "{last}.{first}", "{f}.{last}", "{first}{last}", "{F}{Last}"].map((p) => {
      const r = emailFromPattern(p, name, "Mecka.AI");
      return "email" in r ? r.email : r.error;
    }),
    ["jane@mecka.ai", "doe@mecka.ai", "jane.doe@mecka.ai", "jdoe@mecka.ai", "janed@mecka.ai", "jane_doe@mecka.ai", "jane-doe@mecka.ai", "doe.jane@mecka.ai", "j.doe@mecka.ai", "janedoe@mecka.ai", "jdoe@mecka.ai"],
  );
  eq("accents and letters email cannot hold", [emailPart("Zoë"), emailPart("Núñez"), emailPart("Søren"), emailPart("Ødegård"), emailPart("Groß"), emailPart("O'Brien-Smith"), emailPart("Łukasz")], ["zoe", "nunez", "soren", "odegard", "gross", "obriensmith", "lukasz"]);
  const built = emailFromPattern("{first}.{last}", { first: "Jürgen", last: "van der Berg" }, "acme.de");
  eq("a multi-word last name is joined", "email" in built ? built.email : built.error, "jurgen.vanderberg@acme.de");
  check("a bare initial is not a first name for {first}", "error" in emailFromPattern("{first}.{last}", { first: "J.", last: "Doe" }, "acme.com"));
  eq("an initial is enough for {f}", (emailFromPattern("{f}{last}", { first: "J.", last: "Doe" }, "acme.com") as { email: string }).email, "jdoe@acme.com");
  const noLast = emailFromPattern("{first}.{last}", { first: "Jane", last: null }, "acme.com");
  check("a pattern that needs the last name, without one", "error" in noLast && /last name/.test(noLast.error), noLast);
  eq("a pattern that needs only the first name, without a last name", (emailFromPattern("{first}", { first: "Jane", last: null }, "acme.com") as { email: string }).email, "jane@acme.com");
  check("an unknown pattern token is refused", "error" in emailFromPattern("{first}{middle}", name, "acme.com"));
  check("a pattern with other characters is refused", "error" in emailFromPattern("{first}+sales", name, "acme.com"));
  check("a name with no Latin letters cannot be built", "error" in emailFromPattern("{first}", { first: "李", last: "明" }, "acme.cn"));
  eq("patternName: titles and credentials go, first word of the first name, whole last name", patternName({ fullName: "Dr. Jane Ann van der Berg, PhD" }), { first: "Jane", last: "Ann van der Berg" });
  eq("patternName prefers the profile's own fields", patternName({ fullName: "Jane Doe", firstName: "Mary Jane", lastName: "Doe-Smith" }), { first: "Mary", last: "Doe-Smith" });
  // Fields split from a full name can be only a title or a credential: they must not become the name.
  eq("patternName: a first name that is only a title", patternName({ fullName: "Dr. Jane Doe", firstName: "Dr.", lastName: "Doe" }), { first: "Jane", last: "Doe" });
  eq("patternName: a last name that is only a credential", patternName({ fullName: "Jane Doe PhD", firstName: "Jane", lastName: "PhD" }), { first: "Jane", last: "Doe" });
  eq("patternName: Jr. is not a last name", patternName({ fullName: "Jane Doe Jr.", firstName: "Jane", lastName: "Jr." }), { first: "Jane", last: "Doe" });
  eq("patternName: Prof and MBA", patternName({ fullName: "Prof Jane Doe MBA", firstName: "Prof", lastName: "MBA" }), { first: "Jane", last: "Doe" });
  eq("patternName: a title and a surname only builds nothing", patternName({ fullName: "Ms Doe", firstName: "Ms", lastName: "Doe" }), { first: null, last: "Doe" });
  eq("patternName: look-alike names are kept", patternName({ fullName: "Drew Msimang", firstName: "Drew", lastName: "Msimang" }), { first: "Drew", last: "Msimang" });
  eq("splitName drops a tagline after | or -", [splitName("Jane Doe | Robotics"), splitName("Jane Doe - CEO")], [{ first: "Jane", last: "Doe" }, { first: "Jane", last: "Doe" }]);
  eq("splitName keeps a hyphenated name", splitName("Anne-Marie Doe-Smith"), { first: "Anne-Marie", last: "Doe-Smith" });
  eq("domainInfo", domainInfo(DOMAIN("{first}", true)), { pattern: "{first}", acceptAll: true, webmail: false, disposable: false });

  setEnv({ HUNTER_API_KEY: `test-${randomBytes(6).toString("hex")}` });
  const input = { linkedinUrl: "https://www.linkedin.com/in/jane-doe-mecka", fullName: "Jane Doe", firstName: "Jane", lastName: "Doe", domain: "mecka.ai", company: "Mecka" };

  // Accept-all domain: a guess, no verification.
  let m = hunterMock({ domain: DOMAIN("{first}", true) });
  try {
    const r = await findEmail(input);
    check("accept-all: kept as a guess", r.email === "jane@mecka.ai" && r.emailStatus === "guess" && r.score === 50 && r.acceptAll === true && r.pattern === "{first}", r);
    eq("accept-all: finder then Domain Search, no verifier", m.calls.map((c) => c.url.pathname), ["/v2/email-finder", "/v2/domain-search"]);
    check("accept-all: 1 credit (the Domain Search), 2 requests", r.credits === 1 && r.requests === 2, r);
    const ds = m.calls[1];
    check("Domain Search asks for the domain with limit=1, key in a header", ds.url.searchParams.get("domain") === "mecka.ai" && ds.url.searchParams.get("limit") === "1" && !ds.url.search.includes("api_key") && Boolean(ds.headers.get("x-api-key")));
  } finally {
    m.restore();
  }

  // A domain that does not accept everything: verify; keep only "valid".
  m = hunterMock({ domain: DOMAIN("{first}.{last}", false), verifier: [{ status: 200, body: { data: { status: "valid", result: "deliverable", score: 91 } } }] });
  try {
    const r = await findEmail(input);
    check("verified: kept with the verifier's score", r.email === "jane.doe@mecka.ai" && r.emailStatus === "verified" && r.score === 91, r);
    check("verified: the verifier checked the built address", m.calls[2]?.url.pathname === "/v2/email-verifier" && m.calls[2]?.url.searchParams.get("email") === "jane.doe@mecka.ai");
    check("verified: 1.5 credits over 3 requests", r.credits === 1.5 && r.requests === 3, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ domain: DOMAIN("{first}.{last}", false), verifier: [{ status: 200, body: { data: { status: "invalid", result: "undeliverable", score: 5 } } }] });
  try {
    const r = await findEmail(input);
    check("undeliverable: dropped, with the reason", r.email === null && /does not exist/.test(r.reason ?? "") && !r.error, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ domain: DOMAIN("{first}.{last}", false), verifier: [{ status: 200, body: { data: { status: "accept_all", score: 70 } } }] });
  try {
    const r = await findEmail(input);
    check("the verifier finds the server accepts everything: a guess", r.email === "jane.doe@mecka.ai" && r.emailStatus === "guess" && r.score === 50, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ domain: { data: { domain: "mecka.ai", pattern: null, accept_all: false, emails: [] } } });
  try {
    const r = await findEmail(input);
    check("no pattern: nothing, with the reason", r.email === null && /does not know the email pattern at mecka\.ai/.test(r.reason ?? "") && r.credits === 0, r);
  } finally {
    m.restore();
  }

  m = hunterMock({
    domain: DOMAIN("{f}{last}", false),
    domainHeaders: { "X-Credits-Used": "0", "X-Credits-Unit": "credits" },
    verifier: [{ status: 202, body: { errors: [{ details: "in progress" }] } }, { status: 200, body: { data: { status: "valid", score: 88 } }, headers: { "X-Credits-Used": "0.5", "X-Credits-Unit": "credits" } }],
  });
  try {
    const t = Date.now();
    const r = await findEmail(input);
    check("202 then 200: polled once more and verified", r.email === "jdoe@mecka.ai" && r.emailStatus === "verified" && m.calls.filter((c) => c.url.pathname === "/v2/email-verifier").length === 2, r);
    check("credits as Hunter reported them (a repeated Domain Search is free)", r.credits === 0.5, r);
    console.log(`  (the poll waited ${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } finally {
    m.restore();
  }

  m = hunterMock({ domain: DOMAIN("{first}.{last}", false), verifier: [{ status: 222, body: { errors: [{ details: "smtp" }] } }] });
  try {
    const r = await findEmail(input);
    check("222 (the mail server answered oddly): not verified, dropped", r.email === null && /could not be verified/.test(r.reason ?? ""), r);
  } finally {
    m.restore();
  }

  m = hunterMock({ finder: { data: { email: "Jane@Mecka.ai", score: 77, verification: { status: "valid" }, sources: [{ uri: "https://mecka.ai/team" }] } } });
  try {
    const r = await findEmail(input);
    check("finder hit: found, no fallback", r.email === "jane@mecka.ai" && r.emailStatus === "found" && r.score === 77 && m.calls.length === 1 && r.credits === 1, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ finder: { errors: [{ id: "not_found", details: "profile not in our database" }] }, finderStatus: 404, domain: DOMAIN("{first}", true) });
  try {
    const r = await findEmail(input);
    check("finder 404 (handle unknown): not an error, the pattern still runs", r.email === "jane@mecka.ai" && r.emailStatus === "guess" && !r.error, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ finder: { errors: [{ id: "claimed_email", details: "claimed" }] }, finderStatus: 451 });
  try {
    const r = await findEmail(input);
    check("451 (the person opted out): no fallback", r.email === null && r.status === "claimed" && m.calls.length === 1, r);
  } finally {
    m.restore();
  }

  m = hunterMock({ domain: { data: { domain: "postbox-example.org", pattern: "{first}", webmail: true, accept_all: true, emails: [] } } });
  try {
    const r = await findEmail({ ...input, domain: "postbox-example.org" });
    check("a domain Hunter calls webmail: nothing built", r.email === null && /free or disposable/.test(r.reason ?? ""), r);
    const gmail = await findEmail({ ...input, domain: "gmail.com" });
    check("gmail.com is never a company domain: no Domain Search", gmail.email === null && !m.calls.some((c) => c.url.searchParams.get("domain") === "gmail.com"), gmail);
  } finally {
    m.restore();
  }

  m = hunterMock({});
  try {
    const r = await findEmail({ linkedinUrl: input.linkedinUrl, domain: "mecka.ai" });
    check("no first name: no Domain Search is spent", r.email === null && m.calls.length === 1 && /first name is not known/.test(r.reason ?? ""), { r, calls: m.calls.length });
    const r2 = await findEmail({ ...input, domain: null, company: "Mecka" });
    check("no domain: no Domain Search either", r2.email === null && m.calls.length === 2 && /No company website/.test(r2.reason ?? ""), r2);
    const r3 = await findEmail({ ...input, fallback: false });
    check("fallback: false stops after the finder", r3.email === null && m.calls.length === 3, r3);
  } finally {
    m.restore();
  }

  if (UNIT_ONLY) return;
  // The usage ledger: one row per call with its credits (written for a temp lead, then removed).
  const lead = await tempLead({ name: "Ledger Check" });
  setEnv({ USAGE_LEDGER_DISABLED: undefined });
  m = hunterMock({ domain: DOMAIN("{first}.{last}", false), verifier: [{ status: 200, body: { data: { status: "valid", score: 90 } } }] });
  try {
    await withUsageContext(lead.id, () => findEmail(input));
    const rows = await query<{ operation: string; units: Record<string, number>; cost_basis: string }>(
      "select operation, units, cost_basis from le_usage where lead_id = $1 order by id",
      [lead.id],
    );
    eq(
      "ledger: finder, Domain Search and verifier, each with its credits (rows are written in any order)",
      rows.map((r) => `${r.operation}:${r.units.credits}:${r.cost_basis}`).sort(),
      ["domain-search:1:free", "email-finder:0:free", "email-verifier:0.5:free"],
    );
  } finally {
    m.restore();
    setEnv({ USAGE_LEDGER_DISABLED: "1" });
    await query("delete from le_usage where lead_id = $1", [lead.id]);
  }
}

// ------------------------------------------------------------------ 5. sheet

const SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd";

async function testSheet(): Promise<void> {
  section("5. sheet");
  eq("link with #gid", parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=123456`), { id: SHEET_ID, gid: "123456" });
  eq("link with ?gid", parseSheetLink(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing&gid=42`), { id: SHEET_ID, gid: "42" });
  eq("a second Google account (/u/1/)", parseSheetLink(`https://docs.google.com/spreadsheets/u/1/d/${SHEET_ID}/edit`), { id: SHEET_ID, gid: null });
  eq("no scheme", parseSheetLink(`docs.google.com/spreadsheets/d/${SHEET_ID}`), { id: SHEET_ID, gid: null });
  for (const [label, link] of [
    ["another site", `https://evil.example/spreadsheets/d/${SHEET_ID}/edit`],
    ["a Google look-alike host", `https://docs.google.com.evil.example/spreadsheets/d/${SHEET_ID}`],
    ["a Google Doc", `https://docs.google.com/document/d/${SHEET_ID}/edit`],
    ["a Publish to web link", "https://docs.google.com/spreadsheets/d/e/2PACX-1vRabc/pubhtml"],
    ["a port", `https://docs.google.com:8443/spreadsheets/d/${SHEET_ID}`],
    ["javascript:", "javascript:alert(1)"],
    ["empty", ""],
  ] as const) {
    eq(`refused: ${label}`, parseSheetLink(link), null);
  }
  eq("export URL", sheetExportUrl(SHEET_ID, "7"), `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=7`);
  eq("export URL without a gid (the first tab)", sheetExportUrl(SHEET_ID, null), `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`);
  check(
    "allowed redirect hosts",
    isAllowedSheetHost(new URL("https://doc-0s-4k-sheets.googleusercontent.com/export/x")) &&
      isAllowedSheetHost(new URL("https://docs.google.com/x")) &&
      !isAllowedSheetHost(new URL("http://docs.google.com/x")) &&
      !isAllowedSheetHost(new URL("https://googleusercontent.com.evil.example/x")) &&
      !isAllowedSheetHost(new URL("https://accounts.google.com/x")),
  );

  const post = asHandler(sheetRoute.POST);
  const link = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=99`;
  const csv = "Name,Company,Email,LinkedIn\nJane Doe,Acme,jane@acme.com,https://www.linkedin.com/in/janedoe\nRick Roe,\"Roe, Inc\",,\n";
  const GOOGLE = (host: string) => host === "docs.google.com" || host.endsWith(".googleusercontent.com") || host === "accounts.google.com" || host === "evil.example";

  // A public sheet: Google redirects the export to its download host.
  let m = mockFetch(GOOGLE, [
    (r) =>
      r.url.hostname === "docs.google.com"
        ? new Response(null, { status: 307, headers: { location: "https://doc-0s-4k-sheets.googleusercontent.com/export/abc?format=csv" } })
        : null,
    (r) => (r.url.hostname.endsWith(".googleusercontent.com") ? new Response(csv, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } }) : null),
  ]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("public sheet: 200 with header, rows and total", res.status === 200 && JSON.stringify(res.data?.headers) === JSON.stringify(["Name", "Company", "Email", "LinkedIn"]) && res.data?.total === 2, res.data);
    eq("public sheet: rows as parsed", res.data?.rows, [["Jane Doe", "Acme", "jane@acme.com", "https://www.linkedin.com/in/janedoe"], ["Rick Roe", "Roe, Inc", "", ""]]);
    eq("public sheet: the export URL was built from the id and gid", m.calls[0]?.url.toString(), `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=99`);
    check("public sheet: the redirect was followed to Google's download host", m.calls.length === 2 && m.calls[1].url.hostname.endsWith(".googleusercontent.com"));
  } finally {
    m.restore();
  }

  // A private sheet: Google sends the visitor to its sign-in page.
  m = mockFetch(GOOGLE, [(r) => (r.url.hostname === "docs.google.com" ? new Response(null, { status: 302, headers: { location: "https://accounts.google.com/ServiceLogin?continue=x" } }) : null)]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("private sheet (sign-in redirect): 400 with how to share it", res.status === 400 && res.data?.error === SHEET_MESSAGES.notShared && res.data?.code === "not_shared", res.data);
    check("private sheet: the sign-in page was never fetched", m.calls.every((c) => c.url.hostname !== "accounts.google.com"));
    eq("the message", SHEET_MESSAGES.notShared, "This sheet isn't shared. In Google Sheets choose Share, then Anyone with the link, Viewer. Or download it as a CSV and upload the file.");
  } finally {
    m.restore();
  }
  for (const status of [401, 403]) {
    m = mockFetch(GOOGLE, [() => new Response("denied", { status })]);
    try {
      const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
      check(`private sheet (${status}): 400 not_shared`, res.status === 400 && res.data?.code === "not_shared", res.data);
    } finally {
      m.restore();
    }
  }
  m = mockFetch(GOOGLE, [() => new Response("<html><body>Sign in</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("an HTML page instead of CSV: 400 not_shared", res.status === 400 && res.data?.code === "not_shared", res.data);
  } finally {
    m.restore();
  }

  // Not a Google Sheets link: refused before any request.
  m = mockFetch(() => true, [() => new Response("x")]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: "https://evil.example/sheet.csv" } });
    check("a non-Google URL: 400 bad_link, nothing fetched", res.status === 400 && res.data?.code === "bad_link" && m.calls.length === 0, { res: res.data, calls: m.calls.length });
    const empty = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: {} });
    check("no url: 400", empty.status === 400, empty.data);
  } finally {
    m.restore();
  }

  // A redirect off Google's hosts is never followed.
  m = mockFetch(GOOGLE, [(r) => (r.url.hostname === "docs.google.com" ? new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }) : new Response("secret"))]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("a redirect to another host: refused (502), and that host was never fetched", res.status === 502 && res.data?.code === "upstream" && !m.calls.some((c) => c.url.hostname === "evil.example"), res.data);
  } finally {
    m.restore();
  }
  m = mockFetch(GOOGLE, [(r) => (r.url.hostname === "docs.google.com" ? new Response(null, { status: 302, headers: { location: "http://doc-0s.googleusercontent.com/export" } }) : new Response("x"))]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("a redirect to plain http: refused", res.status === 502 && m.calls.length === 1, res.data);
  } finally {
    m.restore();
  }

  // The 5 MB cap: a stream that keeps going is cut off as soon as it passes the cap.
  let pulled = 0;
  m = mockFetch(GOOGLE, [
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled++;
            if (pulled > 200) return controller.close();
            controller.enqueue(new TextEncoder().encode("x,".repeat(32 * 1024)));
          },
        }),
        { status: 200, headers: { "content-type": "text/csv" } },
      ),
  ]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("over 5 MB: 400 too_large", res.status === 400 && res.data?.code === "too_large" && res.data?.error === SHEET_MESSAGES.tooLarge, res.data);
    check(`over 5 MB: reading stopped near the cap (${pulled} chunks of 64 KB)`, pulled < 100, pulled);
  } finally {
    m.restore();
  }
  m = mockFetch(GOOGLE, [() => new Response("a,b", { status: 200, headers: { "content-type": "text/csv", "content-length": String(6 * 1024 * 1024) } })]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("a declared size over 5 MB: refused before reading", res.status === 400 && res.data?.code === "too_large", res.data);
  } finally {
    m.restore();
  }
  m = mockFetch(GOOGLE, [() => new Response("gone", { status: 404 })]);
  try {
    const res = await callRoute(post, { method: "POST", path: "/api/import/sheet", body: { url: link } });
    check("404: not_found", res.status === 400 && res.data?.code === "not_found", res.data);
  } finally {
    m.restore();
  }

  // A sheet that never answers: the timeout (15 s on the route; short here).
  m = mockFetch(GOOGLE, [
    (_r, signal) =>
      new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "TimeoutError")));
      }),
  ]);
  // AbortSignal.timeout does not keep Node running on its own (a real socket would): hold it open.
  const keepAlive = setInterval(() => undefined, 1_000);
  try {
    const err = await downloadSheetCsv(link, { timeoutMs: 300 }).then(
      () => null,
      (e: unknown) => e,
    );
    check("a sheet that never answers: timeout (504)", err instanceof SheetError && err.code === "timeout" && err.status === 504, String(err));
  } finally {
    clearInterval(keepAlive);
    m.restore();
  }
}

// ------------------------------------------------------------------ 6. hubspot

async function testHubSpot(): Promise<void> {
  section("6. hubspot");
  eq(
    "LinkedIn properties: URL-like first, never bios, counts or company pages, text only",
    linkedinPropertyNames([
      { name: "linkedinbio", label: "LinkedIn Bio", type: "string" },
      { name: "linkedinconnections", label: "LinkedIn Connections", type: "number" },
      { name: "li_page", label: "LinkedIn Company Page", type: "string" },
      { name: "custom_li", label: "Their LinkedIn", type: "string" },
      { name: "linkedin_profile_link", label: "LinkedIn Profile", type: "string" },
      { name: "hs_linkedin_url", label: "LinkedIn URL", type: "string" },
      { name: "email", label: "Email", type: "string" },
    ]),
    ["hs_linkedin_url", "linkedin_profile_link", "custom_li"],
  );

  const get = asHandler(hubspotImportRoute.GET);
  setEnv({ HUBSPOT_ACCESS_TOKEN: undefined });
  const off = await callRoute(get, { path: "/api/import/hubspot" });
  check(
    "no token: 400 with how to add one",
    off.status === 400 && off.data?.code === "not_connected" && /crm\.objects\.contacts\.read/.test(String(off.data?.error)) && /HUBSPOT_ACCESS_TOKEN/.test(String(off.data?.error)) && /Vercel/.test(String(off.data?.error)),
    off.data,
  );
  const token = `test-${randomBytes(6).toString("hex")}`;
  setEnv({ HUBSPOT_ACCESS_TOKEN: token });
  check("a bad limit: 400", (await callRoute(get, { path: "/api/import/hubspot?limit=lots" })).status === 400);

  // An open Vercel deploy (no team password) never lists the CRM, with or without a token.
  {
    const open = mockFetch((host) => host === "api.hubapi.com", []);
    try {
      setEnv({ VERCEL: "1", ALLOW_OPEN_ACCESS: "1", APP_PASSWORD: undefined, SESSION_SECRET: undefined });
      const withToken = await callRoute(get, { path: "/api/import/hubspot?limit=2000" });
      setEnv({ HUBSPOT_ACCESS_TOKEN: undefined });
      const noToken = await callRoute(get, { path: "/api/import/hubspot" });
      check(
        "open deploy: 403 needs_password with or without a token, and HubSpot is not called",
        withToken.status === 403 && withToken.data?.code === "needs_password" && /APP_PASSWORD/.test(String(withToken.data?.error)) && noToken.status === 403 && noToken.data?.code === "needs_password" && open.calls.length === 0,
        { withToken: withToken.data, noToken: noToken.data, calls: open.calls.length },
      );
    } finally {
      open.restore();
      setEnv({ VERCEL: originalEnv.VERCEL, ALLOW_OPEN_ACCESS: originalEnv.ALLOW_OPEN_ACCESS, APP_PASSWORD: originalEnv.APP_PASSWORD, SESSION_SECRET: originalEnv.SESSION_SECRET, HUBSPOT_ACCESS_TOKEN: token });
    }
  }

  const contact = (i: number) => ({
    id: String(1000 + i),
    properties: {
      firstname: `First${i}`,
      lastname: `Last${i}`,
      email: i % 7 === 0 ? null : `p${i}@acme.com`,
      company: "Acme",
      jobtitle: "Engineer",
      hs_linkedin_url: i === 1 ? "https://www.linkedin.com/company/acme" : i === 2 ? "https://linkedin.com/in/First2-Last2/" : null,
      linkedin_profile_link: i === 1 ? "linkedin.com/in/first1" : null,
    },
  });
  const pages = (after: string | null, limit: number) => {
    const start = after ? Number(after) : 0;
    const end = Math.min(260, start + limit);
    const results = Array.from({ length: Math.max(0, end - start) }, (_, k) => contact(start + k));
    return { results, ...(end < 260 ? { paging: { next: { after: String(end), link: "x" } } } : {}) };
  };
  const HS = (host: string) => host === "api.hubapi.com";
  let m = mockFetch(HS, [
    (r) =>
      r.url.pathname === "/crm/properties/2026-09/contacts"
        ? jsonReply({
            results: [
              { name: "hs_linkedin_url", label: "LinkedIn URL", type: "string" },
              { name: "linkedin_profile_link", label: "LinkedIn Profile", type: "string" },
              { name: "linkedinbio", label: "LinkedIn Bio", type: "string" },
            ],
          })
        : null,
    (r) => (r.url.pathname === "/crm/objects/2026-09/contacts" ? jsonReply(pages(r.url.searchParams.get("after"), Number(r.url.searchParams.get("limit")))) : null),
  ]);
  try {
    const res = await callRoute(get, { path: "/api/import/hubspot?limit=250" });
    const rows = (res.data?.rows ?? []) as string[][];
    check("paging: 250 contacts over 3 pages", res.status === 200 && rows.length === 250 && res.data?.total === 250, { status: res.status, n: rows.length, err: res.data?.error });
    const lists = m.calls.filter((c) => c.url.pathname === "/crm/objects/2026-09/contacts");
    eq("paging: limit and after per page", lists.map((c) => `${c.url.searchParams.get("limit")}:${c.url.searchParams.get("after") ?? "-"}`), ["100:-", "100:100", "50:200"]);
    check("paging: more is true (HubSpot has 260)", res.data?.more === true);
    eq("headers with a HubSpot ID column", res.data?.headers, ["HubSpot ID", "First name", "Last name", "Email", "Company", "Job title", "LinkedIn URL"]);
    const props = lists[0]?.url.searchParams.get("properties")?.split(",") ?? [];
    check("asks for the name, email, company, title and the LinkedIn properties found", ["firstname", "lastname", "email", "company", "jobtitle", "hs_linkedin_url", "linkedin_profile_link"].every((p) => props.includes(p)) && !props.includes("linkedinbio"), props);
    eq("a row", rows[0], ["1000", "First0", "Last0", "", "Acme", "Engineer", ""]);
    eq("LinkedIn: a company page is skipped for the next property's profile link", rows[1]?.[6], "https://www.linkedin.com/in/first1");
    eq("LinkedIn: normalised", rows[2]?.[6], "https://www.linkedin.com/in/first2-last2");
    eq("linkedinProperties", res.data?.linkedinProperties, ["hs_linkedin_url", "linkedin_profile_link"]);
    check("every call carries the bearer token", m.calls.every((c) => c.headers.get("authorization") === `Bearer ${token}`));
    const mapping = guessMapping(res.data?.headers as string[]);
    eq("guessMapping maps every listed column", IMPORT_FIELDS.filter((f) => mapping[f] !== null), ["linkedinUrl", "firstName", "lastName", "company", "title", "email", "hubspotId"]);
  } finally {
    m.restore();
  }

  // Without the schema scope: the usual property names are tried, and a warning says so.
  m = mockFetch(HS, [
    (r) =>
      r.url.pathname === "/crm/properties/2026-09/contacts"
        ? jsonReply({ status: "error", message: "missing scopes", category: "MISSING_SCOPES", errors: [{ context: { requiredGranularScopes: ["crm.schemas.contacts.read"] } }] }, 403)
        : null,
    (r) => (r.url.pathname === "/crm/objects/2026-09/contacts" ? jsonReply({ results: [contact(2)] }) : null),
  ]);
  try {
    const res = await callRoute(get, { path: "/api/import/hubspot?limit=5000" });
    const props = m.calls.find((c) => c.url.pathname === "/crm/objects/2026-09/contacts")?.url.searchParams.get("properties") ?? "";
    check("no schema scope: still lists, with a warning naming the scope", res.status === 200 && (res.data?.rows as string[][]).length === 1 && (res.data?.warnings as string[]).some((w) => /crm\.schemas\.contacts\.read/.test(w)), res.data);
    check("no schema scope: hs_linkedin_url and the usual names are asked for", /hs_linkedin_url/.test(props) && /linkedin_url/.test(props), props);
    check("a limit over 2,000 is capped (first page of 100)", m.calls.find((c) => c.url.pathname === "/crm/objects/2026-09/contacts")?.url.searchParams.get("limit") === "100");
    check("more is false when HubSpot has no next page", res.data?.more === false);
  } finally {
    m.restore();
  }

  m = mockFetch(HS, [() => jsonReply({ status: "error", message: "Authentication credentials not found.", category: "INVALID_AUTHENTICATION" }, 401)]);
  try {
    const res = await callRoute(get, { path: "/api/import/hubspot" });
    check("a rejected token: 400 hubspot_access", res.status === 400 && res.data?.code === "hubspot_access" && /HUBSPOT_ACCESS_TOKEN/.test(String(res.data?.error)), res.data);
  } finally {
    m.restore();
  }
  setEnv({ HUBSPOT_ACCESS_TOKEN: originalEnv.HUBSPOT_ACCESS_TOKEN });
}

// ------------------------------------------------------------------ 7. import (Neon)

type Dup = { index: number; existingId: string | null; reason: string; match: string; duplicateOf: number | null };

async function testImport(): Promise<void> {
  section("7. import (Neon)");
  const post = asHandler(importRoute.POST);
  const send = (body: unknown, headers?: Record<string, string>) => callRoute(post, { method: "POST", path: "/api/leads/import", body, headers });
  const noteIds = (res: CallResult) => ((res.data?.createdIds ?? []) as string[]).forEach((id) => tempLeadIds.add(id));

  check("no rows: 400", (await send({ source: "csv", rows: [] })).status === 400);
  check("bad source: 400", (await send({ source: "excel", rows: [{ name: "a", company: "b" }] })).status === 400);
  const many = await send({ source: "csv", rows: Array.from({ length: 1001 }, () => ({ name: "a", company: "b" })) });
  check("1,001 rows: 400 that says send at most 1,000", many.status === 400 && /1,000/.test(String(many.data?.error)), many.data);
  const plain = await callRoute(post, { method: "POST", path: "/api/leads/import", rawBody: JSON.stringify({ source: "csv", rows: [{ name: "a", company: "b" }] }), headers: { "content-type": "text/plain" } });
  check("a text/plain body: 415", plain.status === 415, plain.data);
  const huge = await callRoute(post, { method: "POST", path: "/api/leads/import", rawBody: JSON.stringify({ source: "csv", rows: [{ notes: "x".repeat(4.5 * 1024 * 1024) }] }) });
  check("a body over 4 MB: 413", huge.status === 413, huge.data);

  // An existing lead to collide with.
  const existing = await tempLead({ name: `Existing ${RUN}`, email: `existing.${RUN}@example.com`, emailStatus: "manual" });
  const slug = (s: string) => `https://www.linkedin.com/in/le-imp-${RUN}-${s}`;
  const rows = [
    { linkedinUrl: slug("a"), name: "Imp A" },
    { name: `Imp B ${RUN}`, company: "Acme", email: `IMP.B.${RUN}@Example.com`, title: "CTO" },
    { name: "Imp C", email: `imp.c.${RUN}@example.com` },
    { name: "Only Name" },
    { linkedinUrl: "https://www.linkedin.com/company/acme", name: "X", company: "Y" },
    { name: "Bad Email", company: "Acme", email: "not-an-email" },
    { linkedinUrl: existing.linkedinUrl!.toUpperCase().replace("HTTPS://WWW.LINKEDIN.COM", "linkedin.com"), name: "Existing by URL" },
    { name: "Existing by email", company: "Z", email: `EXISTING.${RUN}@EXAMPLE.COM` },
    { name: "Imp B again", company: "Other", email: `imp.b.${RUN}@example.com` },
    { hubspotId: `9${parseInt(RUN, 16)}`, name: "HS Person", company: "Acme", notes: "From HubSpot\nline two" },
    { hubspotId: `9${parseInt(RUN, 16)}.0`, name: "HS Person 2", company: "Acme 2" },
    { linkedinUrl: "N/A", name: "Placeholder Url", company: "Acme" },
    {},
  ];
  const tasksBefore = afterTasks.length;
  const res = await send({ source: "csv", rows });
  noteIds(res);
  const created = (res.data?.createdRows ?? []) as Array<{ index: number; id: string }>;
  const dups = (res.data?.duplicates ?? []) as Dup[];
  const skipped = (res.data?.skipped ?? []) as Array<{ index: number; reason: string }>;
  check("import: 200, 5 created", res.status === 200 && res.data?.created === 5, res.data);
  eq("import: created rows", created.map((c) => c.index), [0, 1, 2, 9, 11]);
  check("import: createdIds match createdRows", JSON.stringify(res.data?.createdIds) === JSON.stringify(created.map((c) => c.id)));
  eq("import: skipped with reasons", skipped, [
    { index: 3, reason: SKIP_REASONS.notEnough },
    { index: 4, reason: SKIP_REASONS.badLinkedin },
    { index: 5, reason: SKIP_REASONS.badEmail },
    { index: 12, reason: SKIP_REASONS.notEnough },
  ]);
  const idOf = (index: number) => created.find((c) => c.index === index)?.id ?? null;
  eq("import: duplicates (existing lead by profile and by email; repeats point at the lead made for the earlier row)", dups, [
    { index: 6, existingId: existing.id, reason: "Already a lead with this LinkedIn profile.", match: "linkedin", duplicateOf: null },
    { index: 7, existingId: existing.id, reason: "Already a lead with this email.", match: "email", duplicateOf: null },
    { index: 8, existingId: idOf(1), reason: "Same email as an earlier row in this import.", match: "email", duplicateOf: 1 },
    { index: 10, existingId: idOf(9), reason: "Same HubSpot contact as an earlier row in this import.", match: "hubspot", duplicateOf: 9 },
  ]);
  check("import: no research started (nothing handed to after())", afterTasks.length === tasksBefore);

  const a = await getLead(idOf(0)!);
  const b = await getLead(idOf(1)!);
  const hs = await getLead(idOf(9)!);
  const ph = await getLead(idOf(11)!);
  check("lead A: URL normalised with its slug, source csv, idle", a?.linkedinUrl === slug("a") && a?.linkedinSlug === `le-imp-${RUN}-a` && a?.source === "csv" && a?.researchStatus === "idle" && a?.stage === "new", a);
  check("lead B: no LinkedIn URL, email lower case and imported, title kept", b?.linkedinUrl === null && b?.linkedinSlug === null && b?.email === `imp.b.${RUN}@example.com` && b?.emailStatus === "imported" && b?.title === "CTO" && b?.companyName === "Acme", b);
  check("HubSpot lead: contact id and notes", hs?.hubspotContactId === `9${parseInt(RUN, 16)}` && hs?.notes === "From HubSpot\nline two" && hs?.emailStatus === null, hs);
  check("a placeholder URL is no URL", ph?.linkedinUrl === null && ph?.name === "Placeholder Url");
  const events = await listEvents(idOf(1)!);
  check("one created event: Imported from a CSV file", events.length === 1 && events[0].type === "created" && events[0].message === "Imported from a CSV file" && (events[0].data as { source?: string })?.source === "csv", events);

  const again = await send({ source: "csv", rows });
  noteIds(again);
  check("the same import again: nothing created, all duplicates", again.status === 200 && again.data?.created === 0 && (again.data?.duplicates as Dup[]).length === 9, again.data);

  // A row with only a name and company is still found after research renamed the lead (the
  // profile's full name, the company's own name): the import kept what the file said.
  {
    const row = { name: `Rena Med ${RUN}`, company: "Acme" };
    const first = await send({ source: "sheet", rows: [row] });
    noteIds(first);
    const renamedId = (first.data?.createdIds as string[] | undefined)?.[0];
    if (renamedId) await updateLead(renamedId, { name: `Rena Q. Med ${RUN}`, companyName: "Acme Robotics Inc." });
    const second = await send({ source: "sheet", rows: [row] });
    noteIds(second);
    const dup = (second.data?.duplicates as Dup[] | undefined)?.[0];
    check("re-import after a rename: matched on the imported name and company, nothing created", Boolean(renamedId) && second.data?.created === 0 && dup?.existingId === renamedId && dup?.match === "name", second.data);
  }

  for (const source of ["sheet", "hubspot"] as const) {
    const r = await send({ source, rows: [{ name: `${source} person ${RUN}`, company: "Acme" }] });
    noteIds(r);
    const id = (r.data?.createdIds as string[])?.[0];
    const ev = id ? await listEvents(id) : [];
    check(`source ${source}: "${IMPORT_EVENT_MESSAGES[source]}"`, r.status === 200 && ev[0]?.message === IMPORT_EVENT_MESSAGES[source] && (await getLead(id!))?.source === source, ev);
  }

  // The daily cap, counted across the app.
  setEnv({ IMPORT_LIMIT_PER_DAY: undefined });
  check("import limit default 2,000", DEFAULT_IMPORTS_PER_DAY === 2000 && quotaLimit("import") === 2000);
  setEnv({ IMPORT_LIMIT_PER_DAY: "abc" });
  check("a bad limit falls back to the default", quotaLimit("import") === 2000);
  let used = await quotaUsed("import");
  setEnv({ IMPORT_LIMIT_PER_DAY: String(used + 2) });
  const three = [1, 2, 3].map((i) => ({ name: `Cap ${RUN} ${i}`, company: "Cap Co" }));
  const over = await send({ source: "csv", rows: three });
  check("cap: 3 new leads with room for 2: 429, nothing added", over.status === 429 && over.data?.remaining === 2 && over.data?.wanted === 3 && over.data?.limit === used + 2, over.data);
  eq("cap: the message", over.data?.error, importLimitMessage({ limit: used + 2, used, wanted: 3 }));
  const capNames = await query("select id from le_leads where name like $1", [`Cap ${RUN} %`]);
  check("cap: no lead was written", capNames.length === 0, capNames.length);
  const dupOnly = await send({ source: "csv", rows: [rows[0], rows[1]] });
  check("cap: a batch of duplicates only is still answered (200)", dupOnly.status === 200 && dupOnly.data?.created === 0, dupOnly.data);
  const fits = await send({ source: "csv", rows: three.slice(0, 2) });
  noteIds(fits);
  check("cap: 2 fit: 200, 2 created", fits.status === 200 && fits.data?.created === 2, fits.data);
  const full = await send({ source: "csv", rows: [three[2]] });
  check("cap: now full: 429 that says the limit was reached", full.status === 429 && /has been reached/.test(String(full.data?.error)), full.data);

  // A burst: two imports of 2 at once with room for 3: exactly one goes through.
  used = await quotaUsed("import");
  setEnv({ IMPORT_LIMIT_PER_DAY: String(used + 3) });
  const burst = await Promise.all(
    ["x", "y"].map((k) => send({ source: "csv", rows: [1, 2].map((i) => ({ name: `Burst ${RUN} ${k}${i}`, company: "Burst Co" })) })),
  );
  burst.forEach(noteIds);
  check("cap: a burst of 2 + 2 with room for 3: one 200, one 429", burst.map((r) => r.status).sort().join() === "200,429", burst.map((r) => r.status));
  const burstRows = await query("select id from le_leads where name like $1", [`Burst ${RUN} %`]);
  check("cap: exactly 2 burst leads exist", burstRows.length === 2, burstRows.length);

  setEnv({ IMPORT_LIMIT_PER_DAY: "0" });
  const paused = await send({ source: "csv", rows: [{ name: `Paused ${RUN}`, company: "P" }] });
  check("cap: a limit of 0 pauses imports", paused.status === 429 && /paused/.test(String(paused.data?.error)), paused.data);
  setEnv({ IMPORT_LIMIT_PER_DAY: originalEnv.IMPORT_LIMIT_PER_DAY });
}

// ------------------------------------------------------------------ 8. linkedin (identify without a URL)

function exaPerson(url: string, name: string, roles: Array<[title: string, company: string, current: boolean]>) {
  return {
    url,
    title: name,
    text: `# ${name}\n\n${roles[0]?.[0] ?? ""} at ${roles[0]?.[1] ?? ""}\n\nSan Francisco Bay Area`,
    highlights: [],
    entities: [
      {
        type: "person",
        properties: {
          name,
          location: "San Francisco Bay Area",
          workHistory: roles.map(([title, company, current]) => ({ title, company: { name: company }, dates: { from: "2024-01", to: current ? null : "2025-01" } })),
        },
      },
    ],
  };
}

async function testLinkedinSearch(): Promise<void> {
  section("8. research without a LinkedIn URL (mocked Exa)");
  // LinkedIn, Apollo and Hunter off for this section: only the (mocked) web search runs.
  setEnv({ UNIPILE_API_KEY: undefined, UNIPILE_DSN: undefined, UNIPILE_ACCOUNT_ID: undefined, APIFY_TOKEN: undefined, APOLLO_API_KEY: undefined, HUNTER_API_KEY: undefined });
  if (!process.env.EXA_API_KEY) setEnv({ EXA_API_KEY: `test-${randomBytes(6).toString("hex")}` });
  // A run's budget (identify keeps 150 s back for the later steps).
  const deadline = () => new Deadline(280_000);
  const slugFor = (s: string) => `le-li-${RUN}-${s}`;
  const EXA = (host: string) => host === "api.exa.ai";

  const mara = await tempLead({ linkedinUrl: null, name: "Mara Lindqvist", companyName: "Tallow Robotics" });
  let searches: Array<{ query: string; category?: string; includeDomains?: string[] }> = [];
  let m = mockFetch(EXA, [
    (r) => {
      const body = JSON.parse(r.body ?? "{}") as { query: string; category?: string; includeDomains?: string[] };
      searches.push(body);
      return jsonReply({
        results: [
          exaPerson(`https://www.linkedin.com/in/${slugFor("namesake")}`, "Mara Lindqvist", [["Nurse", "Karolinska Hospital", true]]),
          exaPerson(`https://linkedin.com/in/${slugFor("mara")}`, "Mara Lindqvist, PhD", [["Head of Robot Learning", "Tallow Robotics", true]]),
        ],
        costDollars: { total: 0.007 },
      });
    },
  ]);
  try {
    const ctx = await identify(mara.id, mara, DEFAULT_SETTINGS, deadline());
    const saved = await getLead(mara.id);
    check("found: the matching profile (not the namesake) is saved, with its slug", saved?.linkedinUrl === `https://www.linkedin.com/in/${slugFor("mara")}` && saved?.linkedinSlug === slugFor("mara"), saved);
    check("found: the run goes on with it", ctx.person.linkedinUrl === saved?.linkedinUrl && ctx.lead.linkedinUrl === saved?.linkedinUrl);
    const profileSearches = searches.filter((q) => q.category === "people" || q.includeDomains);
    check("found: one people search was enough", profileSearches.length === 1 && profileSearches[0].category === "people" && /Mara Lindqvist Tallow Robotics/.test(profileSearches[0].query), searches);
    const events = await listEvents(mara.id);
    check("found: logged as Found their LinkedIn by search", events.some((e) => e.message === `Found their LinkedIn by search: https://www.linkedin.com/in/${slugFor("mara")}`), events.map((e) => e.message));
  } finally {
    m.restore();
  }

  // Nothing matches: two searches, then the run ends with the message.
  const nobody = await tempLead({ linkedinUrl: null, name: "Quentin Nobody", companyName: "Nowhere Labs", email: `quentin@nowherelabs-${RUN}.com` });
  searches = [];
  m = mockFetch(EXA, [
    (r) => {
      searches.push(JSON.parse(r.body ?? "{}"));
      return jsonReply({ results: [exaPerson(`https://www.linkedin.com/in/${slugFor("other")}`, "Quentin Somebody", [["CEO", "Nowhere Labs", true]])] });
    },
  ]);
  try {
    const err = await identify(nobody.id, nobody, DEFAULT_SETTINGS, deadline()).then(() => null, (e: unknown) => e);
    check("not found: stops with the message", err instanceof ResearchStop && err.message === PROFILE_NOT_FOUND, String(err));
    check("not found: two searches, the second limited to linkedin.com/in with the email domain", searches.length === 2 && JSON.stringify(searches[1].includeDomains) === JSON.stringify(["linkedin.com/in"]) && searches[1].query.includes(`nowherelabs-${RUN}.com`), searches);
    check("not found: no URL saved", (await getLead(nobody.id))?.linkedinUrl === null);

    // The whole run: research ends as an error with exactly that message, before any Claude call.
    await query("update le_leads set research_status = 'running', research_started_at = now(), stage = 'researching' where id = $1", [nobody.id]);
    await runResearch(nobody.id);
    const after = await getLead(nobody.id);
    const last = (await listEvents(nobody.id, 5))[0];
    check("runResearch: status error, the message as the error", after?.researchStatus === "error" && after.researchError === PROFILE_NOT_FOUND && after.stage === "new", after && { s: after.researchStatus, e: after.researchError, st: after.stage });
    check("runResearch: the last event is that message, with no prefix", last?.type === "error" && last.message === PROFILE_NOT_FOUND, last);
  } finally {
    m.restore();
  }

  // The profile found belongs to another lead: stop and name it.
  const owner = await tempLead({ linkedinUrl: `https://www.linkedin.com/in/${slugFor("taken")}`, name: "Already Here" });
  const twin = await tempLead({ linkedinUrl: null, name: "Ada Lovelace", companyName: "Engine Co" });
  m = mockFetch(EXA, [() => jsonReply({ results: [exaPerson(`https://www.linkedin.com/in/${slugFor("taken")}`, "Ada Lovelace", [["CTO", "Engine Co", true]])] })]);
  try {
    const err = await identify(twin.id, twin, DEFAULT_SETTINGS, deadline()).then(() => null, (e: unknown) => e);
    check("taken: stops with a message naming the other lead", err instanceof ResearchStop && /another lead already has that profile: Already Here/.test(err.message), String(err));
    check("taken: nothing saved on either lead", (await getLead(twin.id))?.linkedinUrl === null && (await getLead(owner.id))?.linkedinUrl === `https://www.linkedin.com/in/${slugFor("taken")}`);
  } finally {
    m.restore();
  }

  const nameless = await tempLead({ linkedinUrl: null, name: "Solo" });
  const err = await identify(nameless.id, nameless, DEFAULT_SETTINGS, deadline()).then(() => null, (e: unknown) => e);
  check("a name with no company or work email: stops without searching", err instanceof ResearchStop && /name alone/.test(err.message), String(err));
  restoreEnv();
  setEnv({ USAGE_LEDGER_DISABLED: "1" });
}

// ------------------------------------------------------------------ 9. email route (Neon)

async function testEmailRoute(): Promise<void> {
  section("9. email lookup route (Neon, mocked Hunter)");
  const post = asHandler(emailRoute.POST);
  const lookup = (id: string) => callRoute(post, { method: "POST", path: `/api/leads/${id}/email`, id });
  setEnv({ HUNTER_API_KEY: `test-${randomBytes(6).toString("hex")}`, HUNTER_CREDITS_PER_DAY: "100000" });

  const lead = await tempLead({ name: "Jane Doe", companyName: "Mecka", companyDomain: "mecka.ai" });
  let m = hunterMock({ domain: DOMAIN("{first}", true) });
  try {
    const res = await lookup(lead.id);
    const saved = await getLead(lead.id);
    check("guess: 200 with the address, its kind and 50", res.status === 200 && res.data?.email === "jane@mecka.ai" && res.data?.emailStatus === "guess" && res.data?.emailConfidence === 50, res.data);
    check("guess: saved on the lead", saved?.email === "jane@mecka.ai" && saved?.emailStatus === "guess" && saved?.emailConfidence === 50, saved);
    check("guess: the message says it is a best guess, and the credits", /best guess/.test(String(res.data?.message)) && res.data?.creditsUsed === 1, res.data);
    const ev = (await listEvents(lead.id)).find((e) => e.type === "tool" && /^Email lookup: jane@mecka\.ai/.test(e.message));
    check("guess: logged on the lead", Boolean(ev), ev);
  } finally {
    m.restore();
  }

  // A second lookup may replace an address a lookup found (a guess becomes verified).
  m = hunterMock({ domain: DOMAIN("{first}", false), verifier: [{ status: 200, body: { data: { status: "valid", score: 93 } } }] });
  try {
    const res = await lookup(lead.id);
    check("verified: replaces the earlier guess", res.status === 200 && res.data?.emailStatus === "verified" && res.data?.emailConfidence === 93 && (await getLead(lead.id))?.emailStatus === "verified", res.data);
  } finally {
    m.restore();
  }

  // Nothing found: 200 with email null and why; the earlier address stays.
  m = hunterMock({ domain: { data: { pattern: null, accept_all: false, emails: [] } } });
  try {
    const res = await lookup(lead.id);
    check("nothing found: 200, email null, the reason, the earlier address kept", res.status === 200 && res.data?.email === null && /does not know the email pattern/.test(String(res.data?.message)) && /found earlier is kept/.test(String(res.data?.message)) && (await getLead(lead.id))?.email === "jane@mecka.ai", res.data);
  } finally {
    m.restore();
  }

  // An address the team typed in is never replaced, and Hunter is not called.
  const manual = await tempLead({ name: "Rick Roe", companyName: "Roe", companyDomain: "roe.io", email: "rick@roe.io", emailStatus: "manual" });
  m = hunterMock({});
  try {
    const res = await lookup(manual.id);
    check("manual address: 409, nothing called", res.status === 409 && res.data?.code === "email_given" && m.calls.length === 0, res.data);
    const imported = await tempLead({ name: "Ima Port", companyName: "Port", companyDomain: "port.io", email: "ima@port.io", emailStatus: "imported" });
    check("imported address: 409", (await lookup(imported.id)).status === 409);
    const running = await tempLead({ name: "Run Ning", companyName: "Run", companyDomain: "run.io" });
    await query("update le_leads set research_status = 'running', research_started_at = now() where id = $1", [running.id]);
    check("while research runs: 409", (await lookup(running.id)).status === 409);
    const bare = await tempLead({ linkedinUrl: null, name: null });
    const r = await lookup(bare.id);
    check("nothing to look up with: 400", r.status === 400 && r.data?.code === "not_enough", r.data);
    check("unknown lead: 404", (await lookup("00000000-0000-4000-8000-000000000000")).status === 404);
    check("none of these called Hunter", m.calls.length === 0, m.calls.length);
  } finally {
    m.restore();
  }

  // The day's Hunter credit budget across the app, counted in half-credits.
  setEnv({ HUNTER_CREDITS_PER_DAY: undefined });
  check("Hunter budget default 10 credits (20 half-credits)", DEFAULT_HUNTER_CREDITS_PER_DAY === 10 && quotaLimit("email_lookup") === 20);
  check("credits round up to half-credits", creditUnits(1.5) === 3 && creditUnits(1) === 2 && creditUnits(0.5) === 1 && creditUnits(0.2) === 1 && creditUnits(0) === 0 && creditUnits(null) === 0);
  check("a lookup reserves at most 1.5 credits", LOOKUP_MAX_UNITS === 3);
  setEnv({ HUNTER_CREDITS_PER_DAY: "100000" });
  const capLead = await tempLead({ name: "Cap Lookup", companyName: "Mecka", companyDomain: "mecka.ai" });
  m = hunterMock({ domain: DOMAIN("{first}.{last}", true) });
  try {
    const first = await lookup(capLead.id);
    check("budget: the first lookup runs", first.status === 200 && first.data?.email === "cap.lookup@mecka.ai", first.data);
    const rows = await query<{ units: number }>("select units from le_quota_uses where kind = 'email_lookup' and lead_id = $1", [capLead.id]);
    check("budget: the slot is settled to the credits Hunter charged (1 credit, 2 half-credits)", first.data?.creditsUsed === 1 && rows.length === 1 && Number(rows[0].units) === 2, { rows, creditsUsed: first.data?.creditsUsed });
    // Leave less than one lookup's worst case in the budget.
    const used = await quotaUsed("email_lookup");
    setEnv({ HUNTER_CREDITS_PER_DAY: String(Math.floor((used + LOOKUP_MAX_UNITS - 1) / 2)) });
    const before = m.calls.length;
    const second = await lookup(capLead.id);
    check("budget: the next is 429 with the message, and Hunter is not called", second.status === 429 && second.data?.code === "hunter_budget" && second.data?.error === emailLookupLimitMessage(quotaLimit("email_lookup")) && /credits a day is used up/.test(String(second.data?.error)) && m.calls.length === before, { s: second.data, calls: m.calls.length - before });
  } finally {
    m.restore();
  }
  // A lookup that finds nothing costs nothing, and its slot is given back.
  setEnv({ HUNTER_CREDITS_PER_DAY: "100000" });
  const freeLead = await tempLead({ name: "Free Lookup", companyName: "Nowhere" });
  m = hunterMock({});
  try {
    const res = await lookup(freeLead.id);
    const rows = await query("select id from le_quota_uses where lead_id = $1", [freeLead.id]);
    check("budget: nothing found and no credits: the slot is released", res.status === 200 && res.data?.email === null && res.data?.creditsUsed === 0 && rows.length === 0, { d: res.data, rows: rows.length });
  } finally {
    m.restore();
  }
  setEnv({ HUNTER_CREDITS_PER_DAY: "0" });
  const pausedRes = await lookup(capLead.id);
  check("budget: 0 pauses lookups", pausedRes.status === 429 && /paused/.test(String(pausedRes.data?.error)), pausedRes.data);

  setEnv({ HUNTER_API_KEY: undefined, HUNTER_CREDITS_PER_DAY: "100000" });
  const off = await lookup(capLead.id);
  check("Hunter not configured: 400", off.status === 400 && off.data?.code === "not_configured", off.data);
  setEnv({ HUNTER_API_KEY: originalEnv.HUNTER_API_KEY, HUNTER_CREDITS_PER_DAY: originalEnv.HUNTER_CREDITS_PER_DAY });
}

// ------------------------------------------------------------------ main

async function cleanup(): Promise<void> {
  if (!tempLeadIds.size) return;
  const ids = [...tempLeadIds];
  try {
    const quota = await query("delete from le_quota_uses where lead_id = any($1::uuid[]) returning id", [ids]);
    const runs = await query("delete from le_run_starts where lead_id = any($1::uuid[]) returning id", [ids]);
    const usage = await query("delete from le_usage where lead_id = any($1::uuid[]) returning id", [ids]);
    let leads = 0;
    for (const id of ids) if (await deleteLead(id).catch(() => false)) leads++;
    console.log(`\n  (removed ${leads} temp leads with their events, ${quota.length} quota rows, ${runs.length} run slots, ${usage.length} usage rows)`);
  } catch (err) {
    check("clean up the temp rows", false, err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  process.env.USAGE_LEDGER_DISABLED = "1";
  try {
    testCsv();
    testColumns();
    testPrepare();
    await testHunter();
    await testSheet();
    await testHubSpot();
    if (!UNIT_ONLY) {
      await testImport();
      await testLinkedinSearch();
      await testEmailRoute();
    }
  } finally {
    globalThis.fetch = realFetch;
    restoreEnv();
    await cleanup();
  }
  console.log(`\n${passed} passed, ${failed} failed in ${((Date.now() - started) / 1000).toFixed(1)} s${UNIT_ONLY ? " (unit only)" : ""}`);
  if (failed) process.exit(1);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  globalThis.fetch = realFetch;
  await cleanup();
  process.exit(1);
});
