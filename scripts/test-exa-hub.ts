/**
 * Test for the Exa, Hugging Face and Abstract inspect providers: offline checks, then live calls.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-exa-hub.ts
 *
 * Offline (free, fetch stubbed): Exa request building (category filters, date format, category
 * names), the 400 self-heal, response mapping (profile entities, highlights, dedupe), quoted-name
 * filtering after a relaxed search; Hub query cleaning, base-model parsing and served-base
 * detection; Abstract checkpoint URIs, request shape, answer and error mapping, and the no-key path.
 * Live: 3 Exa searches (people search with excludeDomains, company news for the last 12 months,
 * a talks search) and 1 contents call; Hub search, allenai models and datasets, and an account
 * with real fine-tunes of served bases. Abstract has no key here: the guard refuses any call to it.
 * The checks that put a provider into its pause state run last, after the live calls.
 *
 * EXA_LIVE=0 skips the live Exa calls. Prints statuses and short snippets, never keys or headers.
 */
import { abstractStatus, inspectCheckpoint, mapInspection, toCheckpointUri } from "../src/lib/providers/abstract";
import { cleanDomain, entitySummary, ExaError, exaContents, exaSearch, exaStatus, urlMatchesDomain, type ExaResult } from "../src/lib/providers/exa";
import {
  baseRefs,
  getHubDatasets,
  getHubModels,
  hubQuery,
  hubStatus,
  searchHubAccounts,
  SERVED_BASE_MODELS,
  servedBaseOf,
} from "../src/lib/providers/huggingface";

const EXA_LIVE = process.env.EXA_LIVE !== "0";
/** 3 searches + 1 contents call, plus one spare in case Exa asks for a retry. */
const EXA_MAX_CALLS = 5;

// ---- fetch guard: stubs for offline checks; counting and budgets for live calls -------------
interface Seen {
  url: URL;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}
type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error;

const realFetch = globalThis.fetch;
const liveCalls = new Map<string, number>();
let stub: ((req: Seen) => Reply) | null = null;
let seen: Seen[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (stub) {
    const req: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    seen.push(req);
    const r = stub(req);
    if (r instanceof Error) throw r;
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
    return new Response(text, { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }
  const n = (liveCalls.get(url.host) ?? 0) + 1;
  if (url.host === "api.abstract.inc") throw new Error("test guard: no live Abstract calls (there is no key in this sandbox)");
  if (url.host === "api.exa.ai" && (!EXA_LIVE || n > EXA_MAX_CALLS)) throw new Error(`test guard: refused Exa request #${n}`);
  liveCalls.set(url.host, n);
  return realFetch(input, init);
}) as typeof fetch;

async function withStub<T>(reply: (req: Seen) => Reply, fn: () => Promise<T>): Promise<{ value: T | null; error: unknown; seen: Seen[] }> {
  stub = reply;
  seen = [];
  try {
    return { value: await fn(), error: null, seen };
  } catch (error) {
    return { value: null, error, seen };
  } finally {
    stub = null;
  }
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}
const snip = (s: string | null | undefined, n = 90) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const monthsAgo = (m: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, d.getUTCDate())).toISOString().slice(0, 10);
};

// ---- fixtures (shapes copied from live Exa responses, Nov 2026) -----------------------------
const PERSON_ENTITY = [
  {
    id: "https://exa.ai/library/person/x",
    type: "person",
    version: 1,
    properties: {
      name: "Jane Roe",
      location: "Seattle, Washington, United States",
      workHistory: [
        { title: "Research Intern", location: null, dates: { from: "2019-06-01", to: "2019-09-01" }, company: { id: null, name: "Old Lab" } },
        { title: "Head of Robot Learning", location: null, dates: { from: "2024-03-01", to: null }, company: { id: null, name: "Tallow Robotics" } },
      ],
      educationHistory: [{ degree: "PhD Computer Science", dates: { from: "2016", to: "2021" }, institution: { id: null, name: "Stanford University" } }],
      research: null,
    },
  },
];
const PROFILE_TEXT = "# Jane Roe\n\nHead of Robot Learning\n\nSeattle, Washington, United States (US)\n\n## About\n\nI train VLAs on bimanual YAM arms.";

function exaResult(over: Record<string, unknown>): Record<string, unknown> {
  return { id: over.url, title: "Title", url: "https://example.com/a", publishedDate: "2026-10-01T00:00:00.000Z", text: "Some page text.", highlights: [], ...over };
}

// ---- offline: Exa ---------------------------------------------------------------------------
async function offlineExa(): Promise<void> {
  console.log("\n== Exa, offline");
  check("cleanDomain keeps path prefixes and drops scheme and www", cleanDomain("https://www.LinkedIn.com/company/") === "linkedin.com/company");
  check("cleanDomain refuses junk", cleanDomain("not a domain") === null && cleanDomain(42) === null);
  check("urlMatchesDomain matches subdomains", urlMatchesDomain("https://uk.linkedin.com/in/x", "linkedin.com"));
  check("urlMatchesDomain respects path prefixes", urlMatchesDomain("https://x.com/a/b", "x.com/a") && !urlMatchesDomain("https://x.com/b", "x.com/a"));
  check("urlMatchesDomain does not match lookalike hosts", !urlMatchesDomain("https://notlinkedin.com/in/x", "linkedin.com"));

  // People category: excludeDomains and the date filter are applied here, never sent (Exa answers 400).
  const people = await withStub(
    () => ({
      status: 200,
      body: {
        requestId: "r1",
        results: [
          exaResult({ url: "https://linkedin.com/in/jane-roe", title: "Jane Roe", text: PROFILE_TEXT, highlights: [PROFILE_TEXT.slice(0, 60)], entities: PERSON_ENTITY }),
          exaResult({ url: "https://www.linkedin.com/in/jane-roe/", title: "Jane Roe (duplicate)" }),
          exaResult({ url: "https://x.com/janeroe", title: "Jane on X" }),
          exaResult({ url: "https://janeroe.dev", title: "Old page", publishedDate: "2019-01-01T00:00:00.000Z" }),
          exaResult({ url: "ftp://bad.example/file", title: "Not http" }),
          exaResult({ url: "https://scholar.example/jane", title: "Undated", publishedDate: undefined }),
        ],
      },
    }),
    () => exaSearch("  Jane   Roe Tallow Robotics ", { category: "people", numResults: 3, textChars: 700, excludeDomains: ["x.com"], startPublishedDate: "2025-11-23" }),
  );
  const pb = people.seen[0]?.body ?? {};
  check("people search: one request", people.seen.length === 1, `${people.seen.length}`);
  check("people search: sends the key header", people.seen[0]?.headers.has("x-api-key") === true);
  check("people search: POST /search", people.seen[0]?.method === "POST" && people.seen[0]?.url.href === "https://api.exa.ai/search");
  check("people search: query whitespace collapsed", pb.query === "Jane Roe Tallow Robotics", String(pb.query));
  check("people search: category people", pb.category === "people");
  check("people search: excludeDomains not sent", !("excludeDomains" in pb));
  check("people search: startPublishedDate not sent", !("startPublishedDate" in pb));
  check("people search: asks for extra results to filter locally", pb.numResults === 5, String(pb.numResults));
  check(
    "people search: text cap and highlights requested",
    JSON.stringify(pb.contents) === JSON.stringify({ text: { maxCharacters: 700 }, highlights: true }),
    JSON.stringify(pb.contents),
  );
  const pr = people.value ?? [];
  check("people search: no error", people.error === null, errText(people.error));
  check(
    "people search: excluded domain, old date, bad URL and duplicate dropped",
    pr.length === 2 && pr[0].url === "https://linkedin.com/in/jane-roe" && pr[1].url === "https://scholar.example/jane",
    pr.map((r) => r.url).join(", "),
  );
  const h0 = pr[0]?.highlights[0] ?? "";
  check("people search: profile entity line comes first", h0.startsWith("Profile data (Exa): Jane Roe, Seattle"), snip(h0, 120));
  check("people search: current role listed first", h0.includes("Roles: Head of Robot Learning at Tallow Robotics (2024-03 to now); Research Intern"), snip(h0, 200));
  check("people search: education included", h0.includes("Education: PhD Computer Science, Stanford University (2016 to 2021)"));
  check("people search: highlight that repeats the text opening dropped", pr[0]?.highlights.length === 1, String(pr[0]?.highlights.length));
  check("people search: dates normalised", pr[0]?.publishedDate === "2026-10-01T00:00:00.000Z" && pr[1]?.publishedDate === null);

  // Company: dates are refused for company too; news keeps them, as a full ISO date-time.
  const company = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaSearch("Acme official website", { category: "company", startPublishedDate: "2025-01-01" }));
  check("company search: startPublishedDate not sent", company.seen.length === 1 && !("startPublishedDate" in (company.seen[0].body ?? {})));
  const news = await withStub(
    () => ({ status: 200, body: { results: [] } }),
    () => exaSearch("Acme news", { category: "news", startPublishedDate: "2025-11-23", excludeDomains: ["linkedin.com"], numResults: 50 }),
  );
  const nb = news.seen[0]?.body ?? {};
  check("news search: date sent as ISO date-time", nb.startPublishedDate === "2025-11-23T00:00:00.000Z", String(nb.startPublishedDate));
  check("news search: excludeDomains sent", JSON.stringify(nb.excludeDomains) === '["linkedin.com"]');
  check("news search: numResults capped at 10", nb.numResults === 10, String(nb.numResults));
  const paper = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaSearch("VLA benchmarks", { category: "research paper" }));
  check("'research paper' is sent as Exa's 'publication'", paper.seen[0]?.body?.category === "publication");

  // A filter Exa newly refuses for a category: retried once without it, applied locally.
  let n = 0;
  const heal = await withStub(
    (req) => {
      n++;
      if (req.body && "excludeDomains" in req.body) {
        return {
          status: 400,
          body: {
            requestId: "r2",
            error: "Invalid request body | The news category does not support the following filters: excludeDomains. These categories use dedicated indices that only support semantic search.",
            tag: "INVALID_REQUEST_BODY",
          },
        };
      }
      return { status: 200, body: { results: [exaResult({ url: "https://linkedin.com/posts/1" }), exaResult({ url: "https://news.example/1" })] } };
    },
    () => exaSearch("Acme news", { category: "news", excludeDomains: ["linkedin.com"], numResults: 3 }),
  );
  check("self-heal: retried once without the refused filter", n === 2 && heal.error === null, `${n} calls, ${errText(heal.error)}`);
  check("self-heal: refused filter applied locally", heal.value?.length === 1 && heal.value[0].url === "https://news.example/1");

  const bad = await withStub(
    () => ({ status: 400, body: { requestId: "r3", error: "Invalid request body | query too long", tag: "INVALID_REQUEST_BODY" } }),
    () => exaSearch("x", {}),
  );
  check("other 400: one call, clear ExaError", bad.seen.length === 1 && bad.error instanceof ExaError && /rejected the search request \(400 INVALID_REQUEST_BODY\): Invalid request body/.test(errText(bad.error)), errText(bad.error));

  const noQuery = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaSearch("   "));
  check("empty query: throws before any call", noQuery.error instanceof ExaError && noQuery.seen.length === 0);
  const badDate = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaSearch("x", { startPublishedDate: "last year" }));
  check("invalid date: throws before any call", badDate.error instanceof ExaError && badDate.seen.length === 0, errText(badDate.error));

  // Relaxed quotes: Exa found nothing with the quoted name and searched without the quotes.
  const relaxed = await withStub(
    () => ({
      status: 200,
      body: {
        results: [
          exaResult({ url: "https://talks.example/1", title: "Robot learning talk", text: "A keynote by Jane Roe on VLAs." }),
          exaResult({ url: "https://talks.example/2", title: "Another robotics talk", text: "By someone else entirely." }),
        ],
        notices: [{ code: "RESTRICTIONS_RELAXED", path: "/query", message: "No results matched the quoted phrase." }],
      },
    }),
    () => exaSearch('"Jane Roe" Tallow talk OR podcast', { numResults: 5 }),
  );
  check("relaxed quotes: keeps only results that mention the quoted name", relaxed.value?.length === 1 && relaxed.value[0].url === "https://talks.example/1");

  // Warnings are logged once per code and path.
  const warned: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.map(String).join(" "));
  const warnReply = () => ({ status: 200, body: { results: [], warnings: [{ code: "IGNORED_FIELD", path: "/startCrawlDate", message: "startCrawlDate is ignored." }] } });
  await withStub(warnReply, () => exaSearch("a"));
  await withStub(warnReply, () => exaSearch("b"));
  console.warn = realWarn;
  check("warnings logged once", warned.length === 1 && warned[0].includes("IGNORED_FIELD"), warned.join(" | "));

  // Contents: text only, URLs cleaned and deduped, per-URL failures are not errors, input order kept.
  const contents = await withStub(
    () => ({
      status: 200,
      body: {
        results: [
          { id: "https://b.example/2", url: "https://b.example/2", title: "B", text: "Page B text" },
          { id: "https://a.example/1", url: "https://a.example/1", title: "A", text: "Page A text" },
        ],
        statuses: [
          { id: "https://a.example/1", status: "success", source: "cached" },
          { id: "https://b.example/2", status: "success", source: "crawled" },
          { id: "https://c.example/404", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
        ],
      },
    }),
    () => exaContents(["https://a.example/1", "https://a.example/1/", "javascript:alert(1)", "not a url", "https://b.example/2", "https://c.example/404"], { textChars: 3000 }),
  );
  const cb = contents.seen[0]?.body ?? {};
  check("contents: POST /contents", contents.seen[0]?.url.href === "https://api.exa.ai/contents");
  check("contents: URLs cleaned and deduped", JSON.stringify(cb.urls) === JSON.stringify(["https://a.example/1", "https://b.example/2", "https://c.example/404"]), JSON.stringify(cb.urls));
  check("contents: text only, capped", JSON.stringify(cb.text) === '{"maxCharacters":3000}' && !("highlights" in cb));
  check("contents: failed URL skipped, input order kept", contents.value?.map((r) => r.title).join(",") === "A,B", contents.value?.map((r) => r.title).join(","));
  const none = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaContents(["nope"]));
  check("contents: no valid URL means no call", none.value?.length === 0 && none.seen.length === 0);

  check(
    "entitySummary: company line",
    entitySummary([
      {
        type: "company",
        properties: {
          name: "Acme Robotics",
          foundedYear: 2022,
          workforce: { total: 140 },
          headquarters: { address: null, city: "Oakland", postalCode: null, country: "United States" },
          financials: { revenueAnnual: null, fundingTotal: 72_500_000, fundingLatestRound: { name: "Series B", date: "2026-04-02", amount: 50_000_000 } },
        },
      },
    ]) ===
      "Company data (Exa): Acme Robotics, founded 2022, about 140 employees, based in Oakland, United States. Funding: $72.5M raised in total; latest round Series B, $50M, 2026-04.",
  );
  check("entitySummary: unknown shapes are ignored", entitySummary("x") === null && entitySummary([{ type: "person" }]) === null);
}

// ---- offline: Hugging Face ------------------------------------------------------------------
async function offlineHub(): Promise<void> {
  console.log("\n== Hugging Face, offline");
  check("hubQuery strips a legal suffix", hubQuery("Black Forest Labs, Inc.") === "Black Forest Labs");
  check("hubQuery strips stacked suffixes", hubQuery("Foo Pte. Ltd.") === "Foo");
  check("hubQuery keeps a person's name", hubQuery("Ranjay Krishna") === "Ranjay Krishna");
  check("hubQuery takes a domain's first label", hubQuery("https://www.allenai.org/about") === "allenai");
  check("hubQuery takes a Hub URL's account", hubQuery("https://huggingface.co/lerobot/pi05_base") === "lerobot");
  check("hubQuery refuses blanks", hubQuery("  ") === null && hubQuery(undefined) === null);
  check("servedBaseOf is case-insensitive and canonical", servedBaseOf("LEROBOT/PI05_BASE") === "lerobot/pi05_base" && servedBaseOf("acme/x") === null);

  const refs = baseRefs(
    {
      baseModels: { relation: "finetune", models: [{ _id: "1", id: "allenai/MolmoAct2-BimanualYAM" }] },
      cardData: { base_model: ["allenai/molmoact2-bimanualyam", "not a repo id", "acme/self"] },
    },
    ["robotics", "base_model:allenai/MolmoAct2-BimanualYAM", "base_model:quantized:acme/other"],
    "acme/self",
  );
  check(
    "baseRefs merges the three sources, keeps relations, drops itself and junk",
    JSON.stringify(refs) === JSON.stringify([{ id: "allenai/MolmoAct2-BimanualYAM", relation: "finetune" }, { id: "acme/other", relation: "quantized" }]),
    JSON.stringify(refs),
  );

  const models = await withStub(
    () => ({
      status: 200,
      body: [
        { id: "acme/plain", lastModified: "2026-11-20T00:00:00.000Z", downloads: 5, likes: 1, tags: ["robotics"] },
        { id: "acme/yam-ft", lastModified: "2026-11-19T00:00:00.000Z", downloads: 9, tags: ["base_model:allenai/MolmoAct2-BimanualYAM", "base_model:finetune:allenai/MolmoAct2-BimanualYAM"] },
        { id: "acme/yam-ft-v2", lastModified: "2026-11-18T00:00:00.000Z", tags: ["base_model:finetune:acme/yam-ft"] },
        { id: "acme/pi05-int4", tags: ["base_model:quantized:lerobot/pi05_base"], baseModels: { relation: "quantized", models: [{ id: "lerobot/pi05_base" }] } },
        { id: "acme/card-only", tags: [], cardData: { base_model: "LEROBOT/PI05_BASE" } },
        { id: "allenai/MolmoAct2-BimanualYAM", tags: ["base_model:finetune:allenai/MolmoAct2"] },
        { id: "no-slash" },
        "junk",
        { id: "acme/oldest", tags: [] },
      ],
    }),
    () => getHubModels("https://huggingface.co/acme", 6),
  );
  const q = models.seen[0]?.url;
  check("models: GET /api/models for the account", q?.pathname === "/api/models" && q.searchParams.get("author") === "acme");
  check("models: newest first, up to 100 read", q?.searchParams.get("sort") === "lastModified" && q.searchParams.get("direction") === "-1" && q.searchParams.get("limit") === "100");
  check("models: expands the fields it maps", q?.searchParams.getAll("expand[]").join(",") === "lastModified,downloads,likes,tags,baseModels,cardData", q?.searchParams.getAll("expand[]").join(","));
  const m = models.value ?? [];
  const served = Object.fromEntries(m.map((x) => [x.id, x.servedBase]));
  check("models: limit applied, junk rows skipped", m.length === 6 && !m.some((x) => x.id === "acme/oldest"), m.map((x) => x.id).join(", "));
  check("models: fine-tune of a served base flagged", served["acme/yam-ft"] === "allenai/MolmoAct2-BimanualYAM");
  check("models: fine-tune of that fine-tune inherits it", served["acme/yam-ft-v2"] === "allenai/MolmoAct2-BimanualYAM");
  check("models: card-only base found, canonical casing", served["acme/card-only"] === "lerobot/pi05_base");
  check("models: a quantized copy is not a fine-tune", m.find((x) => x.id === "acme/pi05-int4")?.servedBase == null);
  check("models: the served base itself is not 'a fine-tune of' itself", served["allenai/MolmoAct2-BimanualYAM"] === null);
  check("models: served-base fine-tunes listed first", m.slice(0, 3).every((x) => x.servedBase), m.map((x) => x.id).join(", "));
  check("models: URL, counts, dates mapped", m.find((x) => x.id === "acme/yam-ft")?.url === "https://huggingface.co/acme/yam-ft" && m.find((x) => x.id === "acme/yam-ft")?.downloads === 9);

  const ds = await withStub(
    () => ({
      status: 200,
      body: [
        { id: "acme/text-corpus", lastModified: "2026-11-20T00:00:00.000Z", tags: ["task_categories:text-generation"] },
        { id: "acme/yam-towels", lastModified: "2026-11-10T00:00:00.000Z", tags: ["LeRobot", "task_categories:robotics"] },
      ],
    }),
    () => getHubDatasets("acme", 20),
  );
  check("datasets: robotics first, dataset URLs", ds.value?.[0]?.id === "acme/yam-towels" && ds.value?.[0]?.url === "https://huggingface.co/datasets/acme/yam-towels");
  check("datasets: only the mapped fields expanded", ds.seen[0]?.url.searchParams.getAll("expand[]").join(",") === "lastModified,tags");
  const badId = await withStub(() => ({ status: 200, body: [] }), () => getHubModels("../etc", 5));
  check("models: invalid account id throws before any call", badId.error instanceof Error && badId.seen.length === 0);

  // Search: one shorter retry when the full name finds nothing.
  const search = await withStub(
    (req) =>
      req.url.searchParams.get("q") === "1X"
        ? { status: 200, body: { orgs: [{ _id: "1", name: "1x-technologies", fullname: "1X" }], users: [{ user: "1x", fullname: "1" }] } }
        : { status: 200, body: { orgs: [], users: [] } },
    () => searchHubAccounts("1X Technologies, Inc."),
  );
  const sq = search.seen.map((s) => s.url.searchParams.get("q"));
  check("search: full name first, then without descriptors", sq.join(" | ") === "1X Technologies | 1X", sq.join(" | "));
  check("search: orgs and users in one call each", search.seen[0]?.url.searchParams.getAll("type").join(",") === "org,user" && search.seen[0]?.url.searchParams.get("limit") === "10");
  check(
    "search: accounts mapped, orgs first",
    JSON.stringify(search.value) ===
      JSON.stringify([
        { id: "1x-technologies", type: "org", url: "https://huggingface.co/1x-technologies", fullName: "1X" },
        { id: "1x", type: "user", url: "https://huggingface.co/1x", fullName: "1" },
      ]),
  );
  const server = await withStub(() => ({ status: 502, text: "<html>bad gateway</html>" }), () => searchHubAccounts("allenai"));
  check("5xx: retried once, then a clear HttpError", server.seen.length === 2 && /HTTP 502 from huggingface\.co/.test(errText(server.error)), errText(server.error));

  // Optional HF_TOKEN: anonymous without it, a bearer token with it (dummy value, fetch stubbed).
  const hadToken = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  const anon = await withStub(() => ({ status: 200, body: [] }), () => getHubDatasets("acme", 1));
  check("no HF_TOKEN: anonymous request", anon.seen.length === 1 && !anon.seen[0].headers.has("authorization"));
  process.env.HF_TOKEN = "hf_test_dummy_not_a_real_token";
  const authed = await withStub(() => ({ status: 200, body: [] }), () => getHubDatasets("acme", 1));
  check("HF_TOKEN: sent as a bearer token", (authed.seen[0]?.headers.get("authorization") ?? "").startsWith("Bearer "));
  check("HF_TOKEN: status says so", /Uses HF_TOKEN/.test(hubStatus().detail));
  if (hadToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = hadToken;
}

// ---- offline: Abstract inspect --------------------------------------------------------------
const INSPECTION = {
  object: "checkpoint.inspection",
  checkpoint_uri: "hf://acme/yam-towels@1234567890abcdef1234567890abcdef12345678",
  repository: "acme/yam-towels",
  revision: "1234567890abcdef1234567890abcdef12345678",
  servable: true,
  pipeline: "molmoact2",
  model: "allenai/molmoact2",
  options: { norm_tag: "yam_towels" },
  contract: { embodiment: "bimanual_yam", action_space: "ee_6d_position", cameras: ["top", "left", "right"], frame_size: [640, 360], state_dim: 14, action_dim: 14, action_horizon: 30, control_hz: 30, matches: true },
  memory: { estimated_vram_gib: 13, basis: "parameters", parameters: 5442196272, weight_bytes: 21768955912 },
  gpus: [{ type: "H100", vram_gib: 80, fits: true }],
  pricing: { model: "allenai/molmoact2", basis: "base_lane", input_usd_per_million: 0.5, cached_input_usd_per_million: 0.05, output_usd_per_million: 1.4 },
  problems: [],
  cached: false,
};
const abstractError = (status: number, code: string, message: string) => ({
  status,
  body: { error: { message, type: "invalid_request_error", param: null, code, retryable: status === 503, retry_after_s: null, request_id: `req_${"0".repeat(32)}` } },
});

async function offlineAbstract(): Promise<void> {
  console.log("\n== Abstract inspect, offline");
  check("URI from a repo id", toCheckpointUri("acme/yam-towels") === "hf://acme/yam-towels@main");
  check("URI keeps a revision", toCheckpointUri("hf://acme/yam-towels@v2") === "hf://acme/yam-towels@v2");
  check("URI adds main to hf:// without one", toCheckpointUri("hf://acme/yam-towels") === "hf://acme/yam-towels@main");
  check("URI from a Hub URL with a branch", toCheckpointUri("https://huggingface.co/acme/yam-towels/tree/dev") === "hf://acme/yam-towels@dev");
  check("URI refuses datasets, Spaces and junk", [toCheckpointUri("https://huggingface.co/datasets/acme/x"), toCheckpointUri("acme"), toCheckpointUri("a/b/c"), toCheckpointUri("acme/x@bad rev")].every((v) => v === null));

  const hadKey = process.env.ABSTRACT_API_KEY;
  if (hadKey) {
    console.log("note: ABSTRACT_API_KEY is set; skipping the no-key checks");
  } else {
    const noKey = await withStub(() => ({ status: 500 }), () => inspectCheckpoint("acme/yam-towels"));
    check("no key: configured false", noKey.value?.configured === false && noKey.value.servable === null);
    check("no key: no network call", noKey.seen.length === 0);
    check("no key: status off", abstractStatus().configured === false, abstractStatus().detail);
  }

  // A dummy key with fetch stubbed: nothing leaves this process.
  process.env.ABSTRACT_API_KEY = "test-dummy-not-a-real-key";
  try {
    const ok = await withStub(() => ({ status: 200, body: INSPECTION }), () => inspectCheckpoint("acme/yam-towels"));
    const req = ok.seen[0];
    check("request: POST to the inspect endpoint", req?.method === "POST" && req.url.href === "https://api.abstract.inc/v1/models/inspect");
    check("request: bearer auth header present", (req?.headers.get("authorization") ?? "").startsWith("Bearer "));
    check("request: API version pinned", req?.headers.get("abstract-version") === "2026-11-17");
    check("request: body is the checkpoint URI", JSON.stringify(req?.body) === '{"checkpoint_uri":"hf://acme/yam-towels@main"}');
    check(
      "servable answer mapped",
      JSON.stringify(ok.value) ===
        JSON.stringify({
          configured: true,
          servable: true,
          model: "allenai/molmoact2",
          problems: [],
          checkpointUri: "hf://acme/yam-towels@1234567890abcdef1234567890abcdef12345678",
          estimatedVramGib: 13,
        }),
      JSON.stringify(ok.value),
    );
    const no = mapInspection({
      ...INSPECTION,
      servable: false,
      model: null,
      memory: null,
      problems: [
        { code: "missing_norm_stats", message: "No norm_stats.json." },
        { code: "insufficient_vram", message: "Too big." },
      ],
    });
    check("not servable: problem codes listed", no.servable === false && no.problems.join(",") === "missing_norm_stats,insufficient_vram" && no.estimatedVramGib === null && !no.error);
    const derived = mapInspection({ problems: [] });
    check("servable derived from empty problems when the flag is missing", derived.servable === true && !derived.error);
    const odd = mapInspection("nope");
    check("unexpected answer: servable null with an error", odd.servable === null && Boolean(odd.error));

    const e400 = await withStub(() => abstractError(400, "invalid_checkpoint_uri", "That is not an hf:// URI."), () => inspectCheckpoint("acme/x"));
    check("400: error says why, never throws", e400.value?.configured === true && e400.value.servable === null && /400 invalid_checkpoint_uri/.test(e400.value.error ?? ""), e400.value?.error);
    const e401 = await withStub(() => abstractError(401, "invalid_api_key", "Invalid API key."), () => inspectCheckpoint("acme/x"));
    check("401: points at the key", /rejected the API key \(401 invalid_api_key\)/.test(e401.value?.error ?? ""), e401.value?.error);
    const e503 = await withStub(() => abstractError(503, "hub_unavailable", "The Hub could not be read."), () => inspectCheckpoint("acme/x"));
    check("503 hub_unavailable: retried once, then explained", e503.seen.length === 2 && /hub_unavailable/.test(e503.value?.error ?? ""), `${e503.seen.length} calls: ${e503.value?.error}`);
    const version = await withStub(
      (r) => (r.headers.has("abstract-version") ? abstractError(400, "unsupported_api_version", "Unsupported version.") : { status: 200, body: INSPECTION }),
      () => inspectCheckpoint("acme/yam-towels"),
    );
    check("retired API version: asks again unpinned", version.seen.length === 2 && version.value?.servable === true && !version.seen[1].headers.has("abstract-version"));
    const net = await withStub(() => new TypeError("fetch failed"), () => inspectCheckpoint("acme/x"));
    check("network error: explained, never throws", net.error === null && /Could not reach Abstract/.test(net.value?.error ?? ""), net.value?.error);
    const junk = await withStub(() => ({ status: 200, body: INSPECTION }), () => inspectCheckpoint("not a repo"));
    check("invalid repo id: no call, error", junk.seen.length === 0 && Boolean(junk.value?.error) && junk.value?.configured === true);
    check("status with a key: on", abstractStatus().configured === true);
  } finally {
    if (hadKey === undefined) delete process.env.ABSTRACT_API_KEY;
    else process.env.ABSTRACT_API_KEY = hadKey;
  }
}

// ---- live ----------------------------------------------------------------------------------
function show(label: string, results: ExaResult[]): void {
  console.log(`   ${label}: ${results.length} results`);
  for (const r of results.slice(0, 3)) {
    console.log(`   - ${snip(r.title, 70)} | ${r.url.slice(0, 80)} | ${r.publishedDate?.slice(0, 10) ?? "undated"}`);
    if (r.highlights[0]) console.log(`     highlight: ${snip(r.highlights[0], 110)}`);
  }
}

async function liveExa(): Promise<void> {
  console.log("\n== Exa, live");
  const status = exaStatus();
  check("status: configured", status.configured, status.detail);
  if (!status.configured || !EXA_LIVE) {
    console.log(`   skipped (${!status.configured ? "EXA_API_KEY not set" : "EXA_LIVE=0"})`);
    return;
  }

  // 1. People category for a public robotics researcher, with a domain exclusion Exa would refuse.
  try {
    const people = await exaSearch("Chelsea Finn Stanford Physical Intelligence robot learning professor", {
      category: "people",
      numResults: 3,
      textChars: 800,
      excludeDomains: ["x.com"],
    });
    show("people", people);
    check("people search with excludeDomains: no 400, results", people.length > 0);
    check("people search: nothing from the excluded domain", people.every((r) => !urlMatchesDomain(r.url, "x.com")));
    check("people search: names the person", people.some((r) => /chelsea finn/i.test(`${r.title} ${r.text}`)));
    check("people search: profile data line present", people.some((r) => r.highlights[0]?.startsWith("Profile data (Exa)")), snip(people[0]?.highlights[0], 120));
    check("people search: text capped", people.every((r) => (r.text?.length ?? 0) <= 800));
  } catch (err) {
    check("people search", false, errText(err));
  }

  // 2. Company news, last 12 months.
  let newsUrl: string | null = null;
  const since = monthsAgo(12);
  try {
    const news = await exaSearch("Physical Intelligence robotics company funding announcement", {
      category: "news",
      numResults: 3,
      textChars: 1000,
      startPublishedDate: since,
    });
    show(`news since ${since}`, news);
    check("news search: results", news.length > 0);
    check("news search: all on or after the start date", news.every((r) => !r.publishedDate || r.publishedDate.slice(0, 10) >= since));
    check("news search: highlights or text present", news.every((r) => r.highlights.length > 0 || Boolean(r.text)));
    newsUrl = news[0]?.url ?? null;
  } catch (err) {
    check("news search", false, errText(err));
  }

  // 3. Talks and interviews, the way the research pipeline asks: quoted name, LinkedIn excluded.
  try {
    const talks = await exaSearch('"Chelsea Finn" Physical Intelligence talk OR podcast OR interview', {
      numResults: 3,
      textChars: 800,
      excludeDomains: ["linkedin.com"],
    });
    show("talks", talks);
    check("talks search: results, none from LinkedIn", talks.length > 0 && talks.every((r) => !urlMatchesDomain(r.url, "linkedin.com")));
  } catch (err) {
    check("talks search", false, errText(err));
  }

  // 4. Contents for one URL found above.
  if (newsUrl) {
    try {
      const pages = await exaContents([newsUrl], { textChars: 1500 });
      console.log(`   contents: ${pages.length} page(s); ${pages[0]?.text?.length ?? 0} chars: ${snip(pages[0]?.text, 100)}`);
      check("contents: page text returned and capped", pages.length === 1 && Boolean(pages[0].text) && (pages[0].text?.length ?? 0) <= 1500);
    } catch (err) {
      check("contents", false, errText(err));
    }
  } else {
    check("contents: had a URL to read", false, "news search returned nothing");
  }
  console.log(`   Exa calls made: ${liveCalls.get("api.exa.ai") ?? 0}`);
}

async function liveHub(): Promise<void> {
  console.log("\n== Hugging Face, live");
  check("status: available without a key", hubStatus().configured, hubStatus().detail);
  try {
    const accounts = await searchHubAccounts("allenai");
    console.log(`   search "allenai": ${accounts.slice(0, 4).map((a) => `${a.id} (${a.type}${a.fullName ? `, ${a.fullName}` : ""})`).join("; ")}`);
    check("search: finds the allenai org", accounts.some((a) => a.id === "allenai" && a.type === "org" && a.url === "https://huggingface.co/allenai"));
    const bfl = await searchHubAccounts("Black Forest Labs, Inc.");
    check("search: a legal suffix does not hide the org", bfl.some((a) => a.id === "black-forest-labs"), bfl.slice(0, 3).map((a) => a.id).join(", "));

    const models = await getHubModels("allenai", 20);
    console.log(`   allenai models: ${models.length}; latest: ${models.slice(0, 3).map((x) => `${x.id} (${x.lastModified?.slice(0, 10)}, base: ${x.baseModels[0] ?? "none"})`).join("; ")}`);
    check("models: up to 20, all allenai", models.length > 0 && models.length <= 20 && models.every((x) => x.id.startsWith("allenai/")));
    check("models: dates, counts and URLs mapped", models.every((x) => x.url === `https://huggingface.co/${x.id}` && (x.lastModified === null || !Number.isNaN(Date.parse(x.lastModified)))));
    check("models: base models read for some", models.some((x) => x.baseModels.length > 0));

    const datasets = await getHubDatasets("allenai", 20);
    const robotics = datasets.filter((d) => d.tags.some((t) => /^(task_categories:)?robotics$|lerobot/i.test(t)));
    console.log(`   allenai datasets: ${datasets.length} (${robotics.length} robotics); first: ${datasets.slice(0, 3).map((d) => d.id).join(", ")}`);
    check("datasets: up to 20, dataset URLs", datasets.length > 0 && datasets.length <= 20 && datasets.every((d) => d.url === `https://huggingface.co/datasets/${d.id}`));
    check("datasets: robotics ones first", robotics.length === 0 || datasets.slice(0, robotics.length).every((d) => robotics.includes(d)));

    // A public account with real fine-tunes of two served bases (MolmoAct2-BimanualYAM, pi05_base).
    const fts = await getHubModels("ASethi04", 10);
    const flagged = fts.filter((x) => x.servedBase);
    console.log(`   ASethi04: ${fts.length} models, ${flagged.length} on served bases: ${[...new Set(flagged.map((x) => x.servedBase))].join(", ")}`);
    check("served bases: flagged on real fine-tunes", flagged.length > 0 && flagged.every((x) => SERVED_BASE_MODELS.includes(x.servedBase!)));
    check("served bases: listed first", fts.slice(0, flagged.length).every((x) => x.servedBase));
  } catch (err) {
    const limited = /429/.test(errText(err));
    check(limited ? "Hub live calls (rate-limited by Hugging Face; rerun in a few minutes)" : "Hub live calls", false, errText(err));
  }
  console.log(`   Hub calls made: ${liveCalls.get("huggingface.co") ?? 0}`);
}

async function liveAbstract(): Promise<void> {
  console.log("\n== Abstract inspect, live");
  if (process.env.ABSTRACT_API_KEY) {
    console.log("   ABSTRACT_API_KEY is set, but this script never calls Abstract live; skipped");
    return;
  }
  const r = await inspectCheckpoint("ASethi04/MolmoAct2-BimanualYAM-oranges-20k");
  check("no key: configured false, nothing called", r.configured === false && (liveCalls.get("api.abstract.inc") ?? 0) === 0, JSON.stringify(r));
}

// ---- checks that pause a provider: last, so they cannot block the live calls ---------------
async function pauses(): Promise<void> {
  console.log("\n== pause states, offline (run last)");
  // A rejected HF_TOKEN: the call is retried anonymously and later calls stay anonymous.
  const hadToken = process.env.HF_TOKEN;
  process.env.HF_TOKEN = "hf_test_dummy_not_a_real_token";
  const rejected = await withStub(
    (req) => (req.headers.has("authorization") ? { status: 401, body: { error: "Invalid credentials in Authorization header" } } : { status: 200, body: [] }),
    () => getHubDatasets("acme", 1),
  );
  check(
    "Hub 401 on HF_TOKEN: retried anonymously, no error",
    rejected.error === null && rejected.seen.length === 2 && rejected.seen[0].headers.has("authorization") && !rejected.seen[1].headers.has("authorization"),
    errText(rejected.error),
  );
  check("Hub 401 on HF_TOKEN: status says so", /HF_TOKEN was rejected \(401\)/.test(hubStatus().detail), hubStatus().detail);
  const next = await withStub(() => ({ status: 200, body: [] }), () => getHubDatasets("acme", 1));
  check("Hub 401 on HF_TOKEN: later calls go anonymous", next.seen.length === 1 && !next.seen[0].headers.has("authorization"));
  if (hadToken === undefined) delete process.env.HF_TOKEN;
  else process.env.HF_TOKEN = hadToken;

  const limited = await withStub(
    () => ({ status: 429, body: { error: "We had to rate limit your IP." }, headers: { ratelimit: '"api";r=0;t=42', "ratelimit-policy": '"fixed window";"api";q=500;w=300' } }),
    () => getHubModels("acme", 5),
  );
  check("Hub 429: no retry, clear error", limited.seen.length === 1 && /rate-limiting this server's IP/.test(errText(limited.error)), errText(limited.error));
  const status = hubStatus();
  check("Hub 429: status off with the reason", status.configured === false && /Back in 4\d s/.test(status.detail), status.detail);
  const after = await withStub(() => ({ status: 200, body: [] }), () => getHubDatasets("acme", 5));
  check("Hub 429: later calls fail fast without a request", after.seen.length === 0 && after.error instanceof Error);

  const key = await withStub(() => ({ status: 401, body: { requestId: "r9", error: "Invalid API key", tag: "INVALID_API_KEY" } }), () => exaSearch("x"));
  check("Exa 401: clear error", key.error instanceof ExaError && /rejected the API key \(401 INVALID_API_KEY\)/.test(errText(key.error)), errText(key.error));
  check("Exa 401: status explains the pause", /Calls resume in about 10 min/.test(exaStatus().detail), exaStatus().detail);
  const blocked = await withStub(() => ({ status: 200, body: { results: [] } }), () => exaContents(["https://a.example"]));
  check("Exa 401: later calls fail fast without a request", blocked.seen.length === 0 && blocked.error instanceof ExaError);
}

async function main(): Promise<void> {
  // The offline Exa checks need some key to get past the config check; fetch is stubbed there.
  const realExaKey = process.env.EXA_API_KEY;
  if (!realExaKey) process.env.EXA_API_KEY = "test-dummy-not-a-real-key";
  await offlineExa();
  if (!realExaKey) delete process.env.EXA_API_KEY;
  await offlineHub();
  await offlineAbstract();
  await liveExa();
  await liveHub();
  await liveAbstract();
  if (!realExaKey) process.env.EXA_API_KEY = "test-dummy-not-a-real-key";
  await pauses();
  if (!realExaKey) delete process.env.EXA_API_KEY;
  console.log(`\nlive calls: ${[...liveCalls].map(([h, c]) => `${h} ${c}`).join(", ") || "none"}`);
  console.log(failures ? `${failures} check(s) failed` : "all checks passed");
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error("test crashed:", errText(err));
  process.exit(1);
});
