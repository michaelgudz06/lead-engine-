import "server-only";

/**
 * The research agent. CONTRACT: these two exports are what the API routes call
 * (inside next/server `after()`), so their signatures are fixed. Both must never
 * throw: failures are recorded on the lead (research_status = 'error') and as events.
 * Owned by the research agent.
 */

/** Full research run for a lead whose research was already claimed with claimResearch(). */
export async function runResearch(leadId: string): Promise<void> {
  void leadId;
  throw new Error("not implemented");
}

/**
 * Applies a plain-English instruction from the lead page, e.g. "make angle 2
 * more technical" (rewrite drafts) or "dig into their compute setup" (more research,
 * then refresh brief and angles). Research must already be claimed with claimResearch().
 */
export async function steerLead(leadId: string, instruction: string): Promise<void> {
  void leadId;
  void instruction;
  throw new Error("not implemented");
}
