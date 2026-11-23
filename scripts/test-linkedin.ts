/**
 * Test for src/lib/providers/linkedin.ts.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-linkedin.ts [flags]
 *
 * Always runs offline mapping tests (synthetic fixtures shaped like the real responses), then,
 * unless --offline, live calls through the public functions (Unipile first, Apify fallback).
 *
 * Flags:
 *   --offline                 mapping tests only, no network
 *   --url=<profile url>       default https://www.linkedin.com/in/pieterabbeel/
 *   --company=<url or name>   company for the company tests (default: the profile's current company)
 *   --company-name=<name>     name for the name-lookup tests (default: Covariant)
 *   --skip-unipile            skip the live calls through the public functions
 *   --apify=<list>            Apify runs to make, comma separated: profile, posts, company, company-name.
 *                             Each one is a paid actor run (about $0.004 to $0.02). Default: none.
 *
 * Prints statuses, the field names that came back non-null and short snippets. Never keys.
 */
import {
  APIFY_ACTORS,
  domainFromWebsite,
  getCompanyViaApify,
  getCompanyViaUnipile,
  getLinkedInCompany,
  getLinkedInPosts,
  getLinkedInProfile,
  getPostsViaApify,
  getProfileViaApify,
  linkedinStatus,
  mapApifyCompany,
  mapApifyPost,
  mapApifyProfile,
  mapUnipileCompany,
  mapUnipilePost,
  mapUnipileProfile,
  normaliseLinkedInDate,
  type LinkedInCompany,
  type LinkedInPost,
  type LinkedInProfile,
} from "../src/lib/providers/linkedin";

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args.set(m[1], m[2] ?? "true");
}
const PROFILE_URL = args.get("url") ?? "https://www.linkedin.com/in/pieterabbeel/";
const COMPANY_NAME = args.get("company-name") ?? "Covariant";
const APIFY_RUNS = new Set((args.get("apify") ?? "").split(",").map((s) => s.trim()).filter(Boolean));

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const snip = (v: unknown, n = 70): string => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Names of fields that are not null, not empty strings and not empty arrays. */
function nonNullFields(o: object): string[] {
  return Object.entries(o)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => (Array.isArray(v) ? `${k}[${v.length}]` : k));
}

/** Top-level keys of the first raw item that carry a value (field names only). */
function rawKeys(raw: unknown): string {
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (!first || typeof first !== "object") return `(no item; ${Array.isArray(raw) ? `${raw.length} items` : typeof raw})`;
  return nonNullFields(first as object).join(", ");
}

/** The shape (type or field names, no values) of the first element of some nested arrays. */
function nestedShapes(raw: unknown, keys: string[]): string {
  const first = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!first || typeof first !== "object") return "-";
  return keys
    .map((k) => {
      const v = first[k];
      const el = Array.isArray(v) ? v[0] : undefined;
      if (el === undefined) return `${k}: -`;
      return `${k}[0]: ${el !== null && typeof el === "object" ? `{${Object.keys(el).join(",")}}` : typeof el}`;
    })
    .join(" | ");
}

function showProfile(p: LinkedInProfile): void {
  console.log(`    via=${p.via}  non-null: ${nonNullFields(p).join(", ")}`);
  console.log(`    fullName: ${snip(p.fullName)} | headline: ${snip(p.headline, 60)}`);
  console.log(`    current: ${snip(p.currentTitle, 50)} @ ${snip(p.currentCompany, 40)} | company url: ${p.currentCompanyLinkedinUrl ?? "-"}`);
  console.log(`    location: ${snip(p.location)} | providerId: ${p.providerId ? `${p.providerId.slice(0, 6)}…` : "-"}`);
  const e = p.experience[0];
  if (e) console.log(`    experience[0]: ${snip(e.title, 40)} @ ${snip(e.company, 30)} ${e.startDate ?? "?"}..${e.endDate ?? "now"}`);
  const ed = p.education[0];
  if (ed) console.log(`    education[0]: ${snip(ed.school, 40)} | ${snip(ed.degree, 40)} ${ed.startDate ?? "?"}..${ed.endDate ?? "?"}`);
  console.log(`    skills: ${snip(p.skills.slice(0, 5).join(", "), 80)} | about: ${snip(p.about, 60)}`);
}

function showPosts(posts: LinkedInPost[]): void {
  console.log(`    ${posts.length} posts; reposts: ${posts.filter((p) => p.isRepost).length}`);
  for (const p of posts.slice(0, 3)) {
    console.log(`    - ${p.postedAt ?? "no date"} repost=${p.isRepost} reactions=${p.reactions ?? "-"} comments=${p.comments ?? "-"} | ${snip(p.text, 70)}`);
    console.log(`      url: ${snip(p.url, 90)}`);
  }
}

function showCompany(c: LinkedInCompany): void {
  console.log(`    via=${c.via}  non-null: ${nonNullFields(c).join(", ")}`);
  console.log(`    ${snip(c.name, 40)} | ${c.linkedinUrl ?? "-"} | domain ${c.domain ?? "-"} | ${c.employeeCount ?? "?"} people (${c.employeeRange ?? "?"})`);
  console.log(`    industry: ${snip(c.industry, 40)} | hq: ${snip(c.headquarters, 40)} | founded ${c.foundedYear ?? "?"} | ${snip(c.description, 60)}`);
}

async function timed<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const t = Date.now();
  const r = await fn();
  return [r, `${((Date.now() - t) / 1000).toFixed(1)}s`];
}

// ---------------------------------------------------------------------------
// Offline mapping tests. Synthetic data, shaped like the documented and observed responses.
// ---------------------------------------------------------------------------

function offlineTests(): void {
  console.log("\n== Offline mapping tests");

  check("date M/D/YYYY (Unipile)", normaliseLinkedInDate("9/1/2024") === "2024-09");
  check("date {month,year} (Apify)", normaliseLinkedInDate({ month: "Jan", year: 2024, text: "Jan 2024" }) === "2024-01");
  check("date Present -> null", normaliseLinkedInDate({ text: "Present" }) === null && normaliseLinkedInDate(null) === null);
  check("date year only", normaliseLinkedInDate({ year: 2019 }) === "2019" && normaliseLinkedInDate("2019") === "2019");
  check("date ISO", normaliseLinkedInDate("2021-06-15T00:00:00Z") === "2021-06");

  check("domain strips www", domainFromWebsite("http://www.covariant.ai/") === "covariant.ai");
  check("domain strips careers subdomain", domainFromWebsite("https://jobs.netflix.com?utm_campaign=x") === "netflix.com");
  check("domain without scheme", domainFromWebsite("acme-robotics.com/about") === "acme-robotics.com");
  check("domain ignores social sites", domainFromWebsite("https://linkedin.com/company/x") === null && domainFromWebsite("") === null);

  const uni = mapUnipileProfile(
    {
      object: "UserProfile",
      provider: "LINKEDIN",
      provider_id: "ACoAAAbcdefghijklmnop",
      public_identifier: "ada-example",
      first_name: "Ada",
      last_name: "Example",
      headline: "Head of Robotics at Acme Robotics",
      location: "Berkeley, California, United States",
      summary: "Building robot learning systems.",
      websites: ["https://ada.example.com"],
      follower_count: 1200,
      connections_count: 500,
      work_experience: [
        { position: "Head of Robotics", company: "Acme Robotics", company_id: "123", start: "3/1/2023", end: null },
        { position: "Advisor", company: "Side Co", company_id: "789", start: "1/1/2020", end: null },
        { position: "Engineer", company: "Old Co", company_id: "456", start: "1/1/2019", end: "2/1/2023" },
      ],
      education: [{ school: "MIT", degree: "MS", field_of_study: "EECS", start: "1/1/2015", end: "1/1/2017" }],
      skills: [{ name: "ROS" }, { name: "PyTorch" }],
    },
    "https://www.linkedin.com/in/ada-example/",
  );
  check("unipile profile maps", uni !== null && uni.fullName === "Ada Example" && uni.via === "unipile");
  check("unipile current role = first open-ended", uni?.currentTitle === "Head of Robotics" && uni?.currentCompany === "Acme Robotics");
  check("unipile company url from id", uni?.currentCompanyLinkedinUrl === "https://www.linkedin.com/company/123");
  check("unipile dates", uni?.experience[2].startDate === "2019-01" && uni?.experience[2].endDate === "2023-02");
  check("unipile education + skills", uni?.education[0].field === "EECS" && uni?.skills.join(",") === "ROS,PyTorch");
  check("unipile url canonical", uni?.url === "https://www.linkedin.com/in/ada-example");
  check("unipile junk -> null", mapUnipileProfile({ status: 404 }, "x") === null && mapUnipileProfile("nope", "x") === null);

  const apify = mapApifyProfile(
    {
      id: "ACoAAAzyxwvutsrqponml",
      publicIdentifier: "ada-example",
      linkedinUrl: "https://www.linkedin.com/in/ada-example",
      firstName: "Ada",
      lastName: "Example",
      headline: "Head of Robotics",
      about: "Building robot learning systems.",
      location: { linkedinText: "Berkeley, California, United States", parsed: { text: "Berkeley, CA, United States" } },
      followerCount: 1200,
      connectionsCount: 500,
      currentPosition: [{ companyName: "Acme Robotics" }],
      experience: [
        {
          position: "Head of Robotics",
          companyName: "Acme Robotics",
          companyLinkedinUrl: "https://www.linkedin.com/company/acme-robotics/",
          startDate: { month: "Mar", year: 2023, text: "Mar 2023" },
          endDate: { text: "Present" },
        },
        {
          position: "Engineer",
          companyName: "Old Co",
          companyLinkedinUrl: "https://www.linkedin.com/company/old-co/",
          startDate: { month: "Jan", year: 2019, text: "Jan 2019" },
          endDate: { month: "Feb", year: 2023, text: "Feb 2023" },
        },
      ],
      education: [{ schoolName: "MIT", degree: "MS", fieldOfStudy: "EECS", startDate: { year: 2015 }, endDate: { year: 2017 } }],
      skills: [{ name: "ROS" }],
      topSkills: "ROS • PyTorch",
    },
    "https://www.linkedin.com/in/ada-example",
  );
  check("apify profile maps", apify !== null && apify.via === "apify" && apify.providerId === "ACoAAAzyxwvutsrqponml");
  check("apify current role", apify?.currentTitle === "Head of Robotics" && apify?.currentCompanyLinkedinUrl === "https://www.linkedin.com/company/acme-robotics");
  check("apify dates", apify?.experience[0].startDate === "2023-03" && apify?.experience[0].endDate === null && apify?.experience[1].endDate === "2023-02");
  check("apify location + education", apify?.location === "Berkeley, California, United States" && apify?.education[0].startDate === "2015");

  const repost = mapUnipilePost({
    object: "Post",
    share_url: "https://www.linkedin.com/posts/acme_launch-activity-123-abcd?utm_source=social_share_send&rcm=ACoAAA",
    text: "We launched a new arm.",
    parsed_datetime: "2026-10-01T10:00:00.000Z",
    repost_parsed_datetime: "2026-10-02T10:00:00.000Z",
    reaction_counter: 10,
    comment_counter: 2,
    is_repost: true,
    author: { name: "Acme Robotics", is_company: true },
  });
  check("unipile repost labelled", repost?.isRepost === true && repost?.text.startsWith("[Reposted from Acme Robotics]") === true);
  check("unipile repost date = when shared", repost?.postedAt === "2026-10-02T10:00:00.000Z");
  check("unipile post url without tracking", repost?.url === "https://www.linkedin.com/posts/acme_launch-activity-123-abcd");
  check("unipile empty post -> null", mapUnipilePost({ text: "  " }) === null);

  const own = mapApifyPost(
    {
      type: "post",
      id: "7329207003942125568",
      linkedinUrl: "https://www.linkedin.com/posts/ada-example_robots-activity-7329207003942125568-_gfJ",
      content: "Our robot folded laundry at 30 Hz.",
      author: { publicIdentifier: "ada-example", type: "profile", name: "Ada Example" },
      postedAt: { timestamp: 1747419119821, date: "2025-05-16T18:11:59.821Z", postedAgoShort: "6d" },
      engagement: { likes: 29, comments: 3, shares: 1 },
    },
    "ada-example",
  );
  check("apify own post", own?.isRepost === false && own?.reactions === 29 && own?.postedAt === "2025-05-16T18:11:59.821Z");
  const other = mapApifyPost(
    { type: "post", content: "Big news", author: { publicIdentifier: "someone-else", name: "Someone Else" } },
    "ada-example",
  );
  check("apify post by someone else = repost", other?.isRepost === true && other?.text.startsWith("[Reposted from Someone Else]") === true);
  const marked = mapApifyPost(
    {
      type: "post",
      content: "Series A news",
      author: { publicIdentifier: "founder-x", name: "Founder X" },
      postedAt: { date: "2026-07-30T13:30:27.616Z" },
      repostedBy: { publicIdentifier: "ada-example", name: "Ada Example" },
      repostedAt: { date: "2026-07-30T16:55:09.882Z" },
    },
    "ACoAAAzyxwvutsrqponml",
  );
  check("apify repostedBy marks a repost, dated when shared", marked?.isRepost === true && marked?.postedAt === "2026-07-30T16:55:09.882Z");

  const uc = mapUnipileCompany({
    object: "CompanyProfile",
    id: "18927753",
    name: "Covariant",
    description: "AI robotics.",
    public_identifier: "covariant-ai",
    profile_url: "https://www.linkedin.com/company/covariant-ai/",
    website: "http://covariant.ai/",
    foundation_date: "01/01/2017",
    employee_count: 45,
    employee_count_range: { from: 51, to: 200 },
    industry: ["Software Development"],
    locations: [{ is_headquarter: true, city: "Berkeley", country: "US", area: "CA", street: [] }],
  });
  check("unipile company maps", uc?.domain === "covariant.ai" && uc?.employeeRange === "51-200" && uc?.foundedYear === 2017);
  check("unipile company hq + url", uc?.headquarters === "Berkeley, CA, US" && uc?.linkedinUrl === "https://www.linkedin.com/company/covariant-ai");

  const ac = mapApifyCompany({
    id: "165158",
    universalName: "netflix",
    linkedinUrl: "https://www.linkedin.com/company/netflix",
    name: "Netflix",
    website: "https://jobs.netflix.com?utm_campaign=LIHomePage",
    foundedOn: { year: 1997 },
    employeeCount: 16985,
    employeeCountRange: { start: 10001 },
    description: "Entertainment.",
    locations: [{ country: "US", geographicArea: "CA", city: "Los Gatos", headquarter: true, parsed: { text: "Los Gatos, CA, United States" } }],
    specialities: ["Streaming"],
    industries: ["Entertainment Providers"],
  });
  check("apify company maps", ac?.domain === "netflix.com" && ac?.employeeRange === "10001+" && ac?.foundedYear === 1997);
  check("apify company hq + specialties", ac?.headquarters === "Los Gatos, CA, United States" && ac?.specialties[0] === "Streaming");
  const acObjects = mapApifyCompany({ name: "Acme", industries: [{ name: "Robotics Engineering" }], specialities: [{ title: "Arms" }] });
  check("apify company label objects", acObjects?.industry === "Robotics Engineering" && acObjects?.specialties[0] === "Arms");
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

async function liveTests(): Promise<void> {
  let profile: LinkedInProfile | null = null;

  if (!args.has("skip-unipile")) {
    console.log(`\n== getLinkedInProfile(${PROFILE_URL})`);
    const [r, t] = await timed(() => getLinkedInProfile(PROFILE_URL));
    check("profile returned", r.profile !== null, r.error ? `error: ${snip(r.error, 160)}` : t);
    if (r.profile) {
      profile = r.profile;
      showProfile(r.profile);
      check("profile has name, headline and provider id", Boolean(r.profile.fullName && r.profile.headline && r.profile.providerId));
      check("profile has experience", r.profile.experience.length > 0);
    }

    console.log("\n== getLinkedInPosts(limit 5, providerId from the profile)");
    const [posts, tp] = await timed(() => getLinkedInPosts(PROFILE_URL, { limit: 5, providerId: profile?.providerId ?? null }));
    check("posts returned without error", !posts.error, posts.error ? `error: ${snip(posts.error, 160)}` : tp);
    showPosts(posts.posts);
    check("posts newest first", posts.posts.every((p, i, a) => i === 0 || !p.postedAt || !a[i - 1].postedAt || a[i - 1].postedAt! >= p.postedAt));

    const companyTarget = args.get("company") ?? profile?.currentCompanyLinkedinUrl ?? profile?.currentCompany ?? null;
    if (companyTarget) {
      console.log(`\n== getLinkedInCompany(${companyTarget})`);
      const [c, tc] = await timed(() => getLinkedInCompany(companyTarget));
      check("company returned", c.company !== null, c.error ? `error: ${snip(c.error, 160)}` : tc);
      if (c.company) showCompany(c.company);
    }

    console.log(`\n== getCompanyViaUnipile("${COMPANY_NAME}") (name -> LinkedIn search -> company)`);
    const [cn, tn] = await timed(() => getCompanyViaUnipile(COMPANY_NAME));
    if (linkedinStatus().detail.startsWith("Unipile")) {
      check("company by name (Unipile)", cn.company !== null, cn.error ? `error: ${snip(cn.error, 160)}` : tn);
      if (cn.company) showCompany(cn.company);
    } else {
      console.log(`    skipped: Unipile is not configured (${snip(cn.error, 100)})`);
    }
  }

  if (APIFY_RUNS.size) {
    console.log(`\n== Apify runs requested: ${[...APIFY_RUNS].join(", ")} (each is a paid actor run)`);
  }

  if (APIFY_RUNS.has("profile")) {
    console.log(`\n== Apify ${APIFY_ACTORS.profile.name}: ${PROFILE_URL}`);
    let raw: unknown = null;
    const [r, t] = await timed(() => getProfileViaApify(PROFILE_URL, { onRaw: (x) => (raw = x) }));
    console.log(`    raw item fields: ${rawKeys(raw)}`);
    check("apify profile returned", r.profile !== null, r.error ? `error: ${snip(r.error, 200)}` : t);
    if (r.profile) {
      showProfile(r.profile);
      if (!profile) profile = r.profile;
    }
  }

  if (APIFY_RUNS.has("posts")) {
    console.log(`\n== Apify ${APIFY_ACTORS.posts.name}: ${PROFILE_URL} (limit 3)`);
    let raw: unknown = null;
    const [r, t] = await timed(() => getPostsViaApify(PROFILE_URL, { limit: 3 }, { onRaw: (x) => (raw = x) }));
    console.log(`    raw items: ${Array.isArray(raw) ? raw.length : 0}; first item fields: ${rawKeys(raw)}`);
    check("apify posts without error", !r.error, r.error ? `error: ${snip(r.error, 200)}` : t);
    showPosts(r.posts);
  }

  if (APIFY_RUNS.has("company")) {
    const target = args.get("company") ?? profile?.currentCompanyLinkedinUrl ?? null;
    if (!target) {
      console.log("\n== Apify company: skipped, no company URL (pass --company=...)");
    } else {
      console.log(`\n== Apify ${APIFY_ACTORS.company.name}: ${target}`);
      let raw: unknown = null;
      const [r, t] = await timed(() => getCompanyViaApify(target, { onRaw: (x) => (raw = x) }));
      console.log(`    raw item fields: ${rawKeys(raw)}`);
      console.log(`    nested shapes: ${nestedShapes(raw, ["industries", "specialities", "locations"])}`);
      check("apify company returned", r.company !== null, r.error ? `error: ${snip(r.error, 200)}` : t);
      if (r.company) showCompany(r.company);
    }
  }

  if (APIFY_RUNS.has("company-name")) {
    console.log(`\n== Apify ${APIFY_ACTORS.company.name}: search "${COMPANY_NAME}"`);
    let raw: unknown = null;
    const [r, t] = await timed(() => getCompanyViaApify(COMPANY_NAME, { onRaw: (x) => (raw = x) }));
    console.log(`    raw item fields: ${rawKeys(raw)}`);
    console.log(`    nested shapes: ${nestedShapes(raw, ["industries", "specialities", "locations"])}`);
    check("apify company by name returned", r.company !== null, r.error ? `error: ${snip(r.error, 200)}` : t);
    if (r.company) showCompany(r.company);
  }
}

/**
 * Runs last: points Unipile at a closed local port and removes the Apify token in this process,
 * so it can make no LinkedIn request and no paid run. The first call must fail cleanly, the
 * second must skip Unipile at once (cooldown) instead of waiting on it again.
 */
async function simulatedOutage(): Promise<void> {
  console.log("\n== Simulated Unipile outage (no LinkedIn request, no Apify run)");
  process.env.UNIPILE_DSN = "https://127.0.0.1:9";
  delete process.env.APIFY_TOKEN;
  delete process.env.UNIPILE_ACCOUNT_ID;
  const [first, t1] = await timed(() => getLinkedInProfile(PROFILE_URL));
  check("outage: first call fails cleanly", first.profile === null && /^Unipile profile: /.test(first.error ?? ""), `${t1} | ${snip(first.error, 110)}`);
  const started = Date.now();
  const second = await getLinkedInPosts(PROFILE_URL, { limit: 3 });
  const ms = Date.now() - started;
  check("outage: next call skips Unipile at once", /skipped after a recent failure/.test(second.error ?? "") && ms < 200, `${ms}ms | ${snip(second.error, 90)}`);
}

async function main(): Promise<void> {
  console.log("== linkedinStatus()");
  const s = linkedinStatus();
  console.log(`  configured=${s.configured} | ${s.detail}`);
  check("status has id and detail", s.id === "linkedin" && s.detail.length > 0);

  offlineTests();

  console.log("\n== Input checks (no network)");
  const bad = await getLinkedInProfile("https://example.com/not-linkedin");
  check("bad profile URL -> error, no throw", bad.profile === null && Boolean(bad.error));
  const badCompany = await getLinkedInCompany("   ");
  check("empty company -> error, no throw", badCompany.company === null && Boolean(badCompany.error));

  if (!args.has("offline")) await liveTests();
  await simulatedOutage();

  console.log(`\n${failed === 0 ? "OK" : "FAILED"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("test crashed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
