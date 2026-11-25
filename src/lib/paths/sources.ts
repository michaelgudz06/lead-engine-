/**
 * The footer lines of the warm-paths panel ("LinkedIn: matched your 1,240 connections (export of
 * Nov 2)."), one per network, from what a check found. Pure: the engine builds them, the tests
 * pin their words. No names, keys or URLs ever go into a line.
 *
 * Each line also says, as data, what it compared: `mutuals` when the check looked for people you
 * both know (LinkedIn on your own account, or X), and on the LinkedIn line `history` (how your
 * work and school history was compared). The panel's sentences are built from those
 * (src/lib/paths/copy.ts), never from the words of a line.
 */

import { dollars, linkedinCsvDetail, linkedinLiveDetail, shortDate, xCheckedDetail } from "./copy";
import { LEAD_FOLLOWING_MAX, type WarmHistoryState, type WarmPathSetup, type WarmPathSource, type WarmSourceCounts, type WarmSourceReason, type WarmSourceState } from "./types";

export interface LinkedinLiveLike {
  distance: string | null;
  sharedCount: number | null;
  verified: boolean;
  reason: string | null;
  mutuals: unknown[];
  checkedAt: string;
}

export interface XLiveLike {
  handle: string;
  ownHandle: string;
  protected: boolean;
  unavailable: boolean;
  notFound: boolean;
  /** The lead's follow count, as X reports it (null when unknown). */
  following?: number | null;
  followers: number | null;
  followingRead: number;
  partial: boolean;
  costUsd: number;
  ownFollowing: number;
  ownFollowers: number;
  checkedAt: string;
}

/** How one live part went: a new read, the cached one, not at all (and why), or a failure. */
export interface PartOutcome<T> {
  state: "checked" | "cached" | "skipped" | "failed" | "not_run";
  reason: WarmSourceReason | null;
  error: string | null;
  live: T | null;
}

export interface SourceInputs {
  now: Date;
  setup: WarmPathSetup;
  /** researched: research has run on the lead (the footer says "run research" before the first run, "re-run" after). */
  lead: { hasLinkedin: boolean; xHandle: string | null; instagramHandle: string | null; researched?: boolean };
  linkedin: {
    /** Connections matched against (your export), when it is set up. */
    connections: number | null;
    /** Your connections at the lead's companies, all of them (up to 5 are listed). */
    atCompanies?: number;
    exportedAt: string | null;
    /** Your own profile: read and used, not read yet (or failed), or not set up. */
    ownProfile: "ok" | "missing" | "not_set_up";
    /** The lead's roles and member id are known. */
    targetCaptured: boolean;
    live: PartOutcome<LinkedinLiveLike>;
  };
  x: {
    /** Your lists could not be had: why. */
    own: { reason: WarmSourceReason; error: string } | null;
    /** A note about your lists (partly refreshed, read elsewhere). */
    ownNote: string | null;
    lead: PartOutcome<XLiveLike>;
    /** The daily X budget in dollars, for "today's X budget ($1) is used up". */
    budgetUsd: number;
    /** The server has a twitterapi.io key (TWITTERAPI_IO_KEY). */
    configured: boolean;
  };
}

/** Joins sentence parts: the first starts as it is (after "LinkedIn: "), the rest start with a capital; each ends with a full stop. */
function sentences(parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((p, i) => {
      const t = p.trim().replace(/\.?$/, ".");
      return i === 0 ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join(" ");
}

/** Brackets inside brackets read badly ("(HTTP 502 (Bad Gateway))"): an inner pair becomes a comma. */
export function unnestBrackets(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "(") {
      depth++;
      out = depth === 1 ? out + ch : `${out.trimEnd()}, `;
    } else if (ch === ")") {
      if (depth === 1) out += ch;
      depth = Math.max(0, depth - 1);
    } else {
      out += ch;
    }
  }
  return depth > 0 ? `${out.trimEnd()})` : out;
}

interface LineExtra {
  counts?: WarmSourceCounts;
  at?: string | null;
  costUsd?: number | null;
  mutuals?: boolean;
  history?: WarmHistoryState;
}

function line(network: WarmPathSource["network"], state: WarmSourceState, reason: WarmSourceReason | null, detail: string, extra: LineExtra = {}): WarmPathSource {
  return {
    network,
    state,
    reason,
    detail: unnestBrackets(detail || "nothing to report."),
    counts: extra.counts ?? {},
    at: extra.at ?? null,
    costUsd: extra.costUsd ?? null,
    ...(extra.mutuals !== undefined ? { mutuals: extra.mutuals } : {}),
    ...(extra.history !== undefined ? { history: extra.history } : {}),
  };
}

/**
 * A provider error, short and plain, for inside a line's own brackets: its own brackets become
 * commas ("twitterapi.io HTTP 502 (the X data service had an error)" -> "twitterapi.io HTTP 502,
 * the X data service had an error"), and a final full stop goes.
 */
function shortError(error: string | null): string {
  return (error ?? "no answer")
    .replace(/\s*\(\s*/g, ", ")
    .replace(/\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "")
    .slice(0, 140);
}

/** A whole sentence from elsewhere ("Your X account could not be read (...)."), as a line's own words: "your X account could not be read (...)." */
function asOwnSentence(text: string): string {
  const t = unnestBrackets(text.replace(/\s+/g, " ").trim()).slice(0, 200);
  return /^Your\b/.test(t) ? `y${t.slice(1)}` : t;
}

const LINKEDIN_SKIPS: Partial<Record<WarmSourceReason, string>> = {
  budget: "today's LinkedIn checks on your account are used up",
  paused: "LinkedIn checks on your account are paused",
  gap: "another LinkedIn check ran less than 2 minutes ago, so this one waited",
  account_paused: "checks on your LinkedIn account are paused for a while",
  needs_reconnect: "your LinkedIn needs reconnecting in Unipile",
  timeout: "there was no time left to check your LinkedIn account",
};

export function linkedinSource(input: SourceInputs): WarmPathSource {
  const { setup, lead, linkedin: li, now } = input;
  if (!lead.hasLinkedin) return line("linkedin", "lead_unknown", "no_profile", "not checked, this lead has no LinkedIn profile yet.");
  const live = li.live;
  // A result your account found earlier stays, even when the account is no longer set up: its
  // people are still shown, so the line says where they came from.
  if (!setup.linkedinConnections && !setup.linkedinProfile && !setup.linkedinAccount && !live.live) return line("linkedin", "not_set_up", "no_owner_data", "not set up.");
  const parts: string[] = [];
  const states: WarmSourceState[] = [];
  let reason: WarmSourceReason | null = null;
  const counts: WarmSourceCounts = {};
  let at: string | null = null;
  let mutuals = false;

  if (setup.linkedinConnections && li.connections !== null) {
    parts.push(linkedinCsvDetail(li.connections, li.exportedAt, now));
    states.push("checked");
    counts.connections = li.connections;
    if (li.atCompanies) counts.atCompanies = li.atCompanies;
    at = li.exportedAt;
  }
  // Your work and school history against the lead's: both must be known.
  const history: WarmHistoryState = !setup.linkedinProfile ? "no_profile" : li.ownProfile !== "ok" ? "own_unread" : li.targetCaptured ? "compared" : "lead_unread";
  if (history === "compared") {
    if (!parts.length) parts.push("compared your work history and schools with theirs.");
    states.push("checked");
  } else if (history === "own_unread") {
    parts.push("your own profile has not been read yet, so shared employers and schools were not checked.");
  }
  if (!li.targetCaptured && (setup.linkedinProfile || setup.linkedinConnections)) {
    parts.push(`${lead.researched === false ? "run" : "re-run"} research to read their work history.`);
    reason = "no_target";
  }
  if (setup.linkedinAccount || live.live) {
    // What your account found (now, or on an earlier check while this one could not run).
    if (live.live) {
      parts.push(linkedinLiveDetail(live.live.distance, live.live.checkedAt, now));
      if (!live.live.verified && live.live.reason) {
        parts.push("the shared connections could not be confirmed, so open them on LinkedIn.");
        reason ??= "unverified";
      }
      // Not 2nd degree (nobody in between), or the shared connections were confirmed: checked.
      mutuals = live.live.verified;
      if (typeof live.live.sharedCount === "number") counts.shared = live.live.sharedCount;
      states.push(live.state === "checked" ? "checked" : "cached");
      at ??= live.live.checkedAt;
    }
    if (live.state === "skipped" && live.reason && LINKEDIN_SKIPS[live.reason]) {
      parts.push(`${LINKEDIN_SKIPS[live.reason]}.`);
      states.push("skipped");
      reason = live.reason;
    } else if (live.state === "failed") {
      parts.push(`your LinkedIn account did not answer (${shortError(live.error)}).`);
      states.push("failed");
      reason = live.reason ?? "upstream";
    } else if (!live.live && live.state === "not_run" && setup.linkedinAccount) {
      parts.push("not checked on your LinkedIn account yet.");
    }
  }
  const state: WarmSourceState = states.includes("checked") ? "checked" : states.includes("cached") ? "cached" : states.includes("failed") ? "failed" : "skipped";
  const ran = state === "checked" || state === "cached";
  return line("linkedin", state, ran ? reason : (reason ?? null), sentences(parts), { counts, at, mutuals: ran && mutuals, history });
}

/** "Their newest 5,000 of 8,000 follows were read." when the read stopped at the cap, else "". */
function cappedNote(v: XLiveLike): string {
  const total = typeof v.following === "number" ? v.following : null;
  if (v.followingRead < LEAD_FOLLOWING_MAX || (total !== null && total <= v.followingRead)) return "";
  const n = v.followingRead.toLocaleString("en-US");
  return total === null ? `only their newest ${n} follows were read.` : `only their newest ${n} of ${total.toLocaleString("en-US")} follows were read.`;
}

export function xSource(input: SourceInputs): WarmPathSource {
  const { setup, lead, x, now } = input;
  // A check made while X was on stays, and so does its line (its people are still shown).
  const cached = x.lead.state === "cached" && x.lead.live ? x.lead.live : null;
  // X off on this server comes first: nothing about the lead or Settings would turn it on.
  if (!x.configured && !cached) return line("x", "not_set_up", "not_configured", "off on this server.");
  if (!lead.xHandle) return line("x", "lead_unknown", "no_handle", "not checked, their X account is not known. Add it under Details.");
  if (!setup.x && !cached) return line("x", "not_set_up", "no_owner_handle", "not set up. Add your X handle in Settings.");
  const budget = `today's X budget (${dollars(x.budgetUsd)}) is used up.`;
  if (x.own && x.lead.state !== "cached") {
    const r = x.own.reason;
    if (r === "budget") return line("x", "skipped", "budget", budget);
    if (r === "paused") return line("x", "skipped", "paused", "X checks are paused.");
    if (r === "no_owner_handle") return line("x", "not_set_up", "no_owner_handle", "not set up. Add your X handle in Settings.");
    if (r === "not_configured") return line("x", "not_set_up", "not_configured", "off on this server.");
    // The error is already a sentence about your X lists or account.
    return line("x", "failed", r, sentences([asOwnSentence(x.own.error)]));
  }
  const l = x.lead;
  const note = x.ownNote ? [asOwnSentence(x.ownNote)] : [];
  if ((l.state === "checked" || l.state === "cached") && l.live) {
    const v = l.live;
    const counts: WarmSourceCounts = { following: v.ownFollowing, followers: v.ownFollowers, leadFollowing: v.followingRead };
    if (typeof v.followers === "number") counts.leadFollowers = v.followers;
    if (v.notFound) return line("x", l.state, "not_found", sentences([`@${v.handle} was not found on X. Check their handle under Details.`, ...note]), { at: v.checkedAt, mutuals: false });
    if (v.protected) return line("x", l.state, "private", sentences(["their account is private.", ...note]), { counts, at: v.checkedAt, mutuals: false });
    if (v.unavailable) return line("x", l.state, "unavailable", sentences(["their account is suspended or unavailable.", ...note]), { counts, at: v.checkedAt, mutuals: false });
    const main =
      l.state === "cached"
        ? `${xCheckedDetail({ ownHandle: v.ownHandle, ownFollowing: v.ownFollowing, leadHandle: v.handle, leadFollowing: v.followingRead, costUsd: null }).replace(/\.$/, "")} on ${shortDate(v.checkedAt, now)}.`
        : xCheckedDetail({ ownHandle: v.ownHandle, ownFollowing: v.ownFollowing, leadHandle: v.handle, leadFollowing: v.followingRead, costUsd: v.costUsd });
    const capped = cappedNote(v);
    // A gap (time ran out, a page failed, the budget had no room): not the cap, which says so above.
    const partial = v.partial ? ["partly checked: not everything could be read."] : [];
    // A check that could not run this time keeps the earlier result, and says why.
    const why = l.state === "cached" && l.reason === "budget" ? [budget] : l.state === "cached" && l.reason === "paused" ? ["X checks are paused."] : [];
    const reason: WarmSourceReason | null = why.length ? l.reason : v.partial ? "partial" : null;
    // Their follows were read and compared with your lists (all of them, or the newest 5,000).
    const compared = v.followingRead > 0 || v.following === 0;
    return line("x", l.state, reason, sentences([main, capped, ...partial, ...why, ...note]), {
      counts,
      at: v.checkedAt,
      costUsd: l.state === "checked" ? v.costUsd : null,
      mutuals: compared,
    });
  }
  if (l.state === "skipped") {
    if (l.reason === "budget") return line("x", "skipped", "budget", sentences([budget, ...note]));
    if (l.reason === "paused") return line("x", "skipped", "paused", sentences(["X checks are paused.", ...note]));
    return line("x", "skipped", l.reason, sentences(["not checked this time.", ...note]));
  }
  // The line reads "X: did not answer (...)": the network's name is the label.
  if (l.state === "failed") return line("x", "failed", l.reason ?? "upstream", sentences([`did not answer (${shortError(l.error)}).`, ...note]), { at: null });
  return line("x", "skipped", null, sentences(["not checked yet.", ...note]));
}

export function instagramSource(input: SourceInputs): WarmPathSource {
  if (!input.setup.instagram) return line("instagram", "not_set_up", "no_owner_handle", "not set up.");
  if (input.lead.instagramHandle) return line("instagram", "skipped", "link_only", "open their profile to see who you both follow.");
  return line("instagram", "lead_unknown", "no_handle", "their Instagram is not known. Add it under Details.");
}

/** One line per network: LinkedIn, X, Instagram. */
export function composeSources(input: SourceInputs): WarmPathSource[] {
  return [linkedinSource(input), xSource(input), instagramSource(input)];
}

/** "error" when every source that could run failed (none checked or cached), else "done". */
export function checkStatus(sources: ReadonlyArray<WarmPathSource>): "done" | "error" {
  const ran = sources.filter((s) => s.network !== "instagram" && s.state !== "not_set_up" && s.state !== "lead_unknown");
  if (!ran.length) return "done";
  return ran.every((s) => s.state === "failed") ? "error" : "done";
}
