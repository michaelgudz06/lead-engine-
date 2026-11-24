/** What a lead needs next, as the lists and the lead page show it. Client-safe. */
import { nextAction, type NextAction } from "@/lib/next-action";
import type { Lead } from "@/lib/types";

/** An imported lead waits for someone to press Run research: nothing is queued for it. */
export function notResearched(lead: Pick<Lead, "stage" | "researchStatus" | "researchFinishedAt">): boolean {
  return lead.stage === "new" && lead.researchStatus === "idle" && !lead.researchFinishedAt;
}

/** nextAction, except that a lead nobody has researched says so instead of "Queued". */
export function leadAction(lead: Lead): NextAction {
  const action = nextAction(lead);
  return notResearched(lead) ? { ...action, label: "Not researched yet" } : action;
}
