import "server-only";
import { clearFindings } from "../repo/findings";
import { finishResearch, getLead } from "../repo/leads";
import { getSettings } from "../repo/settings";
import { DEFAULT_SETTINGS, type Settings } from "../types";
import { withUsageContext } from "../usage/ledger";
import { runGapFill } from "./agent";
import { LeadGoneError, note, step } from "./context";
import { extract } from "./extract";
import { writeVerifySave } from "./finish";
import { gather } from "./gather";
import { identify } from "./identify";
import { steer } from "./steer";
import { Deadline, errorMessage, runBudget, truncate } from "./util";

/**
 * The research agent. CONTRACT: these two exports are what the API routes call
 * (inside next/server `after()`), so their signatures are fixed. Both must never
 * throw: failures are recorded on the lead (research_status = 'error') and as events.
 * Owned by the research agent.
 *
 * Flow: identify -> gather (providers, in parallel) -> extract (Haiku)
 *       -> gap-fill agent (Haiku + tools) -> write (Haiku) -> verify (Haiku) -> save.
 * Each step lives in its own module in this folder.
 */

/**
 * The routes run this inside a function capped at 300 s (maxDuration). The run
 * plans for less, so the final save and status update always get to happen.
 */
const RUN_BUDGET_MS = 280_000;

async function loadSettings(leadId: string): Promise<Settings> {
  try {
    return await getSettings();
  } catch (err) {
    await note(leadId, "tool", `Could not load settings (${errorMessage(err)}). Using the defaults.`);
    return DEFAULT_SETTINGS;
  }
}

/** Records the outcome. Never throws: this is the last line of defence for the "never throws" contract. */
async function finish(leadId: string, started: number, failure?: unknown): Promise<void> {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (failure === undefined) {
    try {
      await finishResearch(leadId, "done");
    } catch (err) {
      console.error(`[research] could not mark lead ${leadId} as done: ${errorMessage(err)}`);
    }
    return;
  }
  const message = truncate(errorMessage(failure), 500);
  try {
    await finishResearch(leadId, "error", message);
  } catch (err) {
    console.error(`[research] could not record the failure for lead ${leadId}: ${errorMessage(err)}`);
  }
  await note(leadId, "error", `Research stopped after ${seconds}s: ${message}`);
}

/** Full research run for a lead whose research was already claimed with claimResearch(). */
export function runResearch(leadId: string): Promise<void> {
  // Usage ledger: every outside call in the run is tagged to this lead, and the rows are
  // flushed before the promise resolves, so a serverless function cannot drop them.
  return withUsageContext(leadId, () => research(leadId));
}

async function research(leadId: string): Promise<void> {
  const started = Date.now();
  try {
    const lead = await getLead(leadId);
    // Nothing to record against: the lead was deleted (or the id is wrong) between the claim and this call.
    if (!lead) return;
    // The platform's 300 s started at the request; count what was spent before this call.
    const deadline = new Deadline(runBudget(RUN_BUDGET_MS, lead.researchStartedAt));

    await step(leadId, "Starting research");
    const settings = await loadSettings(leadId);

    const ctx = await identify(leadId, lead, settings, deadline);
    const gathered = await gather(ctx);

    // A re-run starts from a clean slate so findings are not duplicated. Done only
    // now, after the slow network steps, so the old findings stay visible meanwhile.
    try {
      await clearFindings(leadId);
    } catch (err) {
      await note(leadId, "tool", `Could not clear earlier findings (${errorMessage(err)})`);
    }

    const findings = await extract(ctx, gathered);
    const agent = await runGapFill(ctx, findings);
    const result = await writeVerifySave(ctx, { scope: "all" });

    await finish(leadId, started);
    await note(
      leadId,
      "done",
      `Research done in ${Math.round((Date.now() - started) / 1000)}s: ${result.findings.length} findings, ${result.angles} angles`,
      {
        findings: result.findings.length,
        usedForWriting: result.used,
        fromDeeperSearch: agent.findings.length,
        angles: result.angles,
        draftsCorrected: result.rewritten,
        draftsVerified: result.verified,
      },
    );
  } catch (err) {
    // Deleted mid-run: stop quietly, there is no row to record the outcome on.
    if (err instanceof LeadGoneError) return;
    await finish(leadId, started, err);
  }
}

/**
 * Applies a plain-English instruction from the lead page, e.g. "make angle 2
 * more technical" (rewrite drafts) or "dig into their compute setup" (more research,
 * then refresh brief and angles). Research must already be claimed with claimResearch().
 */
export function steerLead(leadId: string, instruction: string): Promise<void> {
  // Usage ledger: same wrapper as runResearch.
  return withUsageContext(leadId, () => steerRun(leadId, instruction));
}

async function steerRun(leadId: string, instruction: string): Promise<void> {
  const started = Date.now();
  try {
    const lead = await getLead(leadId);
    if (!lead) return;
    const deadline = new Deadline(runBudget(RUN_BUDGET_MS, lead.researchStartedAt));
    const settings = await loadSettings(leadId);

    const outcome = await steer(lead, settings, String(instruction ?? ""), deadline);

    await finish(leadId, started);
    await note(
      leadId,
      "done",
      outcome.mode === "research"
        ? `Done: ${outcome.added} new ${outcome.added === 1 ? "finding" : "findings"}, brief and drafts rewritten`
        : "Done: drafts rewritten",
      { mode: outcome.mode, newFindings: outcome.added },
    );
  } catch (err) {
    // Deleted mid-run: stop quietly, there is no row to record the outcome on.
    if (err instanceof LeadGoneError) return;
    await finish(leadId, started, err);
  }
}
