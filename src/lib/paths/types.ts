/**
 * Warm paths: who can introduce the owner (the sender in Settings) to a lead. Types and constants
 * only, safe to import from client and server code. The engine lives in src/lib/paths/engine.ts
 * (server), the words the panel shows in src/lib/paths/copy.ts (client-safe).
 *
 * A path is either You -> lead (one link, hops 1) or You -> connector -> lead (two links, hops 2).
 * Each link carries the evidence for it. Points are computed (src/lib/paths/score.ts) but never
 * shown: the panel shows a strength word and the evidence.
 */
import type { Stage } from "../types";

// ------------------------------------------------------------------ strengths and evidence

export const WARM_STRENGTHS = ["strong", "medium", "weak"] as const;
export type WarmStrength = (typeof WARM_STRENGTHS)[number];

/** The networks paths come from. Instagram is a link and a handle only: nothing is ever read from it. */
export type WarmNetwork = "linkedin" | "x";

/**
 * One piece of evidence on a link. Years are whole years; toYear null means "still going".
 * - linkedin_1st: LinkedIn 1st degree. On your link: the person is in your Connections.csv (since:
 *   its "Connected On" as YYYY-MM-DD) or your LinkedIn account found them as a shared connection
 *   (since null). On the lead's link: a shared connection found on your LinkedIn account (step 2).
 *   On a direct path: the lead is your 1st-degree connection.
 * - worked_together: the same company with overlapping dates (your profile vs the lead's).
 * - same_school: the same school; years overlap, or are unknown (fromYear and toYear null: shown,
 *   scores 0).
 * - works_at: both work there now, start dates unknown. On a link: you and the connector (your
 *   export's Company column vs your current role), or the connector and the lead (a shared
 *   connection's current position vs the lead's current company). As a company person (no path):
 *   your connection's Company column, asOf the export date; leadLeftYear when the lead has left
 *   that company (the year they left), absent while the lead works there.
 * - mutual_follow: you follow each other on X (or the connector and the lead do).
 * - follows: a one-way X follow. "connector_follows_you" (your link) and "lead_follows_connector"
 *   (the lead's link) count a little; "you_follow_connector" and "connector_follows_lead" are only
 *   shown next to other evidence. On a direct path the "connector" is the lead.
 */
export type Evidence =
  | { kind: "linkedin_1st"; since: string | null }
  | { kind: "worked_together"; org: string; fromYear: number; toYear: number | null }
  | { kind: "same_school"; org: string; fromYear: number | null; toYear: number | null }
  | { kind: "works_at"; org: string; asOf: string | null; leadLeftYear?: number }
  | { kind: "mutual_follow"; network: "x" }
  | { kind: "follows"; network: "x"; who: FollowDirection };

export type EvidenceKind = Evidence["kind"];

export type FollowDirection = "connector_follows_you" | "you_follow_connector" | "lead_follows_connector" | "connector_follows_lead";

/** One link of a path, its evidence best first. strength is null on a company person's row. */
export interface WarmLink {
  strength: WarmStrength | null;
  evidence: Evidence[];
}

/** The person in the middle of a two-hop path, or a person at the lead's company. */
export interface WarmConnector {
  name: string;
  /** Their position or LinkedIn headline, e.g. "Head of Operations". */
  title: string | null;
  /** Their current company, when known. */
  company: string | null;
  linkedinUrl: string | null;
  /** Without "@". */
  xHandle: string | null;
  /** When the connector is also a lead in the app: that lead's id and stage ("Also a lead: Replied"). */
  leadId: string | null;
  leadStage: Stage | null;
}

/**
 * One way to reach the lead.
 * - id: stable across checks and opaque: "direct" for You -> lead, "li-" and 12 hex characters
 *   for a LinkedIn person, "x-" and 12 hex characters for an X-only person (a hash of the lead and
 *   the person's key: src/lib/paths/ids.ts), so no name, slug or handle is ever in a URL. Intro
 *   drafts and "asked" dates are kept by this id.
 * - rank: 1 is best, in the order of `paths` (company people are ranked among themselves).
 * - hops: 1 (You -> lead, connector null) or 2 (You -> connector -> lead).
 * - links: hops 1: [the link between you and the lead]; hops 2: [your link, the lead's link].
 *   A company person has one link (the lead's company), strength null.
 */
export interface WarmPath {
  id: string;
  rank: number;
  hops: 1 | 2;
  strength: WarmStrength | null;
  connector: WarmConnector | null;
  links: WarmLink[];
  introDraft: { message: string; createdAt: string } | null;
  askedAt: string | null;
}

// ------------------------------------------------------------------ what the lead page gets

export type WarmPathsStatus = "idle" | "running" | "done" | "error";

export type WarmSourceNetwork = "linkedin" | "x" | "instagram";

export type WarmSourceState = "checked" | "cached" | "not_set_up" | "lead_unknown" | "skipped" | "failed";

/**
 * Why a source is in its state, for the UI to branch on (the sentence is in `detail`).
 * - not_configured: the server has no key for it (TWITTERAPI_IO_KEY), or step 2 is off.
 * - no_owner_handle / no_owner_data: you have not given your handle / uploaded connections.
 * - no_profile: the lead has no LinkedIn profile yet. no_target: research must run again to read it.
 * - no_handle: the lead's X (or Instagram) account is not known.
 * - budget / paused: the daily budget is used up / set to 0. gap: the LinkedIn minimum gap.
 * - account_paused: checks on your LinkedIn account are paused (pausedUntil): LinkedIn slowed it down, Unipile refused the key, or an error.
 * - needs_reconnect: your LinkedIn account needs reconnecting in Unipile.
 * - private / unavailable / not_found: the lead's X account.
 * - unverified: LinkedIn's shared-connections list failed a safety check and was not used.
 * - partial: time ran out; what was read is shown.
 * - upstream / timeout: the provider failed.
 * - link_only: Instagram: a link to open, nothing is read.
 */
export type WarmSourceReason =
  | "not_configured"
  | "no_owner_handle"
  | "no_owner_data"
  | "no_profile"
  | "no_target"
  | "no_handle"
  | "budget"
  | "paused"
  | "gap"
  | "account_paused"
  | "needs_reconnect"
  | "private"
  | "unavailable"
  | "not_found"
  | "unverified"
  | "partial"
  | "upstream"
  | "timeout"
  | "link_only";

/** Counts behind a source line. Never names. */
export interface WarmSourceCounts {
  /** LinkedIn: your connections matched against. */
  connections?: number;
  /** X: the accounts you follow, and your followers. */
  following?: number;
  followers?: number;
  /** X: the lead's follows read, and their follower count. */
  leadFollowing?: number;
  leadFollowers?: number;
  /** LinkedIn step 2: the shared connections LinkedIn counts. */
  shared?: number;
  /** LinkedIn: your connections at the lead's companies, all of them (up to 5 are listed as company people). */
  atCompanies?: number;
}

/**
 * How your work and school history was compared with the lead's (the LinkedIn line):
 * - compared: both were known and compared.
 * - no_profile: your LinkedIn profile URL is not in Settings.
 * - own_unread: your profile has not been read yet (or the last read failed).
 * - lead_unread: the lead's work history is not known yet (research reads it).
 */
export type WarmHistoryState = "compared" | "no_profile" | "own_unread" | "lead_unread";

/** One footer line: "LinkedIn: matched your 1,240 connections (export of Nov 2)." */
export interface WarmPathSource {
  network: WarmSourceNetwork;
  state: WarmSourceState;
  reason: WarmSourceReason | null;
  /** The sentence after "LinkedIn: ", ending with a full stop. No names, keys or URLs. */
  detail: string;
  counts: WarmSourceCounts;
  /** When the data behind this line was read: the export date, or the live check. */
  at: string | null;
  /** X: what this check cost, in USD (estimated from the credits). */
  costUsd: number | null;
  /**
   * True when this line's check really looked for people you both know: LinkedIn on your own
   * account (the lead's degree, and for a 2nd-degree lead the shared connections, confirmed), or
   * X (the lead's follows read and compared with your lists). The panel says that nobody links
   * you to the lead only when a line has it (src/lib/paths/copy.ts mutualsChecked).
   */
  mutuals?: boolean;
  /** LinkedIn only: how your work and school history was compared with the lead's. */
  history?: WarmHistoryState;
}

/** The check-yourself links, opened in the owner's own logged-in browser. Each is null when the lead lacks it. */
export interface WarmPathLinks {
  /** LinkedIn's shared-connections search for the lead, else their profile ("N mutual connections"). */
  linkedinMutuals: string | null;
  /** X's "Followers you know" for the lead's handle. */
  xFollowersYouKnow: string | null;
  /** The lead's Instagram profile ("Followed by ..."). */
  instagram: string | null;
}

/** Which of the owner's sources are set up. Booleans only. */
export interface WarmPathSetup {
  /** A Connections.csv upload is stored. */
  linkedinConnections: boolean;
  /** Your LinkedIn profile URL is in Settings (your roles and schools are read from it). */
  linkedinProfile: boolean;
  /** UNIPILE_NETWORK_ACCOUNT_ID is set (step 2). */
  linkedinAccount: boolean;
  /** TWITTERAPI_IO_KEY is set and your X handle is in Settings. */
  x: boolean;
  /** Your Instagram handle is in Settings (only shows the Instagram row). */
  instagram: boolean;
  /** Any of the above but Instagram: something can be checked. */
  any: boolean;
  /** TWITTERAPI_IO_KEY is set, so your X handle in Settings turns X checks on. Absent counts as false. */
  xAvailable?: boolean;
}

/**
 * GET /api/leads/[id] -> LeadDetail.paths. Null before the first research run of a lead that has
 * never been checked (unless a connections upload gave it a "Connected" chip: its free part is
 * computed then, so the page says what the chip says) and when the tables are not there yet.
 * - status: idle (never checked), running (a check is going; startedAt says since when: one
 *   started more than 90 s ago counts as failed), done, error (every source failed).
 * - checkedAt: when the last check finished.
 * - paths: up to 10, sorted best first. companyPaths: up to 5 people at the lead's company (current
 *   first, then companies the lead left within 8 years), strength null, never ranked as paths.
 * - linkedinShared: step 2's count of shared connections and how many are shown, else null.
 * - limits: what is left today, null for a budget whose source is not set up.
 * - leadFirstName: for the copy helpers ("Works with Ada at ...").
 */
export interface WarmPaths {
  status: WarmPathsStatus;
  startedAt: string | null;
  checkedAt: string | null;
  sources: WarmPathSource[];
  linkedinShared: { count: number; shown: number } | null;
  paths: WarmPath[];
  companyPaths: WarmPath[];
  links: WarmPathLinks;
  limits: { linkedinChecksLeft: number | null; xUsdLeft: number | null };
  setup: WarmPathSetup;
  leadFirstName: string;
  /** The lead's Instagram handle and where it came from, for the Details panel. */
  instagram: { handle: string; source: "profile" | "manual" } | null;
  error: string | null;
}

/**
 * le_leads.warm_path, carried on every Lead (Lead.warmPath): the best Strong or Medium path, or
 * null. Drives the "Warm path" and "Connected" chips on Leads and Pipeline.
 * - connected: a direct, confirmed tie (LinkedIn 1st degree or a mutual X follow, as isConfirmedTie
 *   in src/lib/paths/score.ts; a one-way follow is never a tie): the "Connected" chip.
 * - via: the connector's name on a two-hop path (search matches it), else null.
 * - label: the chip's tooltip, e.g. "Medium path via Priya Shah" or "LinkedIn 1st degree".
 */
export interface WarmPathSummary {
  strength: "strong" | "medium";
  hops: 1 | 2;
  via: string | null;
  network: "linkedin" | "x" | "mixed";
  connected: boolean;
  label: string;
  checkedAt: string;
}

// ------------------------------------------------------------------ the lead's side (stored)

/** One of the lead's roles. Dates as LinkedIn gives them: "YYYY-MM", "YYYY" or null (open-ended). */
export interface TargetRole {
  company: string;
  /** normaliseName(company). */
  companyKey: string;
  companyLinkedinUrl: string | null;
  from: string | null;
  to: string | null;
  current: boolean;
}

export interface TargetSchool {
  school: string;
  /** LinkedIn's school id, when Unipile gave one. */
  schoolId: string | null;
  from: string | null;
  to: string | null;
}

/**
 * le_warm_paths.target: the lead's keys, so a check can run outside a research run. Captured during
 * research (src/lib/paths/target.ts), or by one Unipile-only profile read for a lead researched
 * before warm paths existed. roles: up to 12; schools: up to 5. companySize: the lead's current
 * company's employee count when the company page was read.
 */
export interface WarmPathTarget {
  linkedinSlug: string | null;
  linkedinPublicId: string | null;
  /** LinkedIn's member id ("ACo..."): the shared-connections search needs it. */
  linkedinMemberId: string | null;
  roles: TargetRole[];
  schools: TargetSchool[];
  companySize: number | null;
  /** normaliseName of the company companySize belongs to (the lead's main current role). */
  companySizeKey?: string | null;
  /** The verified handle the target was captured with (the lead row is the source of truth). */
  xHandle: string | null;
  xUserId: string | null;
  instagramHandle: string | null;
  instagramSource: "profile" | "manual" | null;
  capturedAt: string;
}

// ------------------------------------------------------------------ the owner's side (Settings)

export type LinkedinAccountState = "not_set_up" | "connected" | "needs_reconnect" | "paused";

/**
 * GET /api/network: counts and states only. No route ever returns the owner's contact lists.
 * - linkedin.connections: the stored Connections.csv (count, the export's date, the upload's).
 * - linkedin.self: your profile URL and when it was last read, with how many roles and schools.
 * - linkedin.account: step 2, your own LinkedIn on Unipile (UNIPILE_NETWORK_ACCOUNT_ID).
 * - x: twitterapi.io and your lists; usd figures from the daily budget.
 */
export type LinkedinPauseKind = "rate_limited" | "auth" | "error";

export interface NetworkStatus {
  linkedin: {
    connections: { count: number; exportedAt: string | null; uploadedAt: string } | null;
    self: { url: string; readAt: string | null; roles: number; schools: number; error: string | null } | null;
    account: {
      state: LinkedinAccountState;
      premium: boolean | null;
      salesNavigator: boolean | null;
      pausedUntil: string | null;
      /** Why the account is paused: LinkedIn slowed it down (429), Unipile refused the key (401), or an error. Null when not paused. */
      pauseKind: LinkedinPauseKind | null;
      checksToday: number;
      checksLimit: number;
    };
  };
  x: {
    configured: boolean;
    handle: string | null;
    following: number | null;
    followers: number | null;
    syncedAt: string | null;
    /** True while a refresh of your lists is running. */
    running: boolean;
    error: string | null;
    usdToday: number;
    usdLimit: number;
  };
  instagram: { handle: string | null };
}

// ------------------------------------------------------------------ limits

/** The lead's follows an X check reads at most (the newest first): a read that stops here is complete for its purpose. */
export const LEAD_FOLLOWING_MAX = 5000;

/** Paths kept per lead, and company people. */
export const MAX_PATHS = 10;
export const MAX_COMPANY_PATHS = 5;
/** Paths the panel shows before "Show N more": up to 3 rated Medium or better, else the best Weak one. */
export const PANEL_PATHS = 3;
/** A check that started longer ago than this counts as failed (the page stops polling). */
export const CHECK_STALE_MS = 90_000;
/** How long live results are reused before a check reads them again (Check again always does). */
export const LINKEDIN_LIVE_TTL_MS = 30 * 86_400_000;
/** A LinkedIn check whose shared-connections search failed (an error or a timeout) is reused for an hour only. */
export const LINKEDIN_LIVE_FAILED_TTL_MS = 60 * 60_000;
export const X_LIVE_TTL_MS = 7 * 86_400_000;
/** An X check cut short before it read the lead's follows (time ran out, a page failed) is reused only this long. */
export const X_LIVE_PARTIAL_TTL_MS = 3_600_000;
/** Your X lists are refreshed at most this often. Your own profile, at most this often. */
export const OWN_X_LISTS_TTL_MS = 86_400_000;
export const OWN_PROFILE_TTL_MS = 30 * 86_400_000;
/** The longest intro draft the owner can save. */
export const INTRO_DRAFT_MAX = 2000;
/** Connections.csv upload: rows per part, parts per upload, bytes per part. */
export const CONNECTIONS_ROWS_PER_PART = 5000;
export const CONNECTIONS_MAX_PARTS = 6;
export const CONNECTIONS_PART_MAX_BYTES = 4 * 1024 * 1024;
