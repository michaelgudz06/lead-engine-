/**
 * Test for the X provider: Grok with X search through OpenRouter (src/lib/providers/xsearch.ts).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-x.ts
 *   NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-x.ts --live
 *
 * Offline (free, always): reply parsing, handle checks, post cleaning, request building, error
 * mapping, retries and caching, with fetch stubbed out. Nothing leaves the machine.
 * Live (--live only): findXHandle for a well-known robotics researcher, then getXPosts for the
 * handle it finds, with the arguments the research pipeline uses. X search is billed per post and
 * per profile fetched, so a fetch guard refuses any OpenRouter request beyond 4 (retries included).
 * --live --handle=pabbeel skips the lookup and only reads posts (one request).
 *
 * Prints statuses, short snippets and usage numbers only: never keys or request headers.
 */
import {
  __xsearchTest as t,
  findXHandle,
  getXPosts,
  recentXCalls,
  xStatus,
  type XCallInfo,
} from "../src/lib/providers/xsearch";

const LIVE = process.argv.includes("--live");
/** --handle=<h>: skip findXHandle in the live run and read this handle's posts only. */
const GIVEN_HANDLE = process.argv.find((a) => a.startsWith("--handle="))?.slice("--handle=".length) || null;
const MAX_OPENROUTER_CALLS = 4;

// ---- fetch guard: no OpenRouter request without --live, and never more than 4 ---------------
const realFetch = globalThis.fetch;
let openRouterCalls = 0;
const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const host = new URL(hrefOf(input)).host;
  if (host === "openrouter.ai" || host.endsWith(".openrouter.ai")) {
    if (!LIVE) throw new Error("test guard: OpenRouter requests need --live");
    if (openRouterCalls >= MAX_OPENROUTER_CALLS) {
      throw new Error(`test guard: refused OpenRouter request #${openRouterCalls + 1} (max ${MAX_OPENROUTER_CALLS})`);
    }
    openRouterCalls++;
  }
  return realFetch(input, init);
}) as typeof fetch;
globalThis.fetch = guardedFetch;

function hrefOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

interface Seen {
  url: string;
  method: string;
  body: Record<string, unknown>;
  hasBearer: boolean;
}
type StubReply = { status: number; body: unknown } | { throws: unknown };

/** Runs fn with fetch answering from `replies` in order (the last one repeats). No network. */
async function withStub<T>(replies: StubReply[], fn: (seen: Seen[]) => Promise<T>): Promise<T> {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: hrefOf(input),
      method: init?.method ?? "GET",
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      hasBearer: /^Bearer \S+$/.test(headers.get("authorization") ?? ""),
    });
    const reply = replies[Math.min(seen.length - 1, replies.length - 1)];
    if ("throws" in reply) throw reply.throws;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = guardedFetch;
  }
}

// ---- tiny test harness ----------------------------------------------------------------------
let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passes++;
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    const d = detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
    console.log(`  FAIL  ${name}${d.slice(0, 400)}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}
function snippet(s: string | null | undefined, max = 120): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- fixtures ---------------------------------------------------------------------------------
const DAY = 86_400_000;
const EPOCH = 1288834974657;
/** A real-shaped status id for a moment in time (ids encode their posting time). */
const idAt = (ms: number) => ((BigInt(ms) - BigInt(EPOCH)) << BigInt(22)).toString();
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function completion(content: unknown, extra: Record<string, unknown> = {}, finish = "stop") {
  return {
    id: "gen-test",
    object: "chat.completion",
    created: 1,
    model: "x-ai/grok-4.7",
    provider: "xAI",
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content, ...extra } }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 300,
      total_tokens: 1500,
      cost: 0.0123,
      completion_tokens_details: { reasoning_tokens: 120 },
      server_tool_use_details: { web_search_requests: 2 },
    },
  };
}

const PERSON = {
  name: "Pieter Abbeel",
  company: "Covariant",
  title: "Professor at UC Berkeley; co-founder of Covariant",
  hints: ["https://people.eecs.berkeley.edu/~pabbeel/"],
};
const GATHER_FOCUS =
  "robotics, robot models, ML inference, GPUs, infrastructure, hiring, product and company announcements";

// ---- offline ---------------------------------------------------------------------------------
async function offline(): Promise<void> {
  section("Status");
  const st = xStatus();
  console.log(`  ${st.label}: configured=${st.configured} | ${st.detail}`);
  check("status has id x and a one-line detail", st.id === "x" && typeof st.detail === "string" && !st.detail.includes("\n"));
  const key = process.env.OPENROUTER_API_KEY ?? "";
  check("status detail never contains the key", !key || !st.detail.includes(key));

  section("Handles");
  check("@handle", t.normaliseHandle("@pabbeel") === "pabbeel");
  check("x.com URL", t.normaliseHandle("https://x.com/pabbeel") === "pabbeel");
  check("twitter.com status URL", t.normaliseHandle("https://twitter.com/pabbeel/status/123") === "pabbeel");
  check("reserved path rejected", t.normaliseHandle("x.com/home") === null && t.normaliseHandle("https://x.com/i/status/1") === null);
  check("spaces and >15 chars rejected", t.normaliseHandle("foo bar") === null && t.normaliseHandle("abcdefghijklmnop") === null);
  check("non-strings rejected", t.normaliseHandle(42) === null && t.normaliseHandle("") === null);

  section("JSON from model text");
  check("plain", eq(t.parseJsonReply('{"a":1}'), { a: 1 }));
  check("code fence", eq(t.parseJsonReply('Sure:\n```json\n{"a": [1, 2]}\n```\nDone.'), { a: [1, 2] }));
  check("prose around", eq(t.parseJsonReply('Here you go: {"handle": "x"} hope it helps'), { handle: "x" }));
  check("trailing commas", eq(t.parseJsonReply('{"posts": [{"text": "a",},],}'), { posts: [{ text: "a" }] }));
  check("braces inside strings", eq(t.parseJsonReply('x {"text": "a } b { c", "n": 2} y'), { text: "a } b { c", n: 2 }));
  check("objects win over [1] markers", eq(t.parseJsonReply('See [1] and {"ok": true}'), { ok: true }));
  check("array of objects", eq(t.parseJsonReply('[{"handle": "a"}]'), [{ handle: "a" }]));
  check("garbage and empty give undefined", t.parseJsonReply("no json here") === undefined && t.parseJsonReply("  ") === undefined);
  const cut = '{"posts": [{"url": "u1", "text": "one"}, {"url": "u2", "text": "two {x}"}, {"url": "u3", "te';
  check("salvages complete items from a cut-off reply", eq(t.salvageArray(cut, "posts").map((p) => p.text), ["one", "two {x}"]));

  section("Dates");
  check("status id carries its date", isoDay(t.snowflakeMs("1585841080431321088")!) === "2022-10-28");
  check("id round trip", t.snowflakeMs(idAt(Date.UTC(2026, 9, 1, 12))) === Date.UTC(2026, 9, 1, 12));
  check("short ids are not snowflakes", t.snowflakeMs("20") === null);
  const now = Date.UTC(2026, 10, 23, 12);
  check("YYYY-MM-DD", t.toDay("2026-11-02", now) === "2026-11-02");
  check("timestamp", t.toDay("2026-11-02T22:10:00Z", now) === "2026-11-02");
  check("month name", t.toDay("Nov 2, 2026", now) === "2026-11-02");
  check("slashes", t.toDay("2026/11/02", now) === "2026-11-02");
  check("impossible, vague and future dates are null", [t.toDay("2026-02-31", now), t.toDay("2026", now), t.toDay("2027-01-05", now), t.toDay("yesterday", now)].every((d) => d === null));
  const nowDate = new Date(now);
  check("window defaults to 6 months", t.windowStart(undefined, nowDate) === "2026-05-23");
  check("window keeps a given day (date part only)", t.windowStart("2026-09-01T12:00:00Z", nowDate) === "2026-09-01");
  check("window ignores a future day", t.windowStart("2027-01-01", nowDate) === "2026-05-23");
  check("window is clamped to 12 months", t.windowStart("2020-01-01", nowDate) === "2025-11-23");

  section("Posts cleaning");
  const inWindow = (daysBack: number) => now - daysBack * DAY;
  const items = [
    { url: `https://x.com/i/status/${idAt(inWindow(10))}`, text: "Older own post, Grok got the date wrong [[1]](https://x.com/a)", postedAt: "2026-01-01" },
    { url: `https://x.com/someone_else/status/${idAt(inWindow(5))}`, text: "Not theirs", postedAt: isoDay(inWindow(5)) },
    { url: `https://x.com/pabbeel/status/${idAt(now + 30 * DAY)}`, text: "Impossible id", postedAt: null },
    { url: null, text: "Too old", postedAt: "2025-01-01" },
    { url: null, text: "RT @someone: reposted", postedAt: isoDay(inWindow(3)) },
    { url: `https://twitter.com/PAbbeel/status/${idAt(inWindow(10))}`, text: "Duplicate id", postedAt: null },
    { text: "No url or date" },
    { link: `https://x.com/pabbeel/status/${idAt(inWindow(1))}`, content: "Newest  post,\n with odd   spacing", date: isoDay(inWindow(1)) },
    "not an object",
  ];
  const cleaned = t.cleanPosts(items, "pabbeel", { from: "2026-05-23", maxPosts: 15, now });
  check("keeps own in-window posts only", cleaned.posts.length === 3, cleaned.posts);
  check("newest first, undated last", eq(cleaned.posts.map((p) => p.text.slice(0, 6)), ["Newest", "Older ", "No url"]));
  check("date comes from the status id", cleaned.posts[1]?.postedAt === isoDay(inWindow(10)));
  check("canonical URLs", cleaned.posts[0]?.url === `https://x.com/pabbeel/status/${idAt(inWindow(1))}` && cleaned.posts[1]?.url?.startsWith("https://x.com/pabbeel/status/") === true);
  check("citation markers and whitespace cleaned", cleaned.posts[1]?.text === "Older own post, Grok got the date wrong" && cleaned.posts[0]?.text === "Newest post, with odd spacing");
  check("dropped count", cleaned.dropped === 6, cleaned.dropped);
  check("maxPosts caps the list", t.cleanPosts(items, "pabbeel", { from: "2026-05-23", maxPosts: 2, now }).posts.length === 2);

  section("Handle checks");
  const judge = (reply: Record<string, unknown>) => t.judgeHandle({ ...PERSON }, t.readHandleReply(reply)!);
  // Without known links, so the handle cannot also match the ~pabbeel page and get verified that way.
  const judgeNoLinks = (reply: Record<string, unknown>) => t.judgeHandle({ ...PERSON, hints: [] }, t.readHandleReply(reply)!);
  const strong = judge({ handle: "@pabbeel", displayName: "Pieter Abbeel", bio: "Professor UC Berkeley | Co-Founder Covariant.ai | Host The Robot Brains Podcast", matchedOn: ["name", "company"], evidence: "Bio names Covariant and UC Berkeley.", confidence: 0.6 });
  check("bio names the company: accepted, lifted to >= 0.8", strong.handle === "pabbeel" && strong.confidence >= 0.8, strong);
  const nameOnly = judge({ handle: "pieter_abbeel_x", displayName: "Pieter Abbeel", bio: "Coffee and cycling", matchedOn: ["name"], confidence: 0.5 });
  check("name only: rejected", nameOnly.handle === null && /only the name/.test(nameOnly.evidence ?? ""), nameOnly);
  const companyAcct = judge({ handle: "CovariantAI", displayName: "Covariant", bio: "Robotics foundation models", matchedOn: ["company"], confidence: 0.9 });
  check("company account: rejected", companyAcct.handle === null, companyAcct);
  const parody = judge({ handle: "notpabbeel", displayName: "Pieter Abbeel (parody)", bio: "Parody. Covariant", matchedOn: ["name", "company"], confidence: 0.9 });
  check("parody: rejected", parody.handle === null, parody);
  const claimed = judgeNoLinks({ handle: "pabbeel", displayName: "Pieter Abbeel", bio: "AI researcher", matchedOn: ["name", "posts"], confidence: 0.95 });
  check("tie only claimed by Grok: accepted, capped at 0.8", claimed.handle === "pabbeel" && claimed.confidence === 0.8, claimed);
  const linked = judge({ handle: "pabbeel", displayName: "P. Abbeel", bio: null, profileLink: "people.eecs.berkeley.edu/~pabbeel", matchedOn: ["name", "link"], confidence: 0.9 });
  check("profile links to a known page: accepted", linked.handle === "pabbeel" && linked.confidence >= 0.8, linked);
  const doubtful = judge({ handle: "pabbeel", displayName: "Pieter Abbeel", bio: "robots", matchedOn: ["posts"], confidence: 0.2 });
  check("Grok doubts it (0.2): rejected", doubtful.handle === null, doubtful);
  const none = judge({ handle: null, evidence: "No account found.", confidence: 0 });
  check("no account: evidence passes through", none.handle === null && none.evidence === "No account found.");
  const sameUser = judge({ handle: "pabbeel", displayName: "Pieter Abbeel", bio: "Professor at Berkeley & Amazon. Host of The Robot Brains Podcast", matchedOn: ["name", "title", "link"], evidence: "Handle matches his Berkeley page path.", confidence: 0.9 });
  check("handle is their username on a known page: verified, not capped", sameUser.handle === "pabbeel" && sameUser.confidence === 0.9, sameUser);
  check("username tie skips short names", t.sharedUsername("pab", ["https://github.com/pab"]) === null);
  check("username tie via LinkedIn slug", t.sharedUsername("jane_doe", ["https://www.linkedin.com/in/jane-doe"]) === "linkedin.com");
  check("username tie needs the same name", t.sharedUsername("pabbeel", ["https://github.com/someone"]) === null);
  const titleOnly = judgeNoLinks({ handle: "pabbeel", displayName: "Pieter Abbeel", bio: "Berkeley & Amazon", matchedOn: ["name"], confidence: 0.9 });
  check("affiliation from the title in the bio: accepted, capped at 0.8", titleOnly.handle === "pabbeel" && titleOnly.confidence === 0.8, titleOnly);
  const many = t.readHandleReply([{ handle: "a", confidence: 0.2 }, { handle: "b", confidence: "85" }]);
  check("candidate list: most confident wins, percent read", many?.handle === "b" && many.confidence === 0.85, many);
  check('"null" as a string is no handle', t.readHandleReply({ handle: "null" })?.handle === null);
  check("name: display name", t.nameMatches("Pieter Abbeel", "Pieter Abbeel", "x") === true);
  check("name: handle with initial", t.nameMatches("Pieter Abbeel", null, "pabbeel") === true);
  check("name: honorifics and short surnames", t.nameMatches("Dr. Fei-Fei Li", "Fei-Fei Li", "drfeifei") === true);
  check("name: company account fails", t.nameMatches("Pieter Abbeel", "Covariant", "CovariantAI") === false);
  check("name: non-Latin cannot be checked", t.nameMatches("李飞飞", "Fei-Fei Li", "drfeifei") === null);
  check("company: handle form", t.companyTie("Covariant", ["Co-founder @CovariantAI"]));
  check("company: distinctive word", t.companyTie("Physical Intelligence", ["building @physical_int"]));
  check("company: legal suffix", t.companyTie("Acme Robotics, Inc.", ["CTO at AcmeRobotics"]));
  check("company: no match", !t.companyTie("Figure AI", ["robots and AI"]));
  check("title: shared phrase", t.titleTie("Professor at UC Berkeley", "Prof @ UC Berkeley EECS"));
  check("title: one short word is not enough", !t.titleTie("CEO", "CEO of something"));
  check("title: affiliation word", t.titleTie("Professor at UC Berkeley; co-founder of Covariant", "Berkeley & Amazon"));
  check("title: role words alone do not tie", !t.titleTie("Senior Research Scientist", "Scientist and researcher"));
  check("link: same profile", t.sameLink("https://github.com/pabbeel", "https://github.com/pabbeel/repo"));
  check("link: other profile", !t.sameLink("https://github.com/pabbeel", "https://github.com/someone"));
  check("link: company site", t.sameLink("https://covariant.ai", "covariant.ai/team"));
  check("link: a platform root proves nothing", !t.sameLink("https://github.com", "https://github.com/x"));

  section("Known X link short-circuits the search (no request)");
  t.reset();
  await withStub([{ status: 500, body: {} }], async (seen) => {
    const r = await findXHandle({ name: "Pieter Abbeel", hints: ["https://twitter.com/pabbeel"] });
    check("handle from a known link, no request", r.handle === "pabbeel" && r.confidence === 0.9 && seen.length === 0, r);
  });

  if (!process.env.OPENROUTER_API_KEY) {
    console.log("\n  (OPENROUTER_API_KEY is not set: skipping stubbed request tests)");
    return;
  }

  section("Request building and parsing (stubbed fetch)");
  t.reset();
  const nowMs = Date.now();
  const postsReply = completion(
    "Here are the posts:\n```json\n" +
      JSON.stringify({
        posts: [
          { url: `https://x.com/pabbeel/status/${idAt(nowMs - 20 * DAY)}`, text: "Older post about robot learning", postedAt: isoDay(nowMs - 20 * DAY) },
          { url: `https://x.com/pabbeel/status/${idAt(nowMs - 2 * DAY)}`, text: "New post about inference latency", postedAt: isoDay(nowMs - 2 * DAY) },
          { url: `https://x.com/pabbeel/status/${idAt(nowMs - 9 * DAY)}`, text: "Middle post", postedAt: isoDay(nowMs - 9 * DAY) },
        ],
        summary: "Posts about robot learning and inference.",
      }) +
      "\n```",
    { annotations: [{ type: "url_citation", url_citation: { url: `https://x.com/pabbeel/status/${idAt(nowMs - 2 * DAY)}`, title: "post" } }] },
  );
  await withStub([{ status: 200, body: postsReply }], async (seen) => {
    const r = await getXPosts("@pabbeel", { fromDate: "2026-09-01T00:00:00Z", focus: "robots <script>alert(1)</script>", maxPosts: 2 });
    const req = seen[0];
    const tool = (req?.body.tools as Array<Record<string, unknown>> | undefined)?.[0];
    const params = tool?.parameters as Record<string, unknown> | undefined;
    const xs = params?.x_search as Record<string, unknown> | undefined;
    const user = String(((req?.body.messages as Array<Record<string, unknown>>) ?? [])[1]?.content ?? "");
    check("POST to chat completions with a bearer key", req?.url === "https://openrouter.ai/api/v1/chat/completions" && req.method === "POST" && req.hasBearer);
    check("model is the configured Grok", /^x-ai\//.test(String(req?.body.model)), req?.body.model);
    check("routed to xAI only", eq(req?.body.provider, { only: ["xai"], allow_fallbacks: false }), req?.body.provider);
    check("web_search server tool, native engine", tool?.type === "openrouter:web_search" && params?.engine === "native");
    check("x_search pinned to the handle and the given day", eq(xs, { allowed_x_handles: ["pabbeel"], from_date: "2026-09-01" }), xs);
    check("focus is quoted data without angle brackets", user.includes("<focus>") && !user.includes("<script>"));
    check("search plan: broad latest search first", user.includes("keyword search for from:pabbeel, sorted by Latest") && user.includes("about 7 posts"));
    check("reasoning low, output capped", eq(req?.body.reasoning, { effort: "low", exclude: true }) && req?.body.max_tokens === 4600);
    check("posts parsed from a fenced reply, newest first, capped", r.posts.length === 2 && r.posts[0].text.startsWith("New post") && !r.error, r);
    check("summary kept", r.summary === "Posts about robot learning and inference.");
    const call = recentXCalls().at(-1);
    check("usage recorded", call?.usage?.costUsd === 0.0123 && call.usage.webSearchRequests === 2 && call.usage.reasoningTokens === 120 && call.servedBy === "xAI", call);
    const again = await getXPosts("pabbeel", { fromDate: "2026-09-01", focus: "robots <script>alert(1)</script>", maxPosts: 2 });
    check("same request again is served from cache", seen.length === 1 && again.posts.length === 2);
  });

  t.reset();
  const handleReply = completion(JSON.stringify({ handle: "pabbeel", displayName: "Pieter Abbeel", bio: "Professor UC Berkeley | Co-Founder Covariant", profileLink: null, linkedFrom: null, matchedOn: ["name", "company"], evidence: "Bio names Covariant.", confidence: 0.95 }));
  await withStub([{ status: 200, body: handleReply }], async (seen) => {
    const r = await findXHandle(PERSON);
    const xs = ((seen[0]?.body.tools as Array<Record<string, unknown>>)?.[0]?.parameters as Record<string, unknown>)?.x_search as Record<string, unknown>;
    const from = String(xs?.from_date ?? "");
    check("handle accepted", r.handle === "pabbeel" && r.confidence === 0.95 && !r.error, r);
    check("handle search: no handle filter, 30-day window", !("allowed_x_handles" in (xs ?? {})) && from === isoDay(Date.now() - 30 * DAY), xs);
  });

  section("Errors, retries and pausing (stubbed fetch)");
  t.reset();
  await withStub([{ status: 402, body: { error: { code: 402, message: "Insufficient credits" } } }], async (seen) => {
    const r = await getXPosts("pabbeel");
    check("402: clear error, one request", /credits are used up/.test(r.error ?? "") && seen.length === 1, r);
    const paused = await findXHandle(PERSON);
    check("402: later calls pause without a request", seen.length === 1 && /credits/.test(paused.error ?? ""), paused);
    check("402: status explains the pause", /credits/.test(xStatus().detail));
  });
  t.reset();
  await withStub([{ status: 429, body: { error: { code: 429, message: "Rate limited" } } }, { status: 200, body: postsReply }], async (seen) => {
    const r = await getXPosts("pabbeel");
    check("429: retried once, then answered", seen.length === 2 && r.posts.length === 3 && !r.error, { calls: seen.length, r });
  });
  t.reset();
  await withStub([{ status: 500, body: { error: { code: 500, message: "boom" } } }], async (seen) => {
    const r = await getXPosts("pabbeel");
    check("500: not retried (it may have been billed)", seen.length === 1 && /500/.test(r.error ?? ""), r);
  });
  t.reset();
  await withStub([{ throws: new DOMException("The operation was aborted due to timeout", "TimeoutError") }], async (seen) => {
    const r = await getXPosts("pabbeel");
    check("timeout: clear error, not retried", seen.length === 1 && /did not answer within 90 s/.test(r.error ?? ""), r);
  });
  t.reset();
  await withStub([{ status: 200, body: { error: { code: 502, message: "Provider returned error", metadata: { raw: "upstream overloaded" } } } }], async () => {
    const r = await getXPosts("pabbeel");
    check("200 with an error object: mapped", /502/.test(r.error ?? "") && /upstream overloaded/.test(r.error ?? ""), r);
  });
  t.reset();
  await withStub([{ status: 200, body: completion("") }], async () => {
    const r = await getXPosts("pabbeel");
    check("empty reply: error", /empty reply/.test(r.error ?? ""), r);
  });
  t.reset();
  const truncated = completion(
    `{"posts": [{"url": "https://x.com/pabbeel/status/${idAt(nowMs - DAY)}", "text": "kept", "postedAt": "${isoDay(nowMs - DAY)}"}, {"url": "https://x.com/pabbeel/status/1`,
    {},
    "length",
  );
  await withStub([{ status: 200, body: truncated }], async () => {
    const r = await getXPosts("pabbeel");
    check("cut-off reply: complete posts salvaged", r.posts.length === 1 && r.posts[0].text === "kept" && !r.error, r);
  });
  t.reset();
  const prose = completion("I found a few posts, see the sources.", {
    annotations: [
      { type: "url_citation", url_citation: { url: `https://x.com/pabbeel/status/${idAt(nowMs - 3 * DAY)}`, title: "Pieter Abbeel on X", content: "Our new robot model is out" } },
      { type: "url_citation", url_citation: { url: "https://example.com/article", title: "news" } },
    ],
  });
  await withStub([{ status: 200, body: prose }], async () => {
    const r = await getXPosts("pabbeel");
    check("prose reply: posts from cited status URLs", r.posts.length === 1 && r.posts[0].text === "Our new robot model is out", r);
  });
  t.reset();
  await withStub([{ status: 200, body: completion("Sorry, I cannot help with that.") }], async () => {
    const r = await findXHandle(PERSON);
    check("handle reply without JSON: error, no handle", r.handle === null && /did not reply with the JSON/.test(r.error ?? ""), r);
  });
  t.reset();
  check("invalid handle: error without a request", /not a valid X handle/.test((await getXPosts("not a handle!")).error ?? ""));
  check("missing name: error without a request", /name is needed/.test((await findXHandle({ name: "  " })).error ?? ""));
  t.reset();
}

// ---- live --------------------------------------------------------------------------------------
function printCall(c: XCallInfo): void {
  const u = c.usage;
  console.log(
    `    call ${c.kind}: ${c.ok ? "ok" : "error"} in ${(c.ms / 1000).toFixed(1)} s, served by ${c.servedBy ?? "?"}, finish ${c.finishReason ?? "?"}` +
      (c.error ? ` | ${snippet(c.error, 160)}` : ""),
  );
  if (!u) {
    console.log("    usage: none returned");
    return;
  }
  console.log(
    `    usage: prompt ${u.promptTokens ?? "?"} tok, completion ${u.completionTokens ?? "?"} tok (reasoning ${u.reasoningTokens ?? "?"}), ` +
      `cost $${u.costUsd ?? "?"}, web searches ${u.webSearchRequests ?? "?"}, X posts fetched ${u.xPostsFetched ?? "?"}, X profiles fetched ${u.xUsersFetched ?? "?"}`,
  );
  console.log(`    usage fields: ${JSON.stringify(u.raw)}`);
}

async function live(): Promise<void> {
  section(`Live: OpenRouter (at most ${MAX_OPENROUTER_CALLS} requests)`);
  const st = xStatus();
  if (!st.configured) {
    check("X search is configured", false, st.detail);
    return;
  }
  t.reset();

  const found = GIVEN_HANDLE ? { handle: t.normaliseHandle(GIVEN_HANDLE), confidence: 1 } : await lookUp();
  if (found.handle) await readPosts(found.handle);

  const total = recentXCalls().reduce((sum, c) => sum + (c.usage?.costUsd ?? 0), 0);
  console.log(`\n  OpenRouter requests made: ${openRouterCalls} of ${MAX_OPENROUTER_CALLS} allowed; billed cost reported: $${total.toFixed(4)}`);
}

async function lookUp(): Promise<{ handle: string | null; confidence: number }> {
  const startedHandle = Date.now();
  const found = await findXHandle(PERSON);
  console.log(`  findXHandle(${PERSON.name}, ${PERSON.company}) in ${((Date.now() - startedHandle) / 1000).toFixed(1)} s`);
  console.log(`    handle: ${found.handle ? `@${found.handle}` : "none"} | confidence ${found.confidence} | evidence: ${snippet(found.evidence, 200)}`);
  if (found.error) console.log(`    error: ${snippet(found.error, 200)}`);
  for (const c of recentXCalls().filter((c) => c.kind === "handle")) printCall(c);
  check("live: a handle was found without error", Boolean(found.handle) && !found.error, found);
  check("live: confidence is high enough for the pipeline to read posts (>= 0.7)", found.confidence >= 0.7, found.confidence);
  return found;
}

async function readPosts(handle: string): Promise<void> {
  const fromDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 6, new Date().getUTCDate())).toISOString().slice(0, 10);
  const startedPosts = Date.now();
  const res = await getXPosts(handle, { fromDate, focus: GATHER_FOCUS, maxPosts: 15 });
  console.log(`  getXPosts(@${handle}, from ${fromDate}, max 15) in ${((Date.now() - startedPosts) / 1000).toFixed(1)} s`);
  console.log(`    posts: ${res.posts.length}${res.error ? ` | error: ${snippet(res.error, 200)}` : ""}`);
  if (res.posts[0]) console.log(`    newest: ${res.posts[0].postedAt ?? "no date"} ${res.posts[0].url ?? "(no url)"}\n      "${snippet(res.posts[0].text, 140)}"`);
  if (res.posts.length > 1) console.log(`    oldest: ${res.posts.at(-1)!.postedAt ?? "no date"}`);
  console.log(`    summary: ${snippet(res.summary, 240) || "(none)"}`);
  for (const c of recentXCalls().filter((c) => c.kind === "posts")) printCall(c);

  const own = new RegExp(`^https://x\\.com/${handle}/status/\\d+$`, "i");
  check("live: posts returned without error", res.posts.length > 0 && !res.error, res.error);
  check("live: every URL is the handle's own status URL", res.posts.every((p) => p.url === null || own.test(p.url)));
  check("live: every date is inside the window", res.posts.every((p) => !p.postedAt || p.postedAt >= fromDate));
  check("live: newest first", res.posts.every((p, i, a) => i === 0 || !p.postedAt || !a[i - 1].postedAt || a[i - 1].postedAt! >= p.postedAt));
  check("live: at most 15 posts", res.posts.length <= 15);
}

async function main(): Promise<void> {
  await offline();
  if (LIVE) await live();
  else console.log("\n(Live calls skipped. Add --live for findXHandle + getXPosts against OpenRouter: 2 billed requests.)");
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

main().catch((err) => {
  console.error("test-x crashed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
