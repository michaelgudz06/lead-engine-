/**
 * Usage ledger tests.
 *  1. Unit tests: price table and unit names (no network).
 *  2. Integration: a temporary lead, withUsageContext + several recordUsage + flush, then
 *     every query in usage/queries.ts is checked against what was written.
 *  3. ONE real Claude call (Haiku, a few tokens) inside a context, to prove claude.ts
 *     records real token counts.
 * It removes only what it created (its temporary lead and that lead's ledger rows) and never
 * touches other leads. Prints statuses only, never keys.
 *
 * Run: NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/test-usage.ts
 */
import { z } from "zod";
import { generateObject } from "../src/lib/claude";
import { query } from "../src/lib/db";
import { currentUsageLeadId, flushUsage, metered, recordUsage, withUsageContext } from "../src/lib/usage/ledger";
import {
  apifyCostUsd,
  APOLLO_PLAN,
  claudeCostUsd,
  claudeUnits,
  creditCost,
  exaEstimateUsd,
  exaReportedCostUsd,
  FREE,
  HUNTER_PLAN,
  roundUsd,
} from "../src/lib/usage/prices";
import { getDailySpend, getLeadUsage, getRecentUsage, getUsageSummary, leadCostUsd, windowStart } from "../src/lib/usage/queries";
import { USAGE_PROVIDER_LABELS, USAGE_PROVIDERS } from "../src/lib/usage/types";

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const near = (a: number | null | undefined, b: number, eps = 1e-6): boolean => typeof a === "number" && Math.abs(a - b) <= eps;

function unitTests(): void {
  console.log("\nPrices and units");
  // Haiku 5.5: $0.10 / $0.50 per million up to 100K prompt tokens, $0.50 / $2.50 above.
  check("claude: 1M output at the standard tier is $0.50", near(claudeCostUsd({ inputTokens: 0, outputTokens: 1_000_000 }), 0.5));
  check("claude: 100,000 input tokens is still the standard tier ($0.01)", near(claudeCostUsd({ inputTokens: 100_000, outputTokens: 0 }), 0.01));
  check("claude: 100,001 input tokens is the long tier", near(claudeCostUsd({ inputTokens: 100_001, outputTokens: 0 }), 0.050001, 1e-6));
  check(
    "claude: long tier prices output at $2.50 per million",
    near(claudeCostUsd({ inputTokens: 200_000, outputTokens: 10_000 }), 0.1 + 0.025),
  );
  check(
    "claude: a typical call (9,800 in, 1,500 out) costs $0.00173",
    near(claudeCostUsd({ inputTokens: 9_800, outputTokens: 1_500 }), 0.00098 + 0.00075),
  );
  check(
    "claude: cached tokens count toward the tier",
    near(claudeCostUsd({ inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 99_500 }), (1_000 * 0.5 + 99_500 * 0.5 * 0.1) / 1e6),
  );
  check(
    "claude: cache read 0.1x and cache write 1.25x of input (estimate)",
    near(claudeCostUsd({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 10_000, cacheWriteTokens: 10_000 }), (10_000 * 0.1 * 0.1 + 10_000 * 0.1 * 1.25) / 1e6),
  );
  check("claude: bad numbers cost nothing", claudeCostUsd({ inputTokens: NaN, outputTokens: -5 }) === 0);
  const cu = claudeUnits({ inputTokens: 5, outputTokens: 7 });
  check(
    "claude: unit names are inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens",
    Object.keys(cu).sort().join(",") === "cacheReadTokens,cacheWriteTokens,inputTokens,outputTokens" && cu.inputTokens === 5 && cu.cacheReadTokens === 0,
  );

  check("exa: reads costDollars.total", exaReportedCostUsd({ results: [], costDollars: { total: 0.0123 } }) === 0.0123);
  check("exa: a zero reported cost is kept as reported", exaReportedCostUsd({ costDollars: { total: 0 } }) === 0);
  check(
    "exa: no or malformed costDollars gives null",
    exaReportedCostUsd({}) === null && exaReportedCostUsd(null) === null && exaReportedCostUsd({ costDollars: { total: "1" } }) === null && exaReportedCostUsd({ costDollars: { total: -1 } }) === null,
  );
  check("exa: estimate for a search of up to 10 results is $0.007", near(exaEstimateUsd("search", { results: 1 }), 0.007) && near(exaEstimateUsd("search", { results: 10 }), 0.007));
  check("exa: estimate adds $0.001 per result above 10 (12 results: $0.009)", near(exaEstimateUsd("search", { results: 12 }), 0.009));
  check("exa: estimate for 3 pages of contents is $0.003", near(exaEstimateUsd("contents", { results: 3 }), 0.003));

  check("apify: profile $0.004, posts $0.002, company $0.004 per item", near(apifyCostUsd("profile", 1), 0.004) && near(apifyCostUsd("posts", 10), 0.02) && near(apifyCostUsd("company", 1), 0.004));
  check("apify: no items, no charge", apifyCostUsd("posts", 0) === 0);

  const apollo = creditCost(1, APOLLO_PLAN);
  const hunter = creditCost(1, HUNTER_PLAN);
  check("apollo and hunter: free plans cost 0 with basis free", apollo.costUsd === 0 && apollo.costBasis === "free" && hunter.costUsd === 0 && hunter.costBasis === "free");
  const paid = creditCost(3, { usdPerCredit: 0.02 });
  check("credits: a paid plan is estimated at its rate", near(paid.costUsd, 0.06) && paid.costBasis === "estimated");
  check("free providers: cost 0, basis free", FREE.costUsd === 0 && FREE.costBasis === "free");
  check("roundUsd keeps six decimals", roundUsd(0.12345649) === 0.123456 && roundUsd(NaN) === 0);

  check("types: every provider has a label", USAGE_PROVIDERS.every((p) => typeof USAGE_PROVIDER_LABELS[p] === "string"));

  const at = new Date("2026-11-23T15:30:00Z");
  check("window today starts at UTC midnight", windowStart("today", at)?.toISOString() === "2026-11-23T00:00:00.000Z");
  check("window 7d starts 6 UTC days before today", windowStart("7d", at)?.toISOString() === "2026-11-17T00:00:00.000Z");
  check("window 30d starts 29 UTC days before today", windowStart("30d", at)?.toISOString() === "2026-10-25T00:00:00.000Z");
  check("window all has no start", windowStart("all", at) === null);
}

interface LedgerRow {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  provider: string;
  operation: string;
  units: Record<string, number>;
  cost_usd: string | null;
  cost_basis: string;
  ok: boolean;
  ms: number | null;
}

async function integration(): Promise<void> {
  console.log("\nLedger and queries (temporary lead)");
  const run = `usagetest-${Date.now().toString(36)}`;
  const op = (name: string) => `${run}:${name}`;
  const leadName = `Usage Test ${run}`;
  let leadId: string | null = null;
  const rowIds: string[] = [];

  try {
    const [lead] = await query<{ id: string }>(
      `insert into le_leads (linkedin_url, linkedin_slug, name, company_name)
       values ($1, $2, $3, 'Usage Test Co') returning id`,
      [`https://www.linkedin.com/in/${run}`, run, leadName],
    );
    leadId = lead.id;
    const id = lead.id;

    const before = {
      today: await getUsageSummary("today"),
      all: await getUsageSummary("all"),
    };

    // --- write: five calls in the lead's context, one of them through metered() ---
    check("no usage context outside withUsageContext", currentUsageLeadId() === null);
    const started = Date.now();
    const returned = await withUsageContext(id, async () => {
      check("the context carries the lead id", currentUsageLeadId() === id);
      recordUsage({ provider: "anthropic", operation: op("parse"), units: claudeUnits({ inputTokens: 10_000, outputTokens: 2_000 }), costUsd: claudeCostUsd({ inputTokens: 10_000, outputTokens: 2_000 }), costBasis: "estimated", ok: true, ms: 1200 });
      recordUsage({ provider: "anthropic", operation: op("parse"), units: claudeUnits({ inputTokens: 5_000, outputTokens: 1_000 }), costUsd: claudeCostUsd({ inputTokens: 5_000, outputTokens: 1_000 }), costBasis: "estimated", ok: true, ms: 800 });
      recordUsage({ provider: "exa", operation: op("search"), units: { searches: 1, results: 5 }, costUsd: 0.007, costBasis: "reported", ok: true, ms: 900 });
      recordUsage({ provider: "hunter", operation: op("email-finder"), units: { lookups: 1, credits: 1 }, costUsd: 0, costBasis: "free", ok: true, ms: 300 });
      // A failed, unpriced call: must count as a call and a failure, and add no cost.
      recordUsage({ provider: "openrouter", operation: op("x-posts"), units: { requests: 1 }, costUsd: null, costBasis: "unknown", ok: false, ms: 50 });
      // Still inside the context after an await, and through the wrapper the providers use.
      await new Promise((r) => setTimeout(r, 5));
      const value = await metered(
        { provider: "apify", operation: op("posts"), onOk: (items: number[]) => ({ units: { runs: 1, items: items.length }, costUsd: apifyCostUsd("posts", items.length), costBasis: "estimated" }) },
        async () => [1, 2, 3],
      );
      check("metered() passes the result through", value.length === 3);
      let threw = false;
      try {
        await metered({ provider: "unipile", operation: op("profile"), onOk: () => ({}), onFail: () => ({ units: { requests: 1 }, ...FREE }) }, async () => {
          throw new Error("boom");
        });
      } catch (err) {
        threw = err instanceof Error && err.message === "boom";
      }
      check("metered() rethrows the original error", threw);
      return "done";
    });
    const tookMs = Date.now() - started;
    check("withUsageContext returns what fn returns", returned === "done");

    // Bad input must never throw.
    let safe = true;
    try {
      recordUsage({ provider: "exa", operation: op("bad"), units: { searches: NaN, results: Infinity } as Record<string, number>, costUsd: -4, ok: true, ms: NaN, leadId: "not-a-uuid" });
      recordUsage(null as never);
      await flushUsage();
    } catch {
      safe = false;
    }
    check("recordUsage never throws on bad input", safe);

    // No flush call here on purpose: withUsageContext must already have written everything.
    const rows = await query<LedgerRow>("select * from le_usage where operation like $1 order by id", [`${run}:%`]);
    rowIds.push(...rows.map((r) => r.id));
    const inCtx = rows.filter((r) => r.lead_id === id);
    check("all 7 context rows were written by the time the context returned", inCtx.length === 7, `${inCtx.length} rows, ${tookMs} ms`);
    check("rows carry a snapshot of the lead's name", inCtx.every((r) => r.lead_name === leadName));
    const bad = rows.find((r) => r.operation === op("bad"));
    check(
      "a call outside a context is stored with lead_id null, bad numbers dropped",
      !!bad && bad.lead_id === null && bad.lead_name === null && bad.cost_usd === null && bad.cost_basis === "unknown" && bad.ms === null && Object.keys(bad.units).length === 0,
    );
    const failedRow = inCtx.find((r) => r.provider === "unipile");
    check("a failed metered call is stored with ok false and its units", !!failedRow && failedRow.ok === false && failedRow.units.requests === 1 && failedRow.cost_basis === "free");

    // An older row for the same lead, 10 UTC days ago: inside 30d, outside 7d and today.
    const [old] = await query<{ id: string }>(
      `insert into le_usage (lead_id, lead_name, provider, operation, units, cost_usd, cost_basis, ok, ms, created_at)
       values ($1::uuid, $2, 'exa', $3, '{"searches": 2, "results": 10}'::jsonb, 0.5, 'reported', true, 10, now() - interval '10 days')
       returning id`,
      [id, leadName, op("old-search")],
    );
    rowIds.push(old.id);

    const claudeCost = roundUsd(claudeCostUsd({ inputTokens: 10_000, outputTokens: 2_000 }) + claudeCostUsd({ inputTokens: 5_000, outputTokens: 1_000 }));
    const recent = roundUsd(claudeCost + 0.007 + 0 + 0 + 0.006 + 0); // anthropic + exa + hunter + openrouter(null) + apify + unipile
    check("expected Claude cost of the two test calls is $0.003", near(claudeCost, 0.003));

    // --- leadCostUsd ---
    check("leadCostUsd sums every row of the lead", near(await leadCostUsd(id), recent + 0.5), String(await leadCostUsd(id)));
    check("leadCostUsd is 0 for an unknown lead or a bad id", (await leadCostUsd("00000000-0000-4000-8000-000000000000")) === 0 && (await leadCostUsd("nope")) === 0);

    // --- getLeadUsage ---
    const today = (await getLeadUsage("today")).find((l) => l.leadId === id);
    check("getLeadUsage(today) lists the lead with name and company", !!today && today.leadName === leadName && today.company === "Usage Test Co");
    check("getLeadUsage(today) total excludes the 10-day-old row", near(today?.totalCostUsd, recent), String(today?.totalCostUsd));
    const a = today?.byProvider.anthropic;
    check("per lead: anthropic 2 calls, summed tokens and cost", !!a && a.calls === 2 && a.units.inputTokens === 15_000 && a.units.outputTokens === 3_000 && near(a.costUsd, claudeCost));
    const e = today?.byProvider.exa;
    check("per lead: exa 1 call, 1 search, 5 results, $0.007", !!e && e.calls === 1 && e.units.searches === 1 && e.units.results === 5 && near(e.costUsd, 0.007));
    const h = today?.byProvider.hunter;
    check("per lead: hunter 1 lookup, 1 credit, $0", !!h && h.calls === 1 && h.units.lookups === 1 && h.units.credits === 1 && h.costUsd === 0);
    const o = today?.byProvider.openrouter;
    check("per lead: a failed unpriced call counts as a call with $0", !!o && o.calls === 1 && o.costUsd === 0 && o.units.requests === 1);
    const ap = today?.byProvider.apify;
    check("per lead: apify 1 run, 3 items, $0.006", !!ap && ap.calls === 1 && ap.units.runs === 1 && ap.units.items === 3 && near(ap.costUsd, 0.006));
    check("per lead: firstAt is not after lastAt, both ISO", !!today && today.firstAt <= today.lastAt && /^\d{4}-\d\d-\d\dT/.test(today.firstAt));
    const week = (await getLeadUsage("7d")).find((l) => l.leadId === id);
    check("getLeadUsage(7d) also excludes the 10-day-old row", near(week?.totalCostUsd, recent));
    const month = (await getLeadUsage("30d")).find((l) => l.leadId === id);
    check("getLeadUsage(30d) includes it", near(month?.totalCostUsd, recent + 0.5) && month?.byProvider.exa?.calls === 2 && month?.byProvider.exa?.units.searches === 3);
    const all = await getLeadUsage("all");
    check("getLeadUsage(all) includes it and is newest activity first", near(all.find((l) => l.leadId === id)?.totalCostUsd, recent + 0.5) && all.every((l, i) => i === 0 || all[i - 1].lastAt >= l.lastAt));
    check("getLeadUsage honours the limit", (await getLeadUsage("all", 1)).length === 1);

    // --- getUsageSummary: other work may write rows meanwhile, so global numbers are checked as "grew by at least" ---
    const after = { today: await getUsageSummary("today"), week: await getUsageSummary("7d"), month: await getUsageSummary("30d"), all: await getUsageSummary("all") };
    const prov = (s: typeof after.today, p: string) => s.providers.find((x) => x.provider === p);
    const grew = (p: string, field: "calls" | "failed") => (prov(after.today, p)?.[field] ?? 0) - (prov(before.today, p)?.[field] ?? 0);
    check("summary(today): window and from are set", after.today.window === "today" && after.today.from === windowStart("today")?.toISOString() && after.all.from === null);
    check("summary(today): total grew by the lead's cost", after.today.totalCostUsd - before.today.totalCostUsd >= recent - 1e-6);
    check("summary(today): anthropic +2 calls, exa +2 (one untagged), apify +1", grew("anthropic", "calls") >= 2 && grew("exa", "calls") >= 2 && grew("apify", "calls") >= 1);
    check("summary(today): failures are counted (openrouter +1, unipile +1)", grew("openrouter", "failed") >= 1 && grew("unipile", "failed") >= 1);
    check(
      "summary(today): units are summed per provider",
      (prov(after.today, "anthropic")?.units.inputTokens ?? 0) - (prov(before.today, "anthropic")?.units.inputTokens ?? 0) >= 15_000 &&
        (prov(after.today, "apify")?.units.items ?? 0) - (prov(before.today, "apify")?.units.items ?? 0) >= 3,
    );
    check("summary: estimated flag on anthropic and apify, not on free providers", prov(after.today, "anthropic")?.costEstimated === true && prov(after.today, "apify")?.costEstimated === true && prov(after.today, "hunter")?.costEstimated === false && prov(after.today, "unipile")?.costEstimated === false);
    check("summary(today): one more lead touched", after.today.leadsTouched >= before.today.leadsTouched + 1);
    check("summary: total = sum of providers", near(after.today.totalCostUsd, after.today.providers.reduce((s, p) => s + p.costUsd, 0), 1e-5));
    check(
      "summary: average per lead = lead-tagged cost / leads",
      after.today.avgCostPerLeadUsd !== null && near(after.today.avgCostPerLeadUsd, (after.today.totalCostUsd - after.today.untaggedCostUsd) / after.today.leadsTouched, 1e-5),
    );
    check("summary: the 10-day-old $0.50 is in 30d and all, not in 7d", after.month.totalCostUsd - after.week.totalCostUsd >= 0.5 - 1e-6 && after.all.totalCostUsd >= after.month.totalCostUsd - 1e-6 && after.all.totalCostUsd - before.all.totalCostUsd >= recent + 0.5 - 1e-6);
    check("summary: providers come in the contract's order", after.all.providers.every((p, i, list) => i === 0 || USAGE_PROVIDERS.indexOf(list[i - 1].provider) < USAGE_PROVIDERS.indexOf(p.provider)));

    // --- getRecentUsage ---
    const recentRows = await getRecentUsage(500);
    const mine = recentRows.filter((r) => r.operation.startsWith(`${run}:`));
    check("getRecentUsage returns the test rows, newest first", mine.length === 9 && recentRows.every((r, i) => i === 0 || recentRows[i - 1].id > r.id), `${mine.length} rows`);
    const exaRow = mine.find((r) => r.operation === op("search"));
    check(
      "a record has typed fields (number id and cost, ISO time, lead name)",
      !!exaRow && typeof exaRow.id === "number" && exaRow.costUsd === 0.007 && exaRow.costBasis === "reported" && exaRow.ok === true && exaRow.ms === 900 && exaRow.leadId === id && exaRow.leadName === leadName && exaRow.units.results === 5 && !Number.isNaN(Date.parse(exaRow.createdAt)),
    );
    const xRow = mine.find((r) => r.operation === op("x-posts"));
    check("an unpriced record keeps costUsd null and basis unknown", !!xRow && xRow.costUsd === null && xRow.costBasis === "unknown" && xRow.ok === false);
    check("getRecentUsage honours the limit", (await getRecentUsage(3)).length === 3);

    // --- getDailySpend ---
    const days = await getDailySpend(30);
    const todayKey = new Date().toISOString().slice(0, 10);
    const oldKey = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    check("getDailySpend(30): 30 days, oldest first, ends today", days.length === 30 && days[29].day === todayKey && days.every((d, i) => i === 0 || days[i - 1].day < d.day));
    const dToday = days[29];
    check("daily: today holds at least the lead's cost, split by provider", dToday.totalUsd >= recent - 1e-6 && (dToday.byProvider.anthropic ?? 0) >= claudeCost - 1e-6 && (dToday.byProvider.apify ?? 0) >= 0.006 - 1e-6);
    check("daily: a day's total = sum of its providers", days.every((d) => near(d.totalUsd, Object.values(d.byProvider).reduce((s, v) => s + (v ?? 0), 0), 1e-5)));
    check("daily: the row from 10 days ago is on its own UTC day", (days.find((d) => d.day === oldKey)?.byProvider.exa ?? 0) >= 0.5 - 1e-6);
    const oneDay = await getDailySpend(1);
    check("getDailySpend(1) is just today", oneDay.length === 1 && oneDay[0].day === todayKey);
    const far = await getDailySpend(60);
    check("daily: days without usage are zero-filled", far.length === 60 && far.some((d) => d.totalUsd === 0 && Object.keys(d.byProvider).length === 0));

    // --- one real Claude call: claude.ts must record real tokens for this lead ---
    console.log("\nOne real Claude call (Haiku)");
    let answer: { word: string } | null = null;
    try {
      answer = await withUsageContext(id, () =>
        generateObject({
          label: "Usage test",
          system: "Reply with the JSON object asked for and nothing else.",
          prompt: 'Return {"word": "ok"}.',
          schema: z.object({ word: z.string() }),
          maxTokens: 1000,
          timeoutMs: 60_000,
        }),
      );
    } catch (err) {
      check("the Claude call succeeded", false, err instanceof Error ? err.message.slice(0, 160) : "error");
    }
    if (answer) check("the Claude call succeeded", typeof answer.word === "string");
    const claudeRows = await query<LedgerRow>("select * from le_usage where lead_id = $1::uuid and provider = 'anthropic' and operation = 'messages.parse' order by id", [id]);
    rowIds.push(...claudeRows.map((r) => r.id));
    const real = claudeRows[claudeRows.length - 1];
    check("claude.ts wrote a ledger row for the lead without an explicit flush", claudeRows.length >= 1, `${claudeRows.length} rows`);
    if (real) {
      console.log(`        tokens: ${real.units.inputTokens} in, ${real.units.outputTokens} out; cost $${real.cost_usd}; ${real.ms} ms`);
      check("the row has real token counts", real.units.inputTokens > 0 && real.units.outputTokens > 0 && real.ok === true && (real.ms ?? 0) > 0);
      check(
        "its cost is the price table applied to those tokens (estimated)",
        real.cost_basis === "estimated" && near(Number(real.cost_usd), claudeCostUsd({ inputTokens: real.units.inputTokens, outputTokens: real.units.outputTokens, cacheReadTokens: real.units.cacheReadTokens, cacheWriteTokens: real.units.cacheWriteTokens })) && Number(real.cost_usd) > 0,
      );
    }
    const withClaude = await leadCostUsd(id);
    check("leadCostUsd now includes the real call", withClaude > recent + 0.5);

    // --- a deleted lead keeps its usage: lead_id goes null, the name snapshot stays ---
    console.log("\nDeleting the temporary lead");
    await query("delete from le_leads where id = $1::uuid", [id]);
    leadId = null;
    const orphans = await query<LedgerRow>("select * from le_usage where id = any($1::bigint[])", [rowIds]);
    check("the ledger rows survive with lead_id null and the name kept", orphans.length === rowIds.length && orphans.filter((r) => r.operation !== op("bad")).every((r) => r.lead_id === null && r.lead_name === leadName));
    const gone = (await getLeadUsage("today")).find((l) => l.leadId === null);
    check("getLeadUsage groups deleted leads under leadId null", !!gone && gone.leadName === null && gone.totalCostUsd >= recent - 1e-6);
    const rec = (await getRecentUsage(500)).find((r) => r.operation === op("search"));
    check("getRecentUsage shows the deleted lead's name from the snapshot", !!rec && rec.leadId === null && rec.leadName === leadName);
    const s = await getUsageSummary("today");
    check("summary: a deleted lead's usage is not counted as untagged", near(s.untaggedCostUsd, after.today.untaggedCostUsd, 1e-6) || s.untaggedCostUsd < after.today.untaggedCostUsd + recent);
  } finally {
    // Clean up exactly what this run created.
    try {
      if (rowIds.length) await query("delete from le_usage where id = any($1::bigint[])", [rowIds]);
      await query("delete from le_usage where operation like $1", [`${run}:%`]);
      if (leadId) {
        await query("delete from le_usage where lead_id = $1::uuid", [leadId]);
        await query("delete from le_leads where id = $1::uuid and linkedin_slug = $2", [leadId, run]);
      }
      const [{ count }] = await query<{ count: string }>("select count(*) as count from le_usage where operation like $1 or lead_name = $2", [`${run}:%`, leadName]);
      const [{ count: leads }] = await query<{ count: string }>("select count(*) as count from le_leads where linkedin_slug = $1", [run]);
      check("cleanup: no test rows or test lead left", Number(count) === 0 && Number(leads) === 0, `${count} rows, ${leads} leads`);
    } catch (err) {
      check("cleanup", false, err instanceof Error ? err.message.slice(0, 160) : "error");
    }
  }
}

async function main() {
  unitTests();
  await integration();
  const [{ count }] = await query<{ count: string }>("select count(*) as count from le_leads where id = any($1::uuid[])", [
    ["d0593297-256c-430d-ab75-60e0e93511c4", "2d7d0923-0ac8-44f5-9c09-c42ff82f60e7"],
  ]);
  check("the two demo leads are still there", Number(count) === 2);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
