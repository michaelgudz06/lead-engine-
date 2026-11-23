/**
 * Test for the Apollo and Hunter providers: offline fixtures first, then live calls.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-apollo-hunter.ts
 *
 * Offline (free): input handling, plus request building and response parsing against recorded
 * response shapes with fetch stubbed out.
 * Live Apollo (free plan), on by default: two org enrichments, one job postings page, and person
 * match, which the free plan blocks (expected: planBlocked, no error). About 3 Apollo credits.
 * APOLLO_EXTRA=1 adds: enrich by LinkedIn company URL, an unknown domain, getHiring, a bad key.
 * Live Hunter costs credits (free plan: 50 a month), so it runs only with HUNTER_LIVE=1, and a
 * fetch guard refuses any Hunter request beyond HUNTER_MAX_CALLS (default 2, never more than 3).
 *
 * Prints statuses and short snippets only: never keys, headers or full email addresses.
 */
import {
  apolloOrgSummary,
  apolloStatus,
  companyDomain,
  enrichOrganization,
  formatGrowth,
  formatUsd,
  getHiring,
  getJobPostings,
  matchPerson,
  type ApolloOrg,
} from "../src/lib/providers/apollo";
import { findEmail, hunterStatus } from "../src/lib/providers/hunter";

const HUNTER_LIVE = process.env.HUNTER_LIVE === "1";
const APOLLO_EXTRA = process.env.APOLLO_EXTRA === "1";
const HUNTER_MAX_CALLS = Math.max(1, Math.min(3, Number(process.env.HUNTER_MAX_CALLS ?? 2) || 2));

// ---- fetch guard: counts real requests per host and enforces the Hunter budget ---------------
const realFetch = globalThis.fetch;
const calls = new Map<string, number>();
const countingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(hrefOf(input)).host;
  const n = (calls.get(host) ?? 0) + 1;
  if (host === "api.hunter.io" && (!HUNTER_LIVE || n > HUNTER_MAX_CALLS)) {
    throw new Error(`test guard: refused Hunter request #${n} (HUNTER_LIVE=${HUNTER_LIVE}, max ${HUNTER_MAX_CALLS})`);
  }
  calls.set(host, n);
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = countingFetch;
const count = (host: string) => calls.get(host) ?? 0;
const totalCalls = () => [...calls.values()].reduce((a, b) => a + b, 0);

function hrefOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

interface Seen {
  url: URL;
  method: string;
  hasKeyHeader: boolean;
}
/** Runs fn with fetch replaced by a stub that answers from `reply`. No network. */
async function withStub<T>(reply: (url: URL) => { status: number; body: unknown }, fn: (seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(hrefOf(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, method: init?.method ?? "GET", hasKeyHeader: Object.keys(headers).some((k) => k.toLowerCase() === "x-api-key") });
    const { status, body } = reply(url);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = countingFetch;
  }
}

// ---- tiny assertion helpers ------------------------------------------------------------------
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function section(title: string): void {
  console.log(`\n== ${title}`);
}
/** "brett@figure.ai" -> "b***@figure.ai": proves a hit without printing the address. */
function maskEmail(email: string | null): string {
  if (!email) return "none";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
function printOrg(org: ApolloOrg): void {
  const s = apolloOrgSummary(org);
  console.log(`      ${org.name} | ${org.domain} | id ${org.id} | ${org.industry ?? "-"} | ${org.city ?? "-"}, ${org.country ?? "-"} | founded ${org.foundedYear ?? "-"}`);
  console.log(`      linkedin ${org.linkedinUrl ?? "-"} | website ${org.website ?? "-"}`);
  console.log(`      ${s.headcount ?? "no headcount"} | ${s.growth ?? "no growth data"}`);
  console.log(`      ${s.funding ?? "no funding data"}`);
  console.log(`      ${s.teams ?? "no department data"}`);
  console.log(`      tech (${org.technologies.length}): ${org.technologies.slice(0, 8).join(", ")}`);
  console.log(`      keywords (${org.keywords.length}): ${org.keywords.slice(0, 6).join(", ")}`);
  console.log(`      about: ${(org.description ?? "-").slice(0, 140)}`);
}

async function offlineChecks(): Promise<void> {
  section("Input handling (no network)");
  const domainCases: Array<[string, string | null]> = [
    ["https://www.Figure.ai/careers?x=1", "figure.ai"],
    ["www.allenai.org", "allenai.org"],
    ["jane.doe@allenai.org", "allenai.org"],
    ["@abstract.inc", "abstract.inc"],
    ["jane@gmail.com", null],
    ["gmail.com", null],
    ["jane@yahoo.com", null],
    ["yahoo.com", "yahoo.com"],
    ["https://www.linkedin.com/in/someone", null],
    ["Figure AI", null],
    ["localhost", null],
    ["10.0.0.1", null],
  ];
  for (const [input, want] of domainCases) {
    const got = companyDomain(input);
    check(`companyDomain(${JSON.stringify(input)})`, got === want, `got ${got}`);
  }
  check("formatGrowth", formatGrowth(0.4517) === "+45%" && formatGrowth(0.045) === "+4.5%" && formatGrowth(-0.1) === "-10%" && formatGrowth(-0.0001) === "0%");
  check("formatUsd", formatUsd(1_915_000_000) === "$1.9B" && formatUsd(13_000_000) === "$13M" && formatUsd(250_000) === "$250K");

  const before = totalCalls();
  const badDomain = await enrichOrganization("not a domain");
  check("enrich rejects junk", !badDomain.org && !!badDomain.error, badDomain.error);
  const personal = await enrichOrganization("jane@gmail.com");
  check("enrich rejects a personal email address", !personal.org && !!personal.error, personal.error);
  const badJobs = await getJobPostings("");
  check("getJobPostings rejects an empty id", badJobs.jobs.length === 0 && !!badJobs.error, badJobs.error);
  const emptyMatch = await matchPerson({});
  check("matchPerson needs identifiers", !emptyMatch.person && !emptyMatch.planBlocked && !!emptyMatch.error, emptyMatch.error);
  const emptyEmail = await findEmail({});
  check("findEmail needs identifiers", !emptyEmail.email && !!emptyEmail.error, emptyEmail.error);
  const nameOnly = await findEmail({ fullName: "Jane Doe" });
  check("findEmail: a name alone is not enough", !nameOnly.email && !!nameOnly.error);
  const oneWord = await findEmail({ fullName: "Madonna", domain: "example.com" });
  check("findEmail: a one-word name without a handle is not enough", !oneWord.email && !!oneWord.error);
  const badHandle = await findEmail({ linkedinUrl: "https://www.linkedin.com/in/%E0%A4%A" });
  check("findEmail: a malformed handle is dropped", !badHandle.email && !!badHandle.error);
  check("invalid inputs made no request", totalCalls() === before, `${totalCalls() - before} requests`);

  section("Request building and parsing (fetch stubbed, recorded response shapes)");
  const hunterKey = process.env.HUNTER_API_KEY ?? "";
  const apolloKey = process.env.APOLLO_API_KEY ?? "";

  // Hunter: what goes on the wire.
  await withStub(
    () => ({
      status: 200,
      body: {
        data: {
          first_name: "Brett", last_name: "Adcock", email: "Brett@Figure.ai", score: 97.4, domain: "figure.ai",
          sources: [{ domain: "figure.ai", uri: "https://figure.ai/news", extracted_on: "2026-01-01" }, { uri: "not a url" }, { uri: "https://figure.ai/news" }],
          verification: { date: "2026-11-01", status: "valid" },
        },
        meta: { params: {} },
      },
    }),
    async (seen) => {
      const r = await findEmail({ linkedinUrl: "https://www.linkedin.com/in/BrettAdcock/?trk=x", fullName: "Brett Adcock", domain: "https://www.figure.ai", company: "Figure" });
      const q = seen[0]?.url.searchParams;
      check("hunter: one request with handle, domain, first and last name", seen.length === 1 && q?.get("linkedin_handle") === "brettadcock" && q?.get("domain") === "figure.ai" && q?.get("first_name") === "Brett" && q?.get("last_name") === "Adcock" && !q?.has("company") && q?.get("max_duration") === "10", seen[0]?.url.search.replace(/=[^&]*/g, "=…"));
      check("hunter: key in X-API-KEY header, not in the URL", !!seen[0]?.hasKeyHeader && !!hunterKey && !seen[0].url.href.includes(hunterKey) && !seen[0].url.searchParams.has("api_key"));
      check("hunter: response mapped", r.email === "brett@figure.ai" && r.score === 97 && r.status === "valid" && r.sources.length === 1 && !r.error, JSON.stringify({ ...r, email: maskEmail(r.email) }));
    },
  );
  await withStub(
    () => ({ status: 200, body: { data: { first_name: "María", email: null, score: null, sources: [] } } }),
    async (seen) => {
      const r = await findEmail({ fullName: "Dr. María José García López, PhD 🤖 | Robotics", company: "  Acme   Robotics " });
      const q = seen[0]?.url.searchParams;
      check("hunter: cleaned full name and company name", q?.get("full_name") === "María José García López" && q?.get("company") === "Acme Robotics" && !q?.has("domain"), `full_name=${q?.get("full_name")}`);
      check("hunter: no email found is not an error", r.email === null && r.score === null && !r.error);
      await findEmail({ fullName: "Prof. Ali Farhadi (he/him)", domain: "allenai.org", linkedinUrl: "https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa-123/" });
      const q2 = seen[1]?.url.searchParams;
      check("hunter: two-word name split, accented handle decoded", q2?.get("first_name") === "Ali" && q2?.get("last_name") === "Farhadi" && q2?.get("linkedin_handle") === "josé-garcía-123", `handle=${q2?.get("linkedin_handle")}`);
    },
  );
  await withStub(
    () => ({ status: 400, body: { errors: [{ id: "invalid_domain", code: 400, details: "The domain is invalid or has no MX record" }] } }),
    async () => {
      const r = await findEmail({ fullName: "Jane Doe", domain: "acme-robotics.example" });
      check("hunter: 400 explained", !r.email && /invalid_domain/.test(r.error ?? "") && /MX/.test(r.error ?? ""), r.error);
    },
  );
  await withStub(
    () => ({ status: 451, body: { errors: [{ id: "claimed_email", code: 451, details: "claimed" }] } }),
    async () => {
      const r = await findEmail({ fullName: "Jane Doe", domain: "acme.com" });
      check("hunter: 451 marks the person as claimed", !r.email && r.status === "claimed" && /451/.test(r.error ?? ""), r.error);
    },
  );

  // Apollo: enrich with odd shapes (numbers as strings, printed funding, zero departments).
  await withStub(
    (url) => {
      if (url.pathname.endsWith("/organizations/enrich") && url.searchParams.get("domain") === "acme-robotics.com") {
        return {
          status: 200,
          body: {
            organization: {
              id: "0123456789abcdef01234567", name: "  Acme   Robotics ", primary_domain: null, website_url: "http://www.acme-robotics.com",
              linkedin_url: "http://www.linkedin.com/company/Acme-Robotics", industries: ["robotics"], estimated_num_employees: "1,234",
              founded_year: "2019", total_funding: null, total_funding_printed: "12.5M", latest_funding_stage: null,
              funding_events: [{ date: "2024-02-01T00:00:00.000+00:00", type: "Series A" }, { date: "2022-05-01", type: "Seed" }],
              organization_headcount_six_month_growth: "0.123456", organization_headcount_twelve_month_growth: null,
              departmental_head_count: { sales: 3, engineering: 40, accounting: 0, legal: "x" },
              technology_names: ["Zendesk", "PyTorch", "NVIDIA Jetson", "zendesk"], keywords: ["Robotics", "robotics", " humanoids "],
            },
          },
        };
      }
      return { status: 200, body: {} };
    },
    async (seen) => {
      const r = await enrichOrganization("https://acme-robotics.com/about");
      const o = r.org;
      check("apollo: key in x-api-key header, not in the URL", !!seen[0]?.hasKeyHeader && !!apolloKey && !seen[0].url.href.includes(apolloKey));
      check("apollo enrich: odd shapes mapped", !!o && o.name === "Acme Robotics" && o.domain === "acme-robotics.com" && o.employees === 1234 && o.foundedYear === 2019 && o.industry === "robotics", JSON.stringify(o && { name: o.name, domain: o.domain, employees: o.employees }));
      check("apollo enrich: funding from printed total and newest event", o?.totalFunding === 12_500_000 && o.latestFundingStage === "Series A" && o.latestFundingDate === "2024-02-01");
      check("apollo enrich: growth, departments, tech, keywords", o?.headcountGrowth6m === 0.1235 && o.headcountGrowth12m === null && JSON.stringify(o.departmentHeadcount) === '{"engineering":40,"sales":3}' && o.technologies.join() === "PyTorch,NVIDIA Jetson,Zendesk" && o.keywords.join() === "Robotics,humanoids", JSON.stringify(o?.technologies));
      check("apollo enrich: LinkedIn URL canonical", o?.linkedinUrl === "https://www.linkedin.com/company/acme-robotics", o?.linkedinUrl ?? "null");
      const none = await enrichOrganization("unknown-co.com");
      check("apollo enrich: empty answer is no match, not an error", none.org === null && !none.error);
      if (o) {
        const s = apolloOrgSummary(o);
        check("apolloOrgSummary", s.funding === "$12.5M raised in total; latest round Series A (Feb 2024)" && s.headcount === "About 1,234 employees (Apollo estimate)" && s.growth === "Headcount +12% in 6 months" && s.teams === "Largest teams: engineering 40, sales 3", JSON.stringify(s));
        const vague = apolloOrgSummary({ ...o, totalFunding: null, latestFundingStage: "Other", latestFundingDate: "2023-05-01" });
        check("apolloOrgSummary skips vague stages", vague.funding === "Latest round in May 2023", vague.funding ?? "null");
      }
    },
  );

  // Apollo: job postings, the same role on two boards, and relevance-first order.
  await withStub(
    () => ({
      status: 200,
      body: {
        organization_job_postings: [
          { title: "Driver", url: "https://boards.example/1", city: "San Jose", state: "California", country: "United States", posted_at: "2026-11-20T00:00:00Z" },
          { title: "ML Infrastructure Engineer", url: "https://boards.example/2", city: "Singapore", state: null, country: "Singapore", posted_at: "2026-10-01T00:00:00Z" },
          { title: "ML Infrastructure Engineer", url: "https://www.linkedin.com/jobs/view/3", city: "Singapore", country: "Singapore", posted_at: "2026-10-05T00:00:00Z" },
          { title: "Software Engineer, Fleet", url: null, city: null, country: null, posted_at: "bad date" },
          { title: "", url: "https://boards.example/5" },
          "junk",
        ],
        pagination: { page: 1, per_page: 100, total_entries: 6, total_pages: 1 },
      },
    }),
    async (seen) => {
      const r = await getHiring("63655104ee19b800a363b41d", 10);
      const q = seen[0]?.url.searchParams;
      check("apollo jobs: one page of 100", seen.length === 1 && q?.get("per_page") === "100" && q?.get("page") === "1");
      check("apollo jobs: deduped, relevance first, junk dropped", r.jobs.map((j) => j.title).join(" | ") === "ML Infrastructure Engineer | Software Engineer, Fleet | Driver", r.jobs.map((j) => j.title).join(" | "));
      check("apollo jobs: newest copy kept, location joined, bad date null", r.jobs[0]?.url === "https://www.linkedin.com/jobs/view/3" && r.jobs[0]?.location === "Singapore" && r.jobs[1]?.postedAt === null && r.total === 6);
      const limited = await getJobPostings("63655104ee19b800a363b41d", 1);
      check("apollo jobs: limit respected", limited.jobs.length === 1 && !limited.error);
    },
  );

  // Apollo person match as a paid plan would answer it (must run before the live 403 memo).
  const paidPerson = {
    person: {
      first_name: "Jordan", last_name: "Blake", name: "Jordan Blake", title: "VP Engineering", headline: "Robots", match_confidence: "high",
      email: "email_not_unlocked@domain.com", email_status: "verified", linkedin_url: "http://www.linkedin.com/in/jordan-blake",
      city: "Austin", country: "United States", organization: { name: "Northstar", primary_domain: "northstar.io" },
      employment_history: [
        { title: "Engineer", organization_name: "OldCo", start_date: "2015-01-01", end_date: "2018-01-01", current: false },
        { title: "VP Engineering", organization_name: "Northstar", start_date: "2021-03-01", end_date: null, current: true },
      ],
    },
  };
  await withStub(
    () => ({ status: 200, body: paidPerson }),
    async (seen) => {
      const r = await matchPerson({ linkedinUrl: "https://linkedin.com/in/Jordan-Blake/", name: "Jordan Blake", domain: "northstar.io" });
      const p = r.person;
      check("apollo match: POST with identifiers as query parameters", seen[0]?.method === "POST" && seen[0].url.searchParams.get("linkedin_url") === "https://www.linkedin.com/in/jordan-blake" && seen[0].url.searchParams.get("reveal_phone_number") === "false");
      check("apollo match: person mapped, locked email hidden", !!p && !r.planBlocked && p.email === null && p.emailStatus === "verified" && p.linkedinUrl === "https://www.linkedin.com/in/jordan-blake" && p.organizationDomain === "northstar.io");
      check("apollo match: current job first", p?.employmentHistory[0]?.current === true && p.employmentHistory[0].organization === "Northstar");
      const wrong = await matchPerson({ linkedinUrl: "https://www.linkedin.com/in/someone-else" });
      check("apollo match: a different LinkedIn profile is dropped", wrong.person === null && !wrong.planBlocked && !wrong.error);
    },
  );
  await withStub(
    () => ({ status: 200, body: { person: { ...paidPerson.person, match_confidence: "low", linkedin_url: null } } }),
    async () => {
      const r = await matchPerson({ name: "Jordan Blake", organizationName: "Northstar" });
      check("apollo match: low-confidence name-only match is dropped", r.person === null && !r.error);
    },
  );
  await withStub(
    () => ({ status: 429, body: { error_details: { code: "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED", context: { window: { value: "minute" } } } } }),
    async () => {
      const r = await enrichOrganization("ratelimited.com");
      check("apollo: 429 explained", !r.org && /429/.test(r.error ?? "") && /minute/.test(r.error ?? ""), r.error);
    },
  );
}

async function main() {
  section("Status (no network)");
  const a = apolloStatus();
  const h = hunterStatus();
  console.log(`      apollo: configured=${a.configured} | ${a.detail}`);
  console.log(`      hunter: configured=${h.configured} | ${h.detail}`);
  check("apolloStatus shape", a.id === "apollo" && a.label === "Apollo" && typeof a.detail === "string");
  check("hunterStatus shape", h.id === "hunter" && h.label === "Hunter" && typeof h.detail === "string");
  check("status calls made no request", totalCalls() === 0);
  if (!a.configured) throw new Error("APOLLO_API_KEY is not set in .env.local");

  await offlineChecks();

  section("Apollo: organization enrich (live)");
  const ai2 = await enrichOrganization("allenai.org");
  check("enrich allenai.org", !!ai2.org && !ai2.error && ai2.org.domain === "allenai.org", ai2.error ?? ai2.org?.name ?? "no org");
  if (ai2.org) printOrg(ai2.org);
  const figure = await enrichOrganization("https://www.figure.ai/");
  check("enrich figure.ai (robotics)", !!figure.org && !figure.error && figure.org.domain === "figure.ai", figure.error ?? figure.org?.name ?? "no org");
  if (figure.org) {
    printOrg(figure.org);
    const o = figure.org;
    check("org id looks like an Apollo id", /^[a-f0-9]{24}$/.test(o.id ?? ""), o.id ?? "null");
    check("headcount growth is a fraction", o.headcountGrowth12m === null || Math.abs(o.headcountGrowth12m) < 20, String(o.headcountGrowth12m));
    const counts = Object.values(o.departmentHeadcount);
    check("departments sorted, no zeros", counts.every((n, i) => n > 0 && (i === 0 || counts[i - 1] >= n)), `${counts.length} departments`);
    check("funding date is YYYY-MM-DD", o.latestFundingDate === null || /^\d{4}-\d{2}-\d{2}$/.test(o.latestFundingDate), String(o.latestFundingDate));
  }

  section("Apollo: job postings (live)");
  if (figure.org?.id) {
    const res = await getJobPostings(figure.org.id, 8);
    check("getJobPostings figure.ai", !res.error && res.jobs.length > 0 && res.jobs.length <= 8, res.error ?? `${res.jobs.length} jobs`);
    for (const j of res.jobs) {
      console.log(`      - ${j.title} | ${j.location ?? "-"} | ${j.postedAt?.slice(0, 10) ?? "-"} | ${j.url ? new URL(j.url).host : "-"}`);
    }
    check("every job has a title", res.jobs.every((j) => j.title.length > 0));
    check("postedAt values are ISO", res.jobs.every((j) => j.postedAt === null || !Number.isNaN(Date.parse(j.postedAt))));
  } else {
    check("getJobPostings figure.ai", false, "skipped: no org id from enrich");
  }

  section("Apollo: person match (live, free plan expects planBlocked)");
  const apolloBefore = count("api.apollo.io");
  const match = await matchPerson({
    linkedinUrl: "https://www.linkedin.com/in/brettadcock/",
    name: "Brett Adcock",
    domain: "figure.ai",
    organizationName: "Figure",
  });
  console.log(`      planBlocked=${match.planBlocked} person=${match.person ? match.person.name : "null"} error=${match.error ?? "none"}`);
  check("matchPerson: planBlocked without an error (or a real match on a paid plan)", (match.planBlocked && !match.error && !match.person) || (!!match.person && !match.error));
  check("matchPerson made one Apollo request", count("api.apollo.io") === apolloBefore + 1);
  if (match.planBlocked) {
    const again = await matchPerson({ linkedinUrl: "https://www.linkedin.com/in/brettadcock" });
    check("second matchPerson is answered from memory", again.planBlocked && !again.error && count("api.apollo.io") === apolloBefore + 1);
    console.log(`      apolloStatus now: ${apolloStatus().detail}`);
  }

  if (APOLLO_EXTRA) {
    section("Apollo extras (live, APOLLO_EXTRA=1)");
    const companyUrl = ai2.org?.linkedinUrl ?? "https://www.linkedin.com/company/allen-ai";
    const byLinkedin = await enrichOrganization(`${companyUrl}/`);
    console.log(`      by LinkedIn URL ${companyUrl}: ${byLinkedin.org ? `${byLinkedin.org.name} | ${byLinkedin.org.domain}` : "no org"} | error=${byLinkedin.error ?? "none"}`);
    check("enrich by LinkedIn company URL finds the domain", byLinkedin.org?.domain === "allenai.org", byLinkedin.error ?? byLinkedin.org?.domain ?? "no org");
    const unknown = await enrichOrganization("no-such-company-lead-engine-test-7f3a.com");
    console.log(`      unknown domain: org=${unknown.org ? unknown.org.name : "null"} error=${unknown.error ?? "none"}`);
    check("unknown domain gives org null without an error", !unknown.org && !unknown.error, unknown.error);
    if (ai2.org?.id) {
      const hiring = await getHiring(ai2.org.id, 5);
      console.log(`      allenai.org hiring: total=${hiring.total} shown=${hiring.jobs.length} error=${hiring.error ?? "none"}`);
      for (const j of hiring.jobs) console.log(`      - ${j.title} | ${j.location ?? "-"} | ${j.postedAt?.slice(0, 10) ?? "-"}`);
      check("getHiring returns a total", !hiring.error && (hiring.total === null || hiring.total >= hiring.jobs.length), hiring.error);
    }
    const savedKey = process.env.APOLLO_API_KEY;
    process.env.APOLLO_API_KEY = "invalid-test-key-0000";
    try {
      const bad = await enrichOrganization("allenai.org");
      console.log(`      bad key: ${bad.error ?? "no error"}`);
      check("bad key gives a clear 401 error", !bad.org && /401/.test(bad.error ?? ""));
    } finally {
      process.env.APOLLO_API_KEY = savedKey;
    }
  }

  section(`Hunter: email finder (${HUNTER_LIVE ? `live, at most ${HUNTER_MAX_CALLS} calls` : "live calls skipped; set HUNTER_LIVE=1"})`);
  if (HUNTER_LIVE) {
    if (!h.configured) throw new Error("HUNTER_API_KEY is not set in .env.local");
    // 1) What the pipeline sends: LinkedIn handle plus name and company domain, in one call.
    const t1 = Date.now();
    const r1 = await findEmail({
      linkedinUrl: "https://www.linkedin.com/in/brettadcock/",
      fullName: "Brett Adcock",
      domain: "figure.ai",
      company: "Figure",
    });
    console.log(`      handle+name+domain: email=${maskEmail(r1.email)} score=${r1.score} status=${r1.status} sources=${r1.sources.length} error=${r1.error ?? "none"} (${Date.now() - t1} ms)`);
    check("findEmail (handle + name + domain) answers without error", !r1.error, r1.error);
    check("result shape", Array.isArray(r1.sources) && (r1.score === null || (r1.score >= 0 && r1.score <= 100)));
    if (HUNTER_MAX_CALLS >= 2) {
      // 2) Fallback path: name plus company domain only, no LinkedIn handle.
      const t2 = Date.now();
      const r2 = await findEmail({ fullName: "Dr. Ali Farhadi, PhD", domain: "allenai.org" });
      console.log(`      name+domain: email=${maskEmail(r2.email)} score=${r2.score} status=${r2.status} sources=${r2.sources.length} error=${r2.error ?? "none"} (${Date.now() - t2} ms)`);
      check("findEmail (name + domain) answers without error", !r2.error, r2.error);
      if (r2.email) check("email is at the requested domain", r2.email.endsWith("@allenai.org"), maskEmail(r2.email));
    }
  }

  // Last, because it pauses Hunter in this process: out of credits fails fast afterwards.
  section("Hunter pause after 429 (fetch stubbed)");
  await withStub(
    () => ({ status: 429, body: { errors: [{ id: "too_many_requests", code: 429, details: "You have reached your usage limit." }] } }),
    async (seen) => {
      const first = await findEmail({ fullName: "Jane Doe", domain: "acme.com" });
      const second = await findEmail({ fullName: "John Roe", domain: "acme.com" });
      check("hunter: 429 explained, then no further requests", /429/.test(first.error ?? "") && second.error === first.error && seen.length === 1, first.error);
      check("hunterStatus reports the pause", /credits/.test(hunterStatus().detail), hunterStatus().detail);
    },
  );

  section("Summary");
  console.log(`      real requests: ${[...calls.entries()].map(([host, n]) => `${host}=${n}`).join(", ") || "none"}`);
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error("test-apollo-hunter crashed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
