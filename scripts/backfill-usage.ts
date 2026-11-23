/**
 * One-time backfill of the usage ledger (le_usage) for the two demo leads, from the
 * counters their research runs left in le_leads.usage, so the admin panel is not empty.
 *
 * Idempotent: a lead that already has rows with operation "backfill" is skipped, so it is
 * safe to run again. Every row is marked operation "backfill" and cost basis "estimated":
 * the old counters kept totals only (no per-call sizes, no reported costs), so the dollar
 * figures are price-table estimates. Rows are dated at the end of the lead's last run.
 *
 * Run: NODE_USE_ENV_PROXY=1 npx tsx --conditions=react-server --env-file=.env.local scripts/backfill-usage.ts
 */
import { db, json, query } from "../src/lib/db";
import { EXA_ESTIMATE, HAIKU_55, OPENROUTER_X_SEARCH_BACKFILL_USD, roundUsd } from "../src/lib/usage/prices";
import type { UsageProvider, UsageUnits } from "../src/lib/usage/types";

const DEMO_LEADS = ["d0593297-256c-430d-ab75-60e0e93511c4", "2d7d0923-0ac8-44f5-9c09-c42ff82f60e7"];

/** Assumptions for what the counters do not say. */
const ASSUMED_PAGES_PER_EXA_CONTENTS = 3;

interface LeadRow {
  id: string;
  name: string | null;
  linkedin_slug: string | null;
  email: string | null;
  usage: Record<string, unknown> | null;
  at: string;
}

interface Row {
  provider: UsageProvider;
  units: UsageUnits;
  costUsd: number;
}

function rowsFor(lead: LeadRow): Row[] {
  const n = (key: string): number => {
    const v = Number(lead.usage?.[key] ?? 0);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const rows: Row[] = [];

  // The counter added cached tokens into the input total and kept no per-call sizes. The
  // average prompt is far below 100K tokens, so the standard tier is used for all of it.
  const input = n("claudeInputTokens");
  const output = n("claudeOutputTokens");
  if (input || output) {
    rows.push({
      provider: "anthropic",
      units: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costUsd: roundUsd((input * HAIKU_55.standard.inputPerMTok + output * HAIKU_55.standard.outputPerMTok) / 1_000_000),
    });
  }

  const searches = n("exaSearches");
  const contents = n("exaContents");
  if (searches || contents) {
    // The counters say how many calls, not how many results: searches are priced at the base
    // rate (up to 10 results each) and each contents call is assumed to have read 3 pages.
    const pages = contents * ASSUMED_PAGES_PER_EXA_CONTENTS;
    rows.push({
      provider: "exa",
      units: { searches, contents: pages },
      costUsd: roundUsd(searches * EXA_ESTIMATE.searchUsd + pages * EXA_ESTIMATE.pageTextUsd),
    });
  }

  const lookups = n("hunterCalls");
  if (lookups) {
    // Free plan: no charge. One credit when the lead ended up with an email.
    rows.push({ provider: "hunter", units: { lookups, credits: lead.email ? 1 : 0 }, costUsd: 0 });
  }

  const xSearches = n("xSearches");
  if (xSearches) {
    rows.push({
      provider: "openrouter",
      units: { requests: xSearches, xPosts: n("xPosts"), xProfiles: 0, promptTokens: 0, completionTokens: 0 },
      costUsd: roundUsd(xSearches * OPENROUTER_X_SEARCH_BACKFILL_USD),
    });
  }
  return rows;
}

async function main() {
  for (const id of DEMO_LEADS) {
    const [lead] = await query<LeadRow>(
      `select id, name, linkedin_slug, email, usage,
              coalesce(research_finished_at, updated_at, now()) as at
         from le_leads where id = $1::uuid`,
      [id],
    );
    if (!lead) {
      console.log(`skip  ${id}: no such lead`);
      continue;
    }
    const label = lead.name ?? id;
    const [{ count }] = await query<{ count: string }>(
      "select count(*) as count from le_usage where lead_id = $1::uuid and operation = 'backfill'",
      [id],
    );
    if (Number(count) > 0) {
      console.log(`skip  ${label}: already backfilled (${count} rows)`);
      continue;
    }
    const rows = rowsFor(lead);
    if (!rows.length) {
      console.log(`skip  ${label}: no usage counters`);
      continue;
    }
    const sql = db();
    // One transaction per lead, and each insert re-checks, so two runs at once cannot double up.
    await sql.transaction(
      rows.map((r) =>
        sql.query(
          `insert into le_usage (lead_id, lead_name, provider, operation, units, cost_usd, cost_basis, ok, ms, created_at)
           select $1::uuid, $2, $3, 'backfill', $4::jsonb, $5::numeric, 'estimated', true, null, $6::timestamptz
            where not exists (
              select 1 from le_usage where lead_id = $1::uuid and operation = 'backfill' and provider = $3
            )`,
          [id, lead.name ?? lead.linkedin_slug ?? "Unnamed lead", r.provider, json(r.units), r.costUsd, lead.at],
        ),
      ),
    );
    const total = roundUsd(rows.reduce((sum, r) => sum + r.costUsd, 0));
    console.log(
      `apply ${label}: ${rows.length} rows, about $${total.toFixed(4)} (${rows.map((r) => `${r.provider} $${r.costUsd.toFixed(4)}`).join(", ")})`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
