import "server-only";
import { z } from "zod";
import { defineTool, runToolAgent, type AgentTool, type ToolAgentResult } from "../claude";
import { apolloStatus, enrichOrganization } from "../providers/apollo";
import { exaContents, exaSearch, exaStatus, type ExaResult } from "../providers/exa";
import { getHubModels, hubStatus } from "../providers/huggingface";
import { getXPosts, xStatus } from "../providers/xsearch";
import { insertFindings } from "../repo/findings";
import { addUsage } from "../repo/leads";
import { FINDING_KINDS, type Finding } from "../types";
import { isConfigured, note, raw, step, type RunContext } from "./context";
import { MIN_CONFIDENCE, normaliseVerdict } from "./criteria";
import { agentPrompt, agentSystem } from "./prompts";
import { clamp01, cleanDate, cleanUrl, cleanXHandle, collectUrls, domainFromUrl, isoDateMonthsAgo, truncate, urlKey, withTimeout, wrapData } from "./util";

/**
 * Step 4: one Haiku tool loop that looks for what the fixed searches missed and
 * saves each new fact through record_finding. Capped twice: by the number of
 * search/read calls and by wall-clock time. Never throws; whatever was recorded
 * before a failure is kept.
 */

export const AGENT_MAX_TOOL_CALLS = 8;
const AGENT_CAP_MS = 75_000;
/** Kept back for writing and verifying. */
const RESERVE_AFTER_AGENT_MS = 70_000;
const TOOL_TIMEOUT_MS = 25_000;
const MAX_RECORDED = 12;

export interface AgentOutcome {
  ran: boolean;
  findings: Finding[];
  summary: string | null;
  result: ToolAgentResult | null;
}

const slim = (results: ExaResult[], chars: number) =>
  results.slice(0, 6).map((r) => ({
    url: r.url,
    title: r.title,
    published: r.publishedDate,
    author: r.author,
    highlights: (r.highlights ?? []).slice(0, 2).map((h) => truncate(h, 300)),
    text: truncate(r.text, chars),
  }));

export async function runGapFill(ctx: RunContext, known: Finding[], opts: { focus?: string | null } = {}): Promise<AgentOutcome> {
  const { leadId, person, settings, deadline } = ctx;
  const skipped: AgentOutcome = { ran: false, findings: [], summary: null, result: null };

  const hasExa = isConfigured(exaStatus);
  if (!hasExa) {
    await note(leadId, "tool", "Skipped the deeper search: web search (Exa) is not connected");
    return skipped;
  }
  const timeoutMs = deadline.budget(AGENT_CAP_MS, RESERVE_AFTER_AGENT_MS);
  if (timeoutMs < 20_000) {
    await note(leadId, "tool", "Skipped the deeper search to finish in time");
    return skipped;
  }

  await step(leadId, opts.focus ? "Digging into what you asked for" : "Filling the gaps with a deeper search");

  /** URLs the agent has actually seen in tool results. record_finding only accepts these. */
  const seenUrls = new Set<string>();
  const recorded: Finding[] = [];
  const see = (data: unknown) => {
    for (const u of collectUrls(data)) seenUrls.add(u);
  };
  const toolData = (data: unknown, chars = 9000) => wrapData("tool_data", data, chars);
  const count = (delta: Record<string, number>) => addUsage(leadId, delta).catch(() => undefined);
  const xHandle = cleanXHandle(ctx.lead.xHandle);
  let xCalls = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tools with different input schemas share one array
  const tools: AgentTool<any>[] = [
    defineTool({
      name: "web_search",
      description:
        "Search the web. Returns up to 5 results with url, title, date and a text excerpt. Use specific queries that name the company or person, for example 'Acme Robotics VLA policy inference Jetson'. Set recent_only to true for news from the last 12 months.",
      inputSchema: z.object({
        query: z.string().describe("The search query, 3 to 12 words"),
        recent_only: z.boolean().optional().describe("Only results published in the last 12 months"),
      }),
      run: async ({ query, recent_only }) => {
        const results = await withTimeout(
          exaSearch(query, { numResults: 5, textChars: 1200, ...(recent_only ? { startPublishedDate: isoDateMonthsAgo(12) } : {}) }),
          TOOL_TIMEOUT_MS,
          "Web search",
        );
        await count({ exaSearches: 1 });
        await raw(leadId, "agent.web_search", { query, recent_only }, results);
        see(results);
        return results.length ? toolData(slim(results, 1200)) : "No results. Try different words, or stop if this is not findable.";
      },
    }),
    defineTool({
      name: "people_search",
      description:
        "Search for people, for example who leads ML infrastructure or robotics at a company. Returns profile-like results (often LinkedIn) with name, headline and excerpt. Query with a role and a company, for example 'head of machine learning infrastructure Acme Robotics'.",
      inputSchema: z.object({ query: z.string().describe("Role and company, 3 to 10 words") }),
      run: async ({ query }) => {
        const results = await withTimeout(exaSearch(query, { category: "people", numResults: 5, textChars: 600 }), TOOL_TIMEOUT_MS, "People search");
        await count({ exaSearches: 1 });
        await raw(leadId, "agent.people_search", { query }, results);
        see(results);
        return results.length ? toolData(slim(results, 600)) : "No results.";
      },
    }),
    defineTool({
      name: "read_page",
      description:
        "Read the text of one web page by URL (a search result, the company's site, a careers or docs page). Use when an excerpt looked promising but was cut off.",
      inputSchema: z.object({ url: z.string().describe("Full https URL") }),
      run: async ({ url }) => {
        const clean = cleanUrl(url);
        if (!clean) return "That is not a valid http(s) URL.";
        const results = await withTimeout(exaContents([clean], { textChars: 6000 }), TOOL_TIMEOUT_MS, "Reading the page");
        await count({ exaContents: 1 });
        const page = results[0];
        if (!page?.text?.trim()) return "The page could not be read or has no text.";
        seenUrls.add(urlKey(clean));
        see(page);
        return toolData({ url: page.url, title: page.title, published: page.publishedDate, text: truncate(page.text, 6000) }, 7000);
      },
    }),
  ];

  if (isConfigured(hubStatus)) {
    tools.push(
      defineTool({
        name: "huggingface_models",
        description:
          "List the public models of one Hugging Face account (org or user id, for example 'physical-intelligence'). Shows base models, so you can see which robot models a team fine-tunes.",
        inputSchema: z.object({ author: z.string().describe("Hugging Face org or user id, no URL") }),
        run: async ({ author }) => {
          const id = author.trim().replace(/^https?:\/\/huggingface\.co\//i, "").split("/")[0];
          if (!/^[\w.-]{2,96}$/.test(id)) return "That is not a valid Hugging Face account id.";
          const models = await withTimeout(getHubModels(id, 20), TOOL_TIMEOUT_MS, "Hugging Face");
          see(models);
          seenUrls.add(urlKey(`https://huggingface.co/${id}`));
          return models.length
            ? toolData(models.map((m) => ({ id: m.id, url: m.url, lastModified: m.lastModified, downloads: m.downloads, baseModels: m.baseModels, servedByAbstract: m.servedBase })))
            : "No public models for that account (or the account does not exist).";
        },
      }),
    );
  }

  if (isConfigured(apolloStatus)) {
    tools.push(
      defineTool({
        name: "company_profile",
        description: "Company data from Apollo for a website domain: headcount, growth, funding, industry, technologies. Use for a company not yet looked up (a parent, partner or customer).",
        inputSchema: z.object({ domain: z.string().describe("Company website domain, for example acme.ai") }),
        run: async ({ domain }) => {
          const clean = domainFromUrl(domain);
          if (!clean) return "That is not a valid company domain.";
          const res = await withTimeout(enrichOrganization(clean), TOOL_TIMEOUT_MS, "Apollo");
          if (!res.org) return `No company data for ${clean}${res.error ? ` (${truncate(res.error, 120)})` : ""}.`;
          see(res.org);
          seenUrls.add(urlKey(`https://${clean}`));
          return toolData(res.org, 4000);
        },
      }),
    );
  }

  // X search is billed per post, so it is offered only for the handle already matched to this person, and once.
  if (xHandle && isConfigured(xStatus)) {
    tools.push(
      defineTool({
        name: "x_posts",
        description: `Recent posts on X by this person (@${xHandle}) about one topic. Can be used once. Use only if their X posts are likely to answer an open question.`,
        inputSchema: z.object({ topic: z.string().describe("What to look for in their posts, a few words") }),
        run: async ({ topic }) => {
          if (xCalls >= 1) return "x_posts was already used in this run.";
          xCalls++;
          const res = await withTimeout(getXPosts(xHandle, { fromDate: isoDateMonthsAgo(6), focus: truncate(topic, 200), maxPosts: 10 }), 60_000, "X search");
          await count({ xSearches: 1, xPosts: res.posts?.length ?? 0 });
          await raw(leadId, "agent.x_posts", { handle: xHandle, topic }, res);
          if (!res.posts?.length) return `No posts found${res.error ? ` (${truncate(res.error, 120)})` : ""}.`;
          see(res.posts);
          seenUrls.add(urlKey(`https://x.com/${xHandle}`));
          return toolData({ summary: res.summary, posts: res.posts.slice(0, 10) }, 7000);
        },
      }),
    );
  }

  tools.push(
    defineTool({
      name: "record_finding",
      description:
        "Save one new fact about the person or their company. Call it once per fact, only for facts stated in a tool result, never for guesses. Does not count toward the search budget.",
      inputSchema: z.object({
        kind: z.enum(FINDING_KINDS),
        title: z.string().describe("Label of at most 8 words"),
        text: z.string().describe("One or two factual sentences that stand alone, with names, numbers and dates from the source"),
        url: z.string().describe("URL of the page the fact came from, copied exactly from a tool result"),
        publishedAt: z.string().nullable().optional().describe("YYYY-MM-DD, YYYY-MM or YYYY when the source gives a date"),
        confidence: z.number().describe("0 to 1: how sure this is about the right person or company"),
        relevance: z.number().describe("0 to 1: how useful this is for an Abstract outreach"),
        passesCriteria: z.boolean().describe("false when the fact breaks one of the team's rules"),
        excludedReason: z.string().nullable().optional().describe("The rule it breaks, in a few words; null when it passes"),
      }),
      countsTowardBudget: false,
      run: async (input) => {
        if (recorded.length >= MAX_RECORDED) return "Enough findings recorded. Give your final summary now.";
        const url = cleanUrl(input.url);
        // A fact must point at a page the agent actually read; this is the guard against invented sources.
        if (!url || !seenUrls.has(urlKey(url))) {
          return "Not saved: the url must be copied exactly from a result of one of your tool calls in this run. Fix the url, or skip this fact.";
        }
        const text = input.text?.trim();
        if (!text || text.length < 15) return "Not saved: the text is too short to stand alone.";
        const confidence = clamp01(input.confidence, 0.6);
        if (confidence < MIN_CONFIDENCE) return "Not saved: confidence that this is the right person or company is too low.";
        const saved = await insertFindings(leadId, [
          normaliseVerdict({
            source: "agent" as const,
            kind: input.kind,
            title: truncate(input.title, 120) || null,
            text: truncate(text, 900),
            url,
            publishedAt: cleanDate(input.publishedAt),
            confidence,
            relevance: clamp01(input.relevance, 0.6),
            passesCriteria: input.passesCriteria,
            excludedReason: input.excludedReason ?? null,
          }),
        ]);
        if (!saved[0]) return "Not saved: nothing to save.";
        recorded.push(saved[0]);
        await note(leadId, "finding", `Found: ${saved[0].title ?? truncate(saved[0].text, 80)}`, { findingId: saved[0].id });
        return `Saved (${recorded.length} so far).`;
      },
    }),
  );

  const describe = (name: string, input: unknown): string | null => {
    const arg = (key: string) => truncate(String((input as Record<string, unknown> | null)?.[key] ?? ""), 120);
    switch (name) {
      case "web_search":
        return `Searching the web: ${arg("query")}`;
      case "people_search":
        return `Searching for people: ${arg("query")}`;
      case "read_page":
        return `Reading ${arg("url")}`;
      case "huggingface_models":
        return `Checking Hugging Face models of ${arg("author")}`;
      case "company_profile":
        return `Looking up ${arg("domain")} in Apollo`;
      case "x_posts":
        return `Reading their X posts about ${arg("topic")}`;
      default:
        return null; // record_finding logs its own event once the finding is saved
    }
  };

  const result = await runToolAgent({
    leadId,
    label: "Deeper search",
    system: agentSystem(tools.map((t) => t.name), AGENT_MAX_TOOL_CALLS),
    prompt: agentPrompt({ person, criteria: settings.criteria, findings: known, focus: opts.focus, notes: ctx.lead.notes }),
    tools,
    maxToolCalls: AGENT_MAX_TOOL_CALLS,
    // Search calls plus a few turns that only record findings or wrap up.
    maxIterations: AGENT_MAX_TOOL_CALLS + 4,
    maxTokens: 4_000,
    timeoutMs,
    onToolCall: async (name, input) => {
      const message = describe(name, input);
      if (message) await note(leadId, "tool", message);
    },
  });

  const how: Record<ToolAgentResult["outcome"], string> = {
    completed: "",
    iteration_cap: " (stopped at the step limit)",
    timeout: " (stopped at the time limit)",
    refusal: " (the model declined to continue)",
    max_tokens: " (stopped early)",
    error: result.error ? ` (stopped: ${truncate(result.error, 160)})` : " (stopped on an error)",
  };
  await note(
    leadId,
    "tool",
    `Deeper search added ${recorded.length} ${recorded.length === 1 ? "finding" : "findings"}${how[result.outcome]}`,
    { toolCalls: result.toolCalls, iterations: result.iterations, outcome: result.outcome },
  );

  return { ran: true, findings: recorded, summary: result.text ? truncate(result.text, 1200) : null, result };
}
