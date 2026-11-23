import "server-only";
import { listFindings } from "../repo/findings";
import { updateLead, type LeadPatch } from "../repo/leads";
import type { Angle, Approach, Brief, CompanyPicture, Finding } from "../types";
import { note, step, type RunContext } from "./context";
import { selectForWriting } from "./criteria";
import { sanitizeCitations, verifyAngles } from "./verify";
import { finalizeAngles, writeAngles, writeBrief } from "./write";
import { errorMessage } from "./util";

/**
 * Steps 5 to 7 as one unit, shared by a full research run and by steering:
 * write from the saved findings, verify the drafts, save.
 *
 * Throws when nothing usable could be written (the caller records the error),
 * but saves whichever half succeeded first, so a failure in the drafts does not
 * throw away a good brief.
 */

export interface WriteOptions {
  /** "all": brief, company picture, angles and approach. "angles": only angles and approach; the brief is kept. */
  scope: "all" | "angles";
  /** The teammate's steer instruction, when there is one. */
  instruction?: string | null;
  /** Drafts to show the writer as the starting point (steering). */
  currentAngles?: Angle[];
}

export interface WriteResult {
  findings: Finding[];
  used: number;
  angles: number;
  rewritten: number;
  verified: boolean;
}

const WRITE_CAP_MS = 80_000;
const VERIFY_CAP_MS = 45_000;

export async function writeVerifySave(ctx: RunContext, opts: WriteOptions): Promise<WriteResult> {
  const { leadId, person, settings, deadline } = ctx;
  const all = await listFindings(leadId);
  const selected = selectForWriting(all);

  await step(leadId, opts.scope === "all" ? "Writing the brief" : "Rewriting the outreach drafts");

  const writeTimeout = Math.max(20_000, deadline.budget(WRITE_CAP_MS, 20_000));
  const [briefRes, anglesRes] = await Promise.allSettled([
    opts.scope === "all"
      ? writeBrief({ leadId, person, findings: selected, instruction: opts.instruction, timeoutMs: writeTimeout })
      : Promise.resolve(null),
    writeAngles({
      leadId,
      person,
      findings: selected,
      settings,
      notes: ctx.lead.notes,
      instruction: opts.instruction,
      currentAngles: opts.currentAngles,
      timeoutMs: writeTimeout,
    }),
  ]);

  const validIds = all.map((f) => f.id);
  const failures: string[] = [];
  let brief: Brief | null = null;
  let companyPicture: CompanyPicture | null = null;
  if (briefRes.status === "fulfilled" && briefRes.value) {
    ({ brief, companyPicture } = sanitizeCitations(briefRes.value, validIds));
    // Saved straight away: if the drafts fail below, the brief is still there.
    await updateLead(leadId, { brief, companyPicture });
  } else if (briefRes.status === "rejected") {
    failures.push(errorMessage(briefRes.reason));
  }

  if (anglesRes.status === "rejected") failures.push(errorMessage(anglesRes.reason));
  else if (!anglesRes.value.angles.length) failures.push("Writing the outreach drafts: no usable draft came back");
  if (anglesRes.status === "rejected" || !anglesRes.value.angles.length) {
    throw new Error(failures.join("; "));
  }

  let angles: Angle[] = anglesRes.value.angles;
  const approach: Approach = anglesRes.value.approach;
  let rewritten = 0;
  let verified = false;

  const verifyTimeout = deadline.budget(VERIFY_CAP_MS, 4_000);
  if (verifyTimeout >= 12_000) {
    await step(leadId, "Checking the drafts against the sources");
    try {
      const report = await verifyAngles({ leadId, person, angles, findings: selected, timeoutMs: verifyTimeout });
      angles = report.angles;
      rewritten = report.rewritten;
      verified = report.checked === angles.length;
      await note(
        leadId,
        "tool",
        report.rewritten
          ? `Checked ${report.checked} drafts and corrected ${report.rewritten}`
          : `Checked ${report.checked} drafts: every claim is backed by a finding`,
        report.rewritten ? { issues: report.issues } : undefined,
      );
    } catch (err) {
      // Unverified drafts are still useful, as long as the teammate knows.
      await note(leadId, "tool", `Could not check the drafts (${errorMessage(err)}). Read the claims carefully before sending.`);
    }
  } else {
    await note(leadId, "tool", "Skipped the draft check to finish in time. Read the claims carefully before sending.");
  }

  const clean = sanitizeCitations({ angles: finalizeAngles(angles, settings, person.firstName), approach }, validIds);
  const patch: LeadPatch = { angles: clean.angles, approach: clean.approach };
  await updateLead(leadId, patch);

  if (failures.length) {
    // Drafts are saved, but the brief half failed: report it rather than calling the run a success.
    throw new Error(failures.join("; "));
  }
  return { findings: all, used: selected.length, angles: clean.angles?.length ?? 0, rewritten, verified };
}
