import "server-only";
import { z } from "zod";
import { generateObject } from "../claude";
import { listFindings } from "../repo/findings";
import type { Lead, Settings } from "../types";
import { note, step, type RunContext } from "./context";
import { runGapFill } from "./agent";
import { writeVerifySave } from "./finish";
import { personFrom } from "./identify";
import { STEER_SYSTEM, steerPrompt } from "./prompts";
import { Deadline, truncate } from "./util";

/**
 * Steering: the teammate types one instruction on the lead page. Haiku decides
 * whether it only needs the drafts rewritten or needs more research first.
 */

export type SteerMode = "rewrite" | "research";

export const SteerSchema = z.object({
  mode: z.enum(["rewrite", "research"]),
  focus: z.string(),
});

const RESEARCH_WORDS = /\b(dig|research|find|look (up|into)|search|check|verify|investigate|discover|who (is|are|else)|what (do|does|are|is)|any news|learn more|more (about|on|info))\b/i;

/** Used when the classifier call fails: obvious research verbs mean research, anything else a rewrite. Pure. */
export function fallbackSteerMode(instruction: string, hasDrafts: boolean): SteerMode {
  if (!hasDrafts) return "research";
  return RESEARCH_WORDS.test(instruction) ? "research" : "rewrite";
}

export async function classifySteer(input: { leadId?: string | null; instruction: string; hasDrafts: boolean; timeoutMs?: number }): Promise<{ mode: SteerMode; focus: string; classifiedBy: "model" | "fallback" }> {
  try {
    const out = await generateObject({
      leadId: input.leadId,
      label: "Reading your instruction",
      system: STEER_SYSTEM,
      prompt: steerPrompt(input.instruction, input.hasDrafts),
      schema: SteerSchema,
      maxTokens: 2_000,
      timeoutMs: input.timeoutMs ?? 30_000,
    });
    // Without drafts there is nothing to rewrite, whatever the model says.
    const mode: SteerMode = input.hasDrafts ? out.mode : "research";
    return { mode, focus: out.focus?.trim() || input.instruction, classifiedBy: "model" };
  } catch {
    return { mode: fallbackSteerMode(input.instruction, input.hasDrafts), focus: input.instruction, classifiedBy: "fallback" };
  }
}

/** A run context from what is already saved on the lead: steering does not re-read LinkedIn. */
export function contextFromLead(lead: Lead, settings: Settings, deadline: Deadline): RunContext {
  return { leadId: lead.id, lead, settings, deadline, person: personFrom(lead, null), profile: null, company: null, apolloPerson: null };
}

/** Does the work for steerLead. Throws on a fatal failure; the caller records it. */
export async function steer(lead: Lead, settings: Settings, rawInstruction: string, deadline: Deadline): Promise<{ mode: SteerMode; added: number }> {
  const leadId = lead.id;
  const instruction = truncate(rawInstruction.trim(), 1200);
  if (!instruction) throw new Error("The instruction is empty. Tell the agent what to change or dig into.");

  await step(leadId, "Reading your instruction");
  const hasDrafts = lead.angles.length > 0;
  const decision = await classifySteer({ leadId, instruction, hasDrafts, timeoutMs: deadline.budget(30_000, 120_000) });
  await note(
    leadId,
    "steer",
    decision.mode === "research" ? `You asked: "${truncate(instruction, 300)}". Researching first, then rewriting.` : `You asked: "${truncate(instruction, 300)}". Rewriting the drafts.`,
    { instruction, mode: decision.mode, focus: decision.focus, classifiedBy: decision.classifiedBy },
  );

  const ctx = contextFromLead(lead, settings, deadline);
  let added = 0;
  if (decision.mode === "research") {
    const known = await listFindings(leadId);
    const outcome = await runGapFill(ctx, known, { focus: decision.focus });
    added = outcome.findings.length;
    if (!outcome.ran) await note(leadId, "tool", "No new research was possible; rewriting from what is already known.");
    await writeVerifySave(ctx, { scope: "all", instruction, currentAngles: lead.angles });
  } else {
    await writeVerifySave(ctx, { scope: "angles", instruction, currentAngles: lead.angles });
  }
  return { mode: decision.mode, added };
}

