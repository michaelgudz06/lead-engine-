import "server-only";
import { z } from "zod";
import { generateObject } from "../claude";
import { SOURCE_LABELS, type Angle, type Approach, type Brief, type Cited, type CompanyPicture, type Finding } from "../types";
import type { Person } from "./context";
import { BOOKING_TOKEN, EMAIL_WORD_LIMIT, LINKEDIN_CHAR_LIMIT, VERIFY_SYSTEM, verifyPrompt } from "./prompts";
import { truncate, wordCount } from "./util";

/**
 * Step 6: a second Haiku pass reads every draft sentence against the findings it
 * cites and against what Abstract really offers, and rewrites a draft once when
 * something is not supported. Code then makes sure no citation points at a
 * finding that does not exist.
 */

export const VerifySchema = z.object({
  drafts: z.array(
    z.object({
      id: z.string(),
      issues: z.array(z.string()),
      emailSubject: z.string(),
      emailBody: z.string(),
      linkedinMessage: z.string(),
    }),
  ),
});

export interface VerifyReport {
  angles: Angle[];
  checked: number;
  rewritten: number;
  /** Angle id -> what was wrong, for the activity log. */
  issues: Record<string, string[]>;
}

/** Problems code can see without a model: drafts over the length limits. Pure. */
export function lengthIssues(angle: Angle): string[] {
  const issues: string[] = [];
  const words = wordCount(angle.email.body);
  if (words > EMAIL_WORD_LIMIT) issues.push(`the email is ${words} words, it must be under ${EMAIL_WORD_LIMIT}`);
  if (angle.linkedinMessage.length >= LINKEDIN_CHAR_LIMIT) {
    issues.push(`the LinkedIn message is ${angle.linkedinMessage.length} characters, it must be under ${LINKEDIN_CHAR_LIMIT - 20}`);
  }
  return issues;
}

/**
 * Applies the checker's answer. A rewrite is adopted only when a problem was
 * reported and the rewrite is usable; otherwise the original draft stays. Pure.
 */
export function applyVerification(angles: Angle[], checked: z.infer<typeof VerifySchema>["drafts"], known: Record<string, string[]>): VerifyReport {
  const byId = new Map(checked.map((d) => [d.id, d]));
  const report: VerifyReport = { angles: [], checked: 0, rewritten: 0, issues: {} };
  for (const angle of angles) {
    const result = byId.get(angle.id);
    if (!result) {
      report.angles.push(angle);
      continue;
    }
    report.checked++;
    const issues = [...(known[angle.id] ?? []), ...(result.issues ?? []).map((i) => i.trim()).filter(Boolean)];
    const body = result.emailBody?.trim();
    const usable =
      Boolean(body) &&
      wordCount(body) >= 15 &&
      // A "fix" that is much longer than allowed, or that lost the booking link, is not an improvement.
      wordCount(body) <= EMAIL_WORD_LIMIT * 1.4 &&
      (!angle.email.body.includes(BOOKING_TOKEN) || body.includes(BOOKING_TOKEN));
    if (!issues.length || !usable) {
      report.angles.push(angle);
      continue;
    }
    report.rewritten++;
    report.issues[angle.id] = issues.map((i) => truncate(i, 200)).slice(0, 6);
    report.angles.push({
      ...angle,
      email: { subject: result.emailSubject?.trim() || angle.email.subject, body },
      linkedinMessage: result.linkedinMessage?.trim() || angle.linkedinMessage,
    });
  }
  return report;
}

export async function verifyAngles(input: {
  leadId?: string | null;
  person: Person;
  angles: Angle[];
  /** The findings the writer saw, in the same order (so F-labels match what the writer used). */
  findings: Finding[];
  timeoutMs?: number;
}): Promise<VerifyReport> {
  const { angles, findings } = input;
  if (!angles.length) return { angles, checked: 0, rewritten: 0, issues: {} };
  const byId = new Map(findings.map((f) => [f.id, f]));
  const line = (f: Finding) => `(${SOURCE_LABELS[f.source]}${f.publishedAt ? `, ${f.publishedAt}` : ""}) ${f.title ? `${f.title}: ` : ""}${truncate(f.text, 600)}`;
  // The teammate's notes back every draft: the writer is allowed to lean on them without citing.
  const notes = findings.filter((f) => f.source === "notes");
  const known: Record<string, string[]> = {};
  const drafts = angles.map((a) => {
    known[a.id] = lengthIssues(a);
    const cited = a.findingIds.map((id) => byId.get(id)).filter((f): f is Finding => Boolean(f));
    const support = [...new Set([...cited, ...notes])];
    return {
      id: a.id,
      name: a.name,
      subject: a.email.subject,
      body: a.email.body,
      linkedinMessage: a.linkedinMessage,
      findingLines: support.map(line),
      knownIssues: known[a.id],
    };
  });
  const out = await generateObject({
    leadId: input.leadId,
    label: "Checking the drafts",
    system: VERIFY_SYSTEM,
    prompt: verifyPrompt({ drafts, person: input.person }),
    schema: VerifySchema,
    maxTokens: 10_000,
    timeoutMs: input.timeoutMs,
  });
  return applyVerification(angles, out.drafts ?? [], known);
}

// ---------------------------------------------------------------- citation hygiene (pure)

const keepKnown = (ids: string[] | undefined, valid: Set<string>) => [...new Set((ids ?? []).filter((id) => valid.has(id)))];

function citedOnly(items: Cited[] | undefined, valid: Set<string>): Cited[] {
  return (items ?? []).map((c) => ({ ...c, findingIds: keepKnown(c.findingIds, valid) })).filter((c) => c.text?.trim() && c.findingIds.length > 0);
}

/**
 * Last gate before saving: every finding id that is not a real finding of this
 * lead is stripped, and a cited claim left with no citation is removed.
 */
export function sanitizeCitations<T extends { brief?: Brief | null; companyPicture?: CompanyPicture | null; angles?: Angle[]; approach?: Approach | null }>(
  doc: T,
  validIds: Iterable<string>,
): T {
  const valid = new Set(validIds);
  const out: T = { ...doc };
  if (doc.brief) {
    out.brief = { ...doc.brief, bullets: citedOnly(doc.brief.bullets, valid), pains: citedOnly(doc.brief.pains, valid) };
  }
  if (doc.companyPicture) {
    out.companyPicture = {
      ...doc.companyPicture,
      team: citedOnly(doc.companyPicture.team, valid),
      hiring: citedOnly(doc.companyPicture.hiring, valid),
      robotsAndModels: citedOnly(doc.companyPicture.robotsAndModels, valid),
      decisionMakers: citedOnly(doc.companyPicture.decisionMakers, valid),
    };
  }
  if (doc.angles) {
    // Angles keep their place even with no citations left: the draft itself was verified separately.
    out.angles = doc.angles.map((a) => ({ ...a, findingIds: keepKnown(a.findingIds, valid) }));
    if (doc.approach) {
      const ids = new Set(out.angles.map((a) => a.id));
      out.approach = { ...doc.approach, leadAngleId: doc.approach.leadAngleId && ids.has(doc.approach.leadAngleId) ? doc.approach.leadAngleId : (out.angles[0]?.id ?? null) };
    }
  }
  return out;
}
