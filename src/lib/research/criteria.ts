import type { Finding, NewFinding } from "../types";
import { clamp01 } from "./util";

/**
 * Criteria are the plain-English rules from Settings. Claude judges each finding
 * against them while extracting; the helpers here format the rules for prompts and
 * make the verdicts consistent before anything is saved. Pure: no I/O.
 */

/** Below this "is it the right person?" score a finding is dropped, not just hidden. */
export const MIN_CONFIDENCE = 0.5;
/** The writer sees at most this many findings, best first, to keep prompts small. */
export const MAX_FINDINGS_FOR_WRITING = 60;

export function criteriaBlock(criteria: string[]): string {
  const rules = (criteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (!rules.length) return "No extra rules. Keep to professional signals.";
  return rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n");
}

/**
 * Makes a criteria verdict consistent: an excluded finding always has a reason
 * (the UI shows it under "Show filtered out"), and a passing finding never has one.
 */
export function normaliseVerdict<T extends Pick<NewFinding, "passesCriteria" | "excludedReason">>(finding: T): T {
  const passes = finding.passesCriteria !== false;
  const reason = finding.excludedReason?.trim() || null;
  return {
    ...finding,
    passesCriteria: passes,
    excludedReason: passes ? null : (reason ?? "Filtered out by your criteria"),
  };
}

/** Findings the writer may use: passed the criteria, confident enough, most relevant first. */
export function selectForWriting(findings: Finding[], max = MAX_FINDINGS_FOR_WRITING): Finding[] {
  return findings
    .filter((f) => f.passesCriteria && f.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => {
      // The user's own notes always come first: they are the most trusted context.
      const notes = Number(b.source === "notes") - Number(a.source === "notes");
      if (notes) return notes;
      return b.relevance * 0.7 + b.confidence * 0.3 - (a.relevance * 0.7 + a.confidence * 0.3);
    })
    .slice(0, max);
}

/** Splits extracted findings into those worth saving and those dropped as probably about someone else. */
export function dropLowConfidence<T extends Pick<NewFinding, "confidence">>(items: T[]): { kept: T[]; dropped: number } {
  const kept = items.filter((f) => clamp01(f.confidence, 0.7) >= MIN_CONFIDENCE);
  return { kept, dropped: items.length - kept.length };
}
