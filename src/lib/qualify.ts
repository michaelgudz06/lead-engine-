/**
 * Unqualified leads: the rules the API, the repo and the UI share. Pure and client-safe.
 * The repo (src/lib/repo/qualify.ts) writes restoredStage() again in SQL, so a bulk restore is
 * one statement; scripts/test-api.ts checks that the two agree on every branch.
 */
import { ACTIVE_STAGES, STAGE_LABELS, STAGES, type ActiveStage, type Lead, type Stage } from "./types";

/** What restoredStage() reads from a lead. */
export type RestoreInput = Pick<
  Lead,
  "stageBeforeUnqualified" | "unqualifiedAt" | "researchStatus" | "researchStartedAt" | "lastContactedAt" | "brief" | "angles"
>;

/** A brief or angles from a run: finishResearch's test for "researched" (HAS_RESEARCH in src/lib/repo/leads.ts). */
export function hasResearch(lead: Pick<Lead, "brief" | "angles">): boolean {
  const brief: unknown = lead.brief;
  return (typeof brief === "object" && brief !== null && !Array.isArray(brief)) || (Array.isArray(lead.angles) && lead.angles.length > 0);
}

function isAfter(a: string | null, b: string | null): boolean {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

/**
 * The stage Restore puts an unqualified lead back on: the stage it had just before it was
 * marked, moved on only the way research would have moved it had it never been marked.
 *
 * - "researching" (it was marked while a run was going): "researching" while that run is still
 *   going (its end then moves it on as usual); once it has ended, what finishResearch would
 *   have made it: "researched" when the run is done or the lead has a brief or angles, else "new".
 * - "new" or "researched", with a run started after it was marked: the same, because
 *   claimResearch moves those two stages to "researching" when a run starts.
 * - any other stage: that stage.
 * - none recorded (should not happen): "contacted" when it was contacted, else as "researching".
 */
export function restoredStage(lead: RestoreInput): ActiveStage {
  const before = lead.stageBeforeUnqualified;
  const base: ActiveStage = before ?? (lead.lastContactedAt ? "contacted" : "researching");
  const runSinceMarked = (before === "new" || before === "researched") && isAfter(lead.researchStartedAt, lead.unqualifiedAt);
  if (base !== "researching" && !runSinceMarked) return base;
  if (lead.researchStatus === "running") return "researching";
  return lead.researchStatus === "done" || hasResearch(lead) ? "researched" : "new";
}

/**
 * True when the write that returned this lead is the one that marked it unqualified: that write
 * sets unqualifiedAt and updatedAt from the same now(). A lead that was unqualified already (a
 * teammate or another tab marked it first) keeps its older unqualifiedAt, so Undo leaves it alone.
 * scripts/test-api.ts checks this against the bulk action and the PATCH route.
 */
export function justMarked(lead: Pick<Lead, "stage" | "unqualifiedAt" | "updatedAt">): boolean {
  return lead.stage === "unqualified" && lead.unqualifiedAt !== null && lead.unqualifiedAt === lead.updatedAt;
}

/** The "stage" event logged once when a lead is marked unqualified (never again while it stays unqualified). */
export function unqualifiedEventMessage(reason: string | null): string {
  return reason ? `Marked unqualified: ${reason}` : "Marked unqualified";
}

/** The "stage" event logged when a lead is restored. */
export function restoredEventMessage(to: ActiveStage): string {
  return `Restored from unqualified to ${STAGE_LABELS[to]}`;
}

/** restoredEventMessage for every stage a restore can lead to, keyed by stage (the bulk restore reads it in SQL). */
export function restoredEventMessages(): Record<ActiveStage, string> {
  return Object.fromEntries(ACTIVE_STAGES.map((s) => [s, restoredEventMessage(s)])) as Record<ActiveStage, string>;
}

/** The "stage" event for any other change of stage, e.g. "Stage changed from New to Contacted". */
export function stageChangedEventMessage(from: Stage, to: Stage): string {
  return `Stage changed from ${STAGE_LABELS[from]} to ${STAGE_LABELS[to]}`;
}

/**
 * The "stage" event a change to `to` logs, keyed by the stage it comes from (the PATCH route
 * reads it in SQL, as the bulk restore reads restoredEventMessages): "Marked unqualified[: reason]"
 * when `to` is "unqualified" (`reason`: the one the lead has once marked), else "Stage changed
 * from X to Y". No entry for `to` itself: staying on a stage logs nothing.
 */
export function stageEventMessages(to: Stage, reason: string | null): Partial<Record<Stage, string>> {
  return Object.fromEntries(STAGES.filter((from) => from !== to).map((from) => [from, to === "unqualified" ? unqualifiedEventMessage(reason) : stageChangedEventMessage(from, to)]));
}

/**
 * Bidirectional controls (the Arabic letter mark, the left-to-right and right-to-left marks,
 * embeddings, overrides and isolates). In a reason they could reorder the app's own words around
 * it, so they are dropped. Joiners stay: emoji and some scripts need them.
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * A reason as it is saved: bidirectional controls are dropped, runs of whitespace and control
 * characters (C0 and C1) become one space, then it is trimmed; nothing left is null. The API
 * checks the length (UNQUALIFIED_REASON_MAX) after this.
 */
export function cleanUnqualifiedReason(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.replace(BIDI_CONTROLS, "").replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim() || null;
}
