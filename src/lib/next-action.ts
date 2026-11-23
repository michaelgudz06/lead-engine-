import type { Lead } from "./types";

/**
 * What a lead needs next, derived from its stage, research state and dates rather
 * than reminders someone has to set. Pure and client-safe.
 */
export interface NextAction {
  label: string;
  tone: "urgent" | "normal" | "quiet";
  /** Lower sorts first in "Needs you first". */
  priority: number;
}

const DAY = 86_400_000;

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function nextAction(lead: Lead, now: number = Date.now()): NextAction {
  if (lead.researchStatus === "running") return { label: "Researching", tone: "normal", priority: 50 };
  if (lead.researchStatus === "error") return { label: "Research failed, retry", tone: "urgent", priority: 20 };
  switch (lead.stage) {
    case "replied":
      return { label: "Reply waiting", tone: "urgent", priority: 0 };
    case "contacted": {
      const due = lead.nextStepAt ? Date.parse(lead.nextStepAt) : NaN;
      if (Number.isFinite(due) && due <= now) {
        const late = Math.floor((now - due) / DAY);
        return { label: late > 0 ? `Follow-up ${late}d overdue` : "Follow-up due", tone: "urgent", priority: 10 };
      }
      return {
        label: lead.nextStepAt ? `Follow up ${shortDate(lead.nextStepAt)}` : "Waiting for reply",
        tone: "quiet",
        priority: 60,
      };
    }
    case "researched":
      return { label: "Ready to send", tone: "normal", priority: 30 };
    case "researching":
      return { label: "Researching", tone: "normal", priority: 50 };
    case "call_booked":
      return { label: "Call booked", tone: "normal", priority: 40 };
    case "new":
      return { label: "Queued", tone: "quiet", priority: 70 };
    case "nurture":
      return { label: "Nurture", tone: "quiet", priority: 90 };
    case "lost":
      return { label: "Closed", tone: "quiet", priority: 95 };
  }
}

/** Replies first, then due follow-ups, then ready-to-send, then the rest. */
export function sortNeedsYouFirst(leads: Lead[], now: number = Date.now()): Lead[] {
  return [...leads].sort((a, b) => {
    const pa = nextAction(a, now).priority;
    const pb = nextAction(b, now).priority;
    if (pa !== pb) return pa - pb;
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  });
}
