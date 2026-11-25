import "server-only";
import { hasEnv } from "../env";
import { linkedinSlug, normaliseLinkedinUrl } from "../linkedin-url";
import { getProfileUnipileOnly, networkAccountConfigured, type LinkedInCompany, type LinkedInProfile } from "../providers/linkedin";
import { addUsage, getLead } from "../repo/leads";
import {
  claimNetworkSource,
  connectionsAtCompanies,
  connectionsBySlugs,
  getNetworkSources,
  saveNetworkSource,
  type NetworkSourceKey,
  type NetworkSourceRow,
} from "../repo/network";
import {
  claimWarmPathCheck,
  failWarmPathCheck,
  getWarmPathRow,
  leadIdsToBackfill,
  leadsBySlugsOrHandles,
  releaseWarmPathCheck,
  saveWarmPathResult,
  saveWarmPathTarget,
  storedResearchLinkedin,
  warmPathLeadIds,
  type LinkedinLive,
  type WarmPathRow,
  type XLive,
} from "../repo/paths";
import { quotaLimit, quotaUsed, releaseQuota, reserveQuota, X_CREDITS_PER_USD } from "../repo/quota";
import { getSettings } from "../repo/settings";
import { cleanXHandle, errorMessage, withTimeout } from "../research/util";
import type { Lead, Settings } from "../types";
import { buildPaths, type BuildInput, type ContactLike, type OwnProfile } from "./build";
import { firstNameOf, sourceLine, warmPathsEventMessage } from "./copy";
import { publicPathId } from "./ids";
import { checkLeadLinkedin, linkedinLiveMatches, type LeadLinkedinResult } from "./linkedin-check";
import { cleanInstagramHandle, instagramProfileUrl, linkedinMutualsUrl, xFollowersYouKnowUrl } from "./links";
import { leadCompanies } from "./overlap";
import { checkStatus, composeSources, type PartOutcome } from "./sources";
import { summarizePaths } from "./summary";
import { captureTarget, rolesFromProfile, schoolsFromProfile, targetIsCaptured } from "./target";
import {
  CHECK_STALE_MS,
  OWN_PROFILE_TTL_MS,
  X_LIVE_PARTIAL_TTL_MS,
  X_LIVE_TTL_MS,
  type TargetRole,
  type WarmPath,
  type WarmPaths,
  type WarmPathSetup,
  type WarmPathSource,
  type WarmPathTarget,
} from "./types";
import { checkLeadX, LEAD_FOLLOWING_MAX, refreshOwnXLists, type OwnXResult } from "./x-check";

/**
 * The warm-path engine: who can introduce the owner to a lead. Two entry points use it:
 * research (src/lib/paths/research.ts starts it after gather) and POST /api/leads/[id]/paths
 * ("Find warm paths" / "Check again"). GET /api/leads/[id] uses loadWarmPaths, which redoes the
 * free part (SQL only, no outside call) when the owner's network changed since the last check.
 *
 * A check, in order:
 *  1. the lead's side (target): from the research run, from le_warm_paths.target, or one
 *     Unipile-only profile read for a lead researched before warm paths existed;
 *  2. the free part: the lead in your connections (LinkedIn 1st degree), your roles and schools
 *     against theirs, your connections at their company;
 *  3. LinkedIn on your own account (step 2) and X through twitterapi.io, in parallel, each behind
 *     its daily budget and cached (30 and 7 days) unless "Check again";
 *  4. one row per person, scored and ranked: 10 paths and 5 company people are kept, with the
 *     list summary (le_leads.warm_path).
 * Never throws: every outcome comes back as a value, with one line per network.
 */

const DEFAULT_BUDGET_MS = 50_000;
/** The X part (your lists and the lead's) gets at most this much of a check. */
const X_PART_MS = 45_000;
/** A Unipile-only profile read (the lead's or your own): 15 s for the call, a little more for the wait. */
const PROFILE_READ_MS = 16_000;
/** After a read of your own profile failed (here or by Read now), checks wait this long before trying again; a new URL in Settings resets it. */
const OWN_PROFILE_RETRY_MS = 24 * 3_600_000;

/**
 * One unit of the daily budget for LinkedIn profile reads on the research account outside research
 * runs (the app may run open: a loop of "Check again" must not keep reading LinkedIn, whatever URL
 * is set). The reservation id, or null when the budget has no room (or the database did not answer).
 */
async function takeProfileRead(leadId: string | null): Promise<string | null> {
  const slot = await reserveQuota("profile_read", 1, leadId).catch(() => null);
  return slot?.ok ? slot.id : null;
}

export type WarmPathTrigger = "research" | "button";

export interface FindWarmPathsOptions {
  trigger: WarmPathTrigger;
  /** "Check again": read LinkedIn and X even when the cached results are recent. */
  force?: boolean;
  /** The most the whole check may take, in ms. Default 50 s. */
  budgetMs?: number;
  /**
   * Research only: what the run read. With `profileRead`, the engine never reads the profile
   * again, even when the run could not (a failed read is not retried by warm paths).
   */
  profile?: LinkedInProfile | null;
  company?: Pick<LinkedInCompany, "employeeCount" | "linkedinUrl" | "name"> | null;
  profileRead?: boolean;
  /** Tests: the clock. */
  now?: () => number;
}

export type WarmPathOutcome = "found" | "none" | "not_set_up" | "nothing_to_check" | "busy" | "lead_missing" | "error";

export interface FindWarmPathsResult {
  /**
   * found: at least one path. none: checked, no path (company people may be there).
   * not_set_up: nothing of yours is set up (the target is still saved). nothing_to_check: the lead
   * has no LinkedIn profile and no X handle. busy: a check is already running for this lead.
   * lead_missing: no such lead, or the lead was deleted or got another LinkedIn profile during the
   * check (nothing was saved). error: the check failed unexpectedly (paths kept as they were).
   */
  outcome: WarmPathOutcome;
  /** What GET /api/leads/[id] would now show (null for lead_missing and busy). */
  paths: WarmPaths | null;
  /** One line for the 'tool' event and the reply, never naming anyone: "Warm paths: best via someone you know (Medium, LinkedIn)". */
  message: string;
  /**
   * The live sources (LinkedIn on your account, X) this lead could use, and which of them were
   * over their daily budget or failed. Answer 429 warm_path_budget when every one set up is over
   * budget, 502 upstream when every one failed and nothing else was checked (paths.status error);
   * the free part is saved either way.
   */
  live: { setUp: Array<"linkedin" | "x">; overBudget: Array<"linkedin" | "x">; failed: Array<"linkedin" | "x"> };
  spent: { xCredits: number; xUsd: number; linkedinRequests: number };
}

// ------------------------------------------------------------------ what is set up

export function setupOf(settings: Settings, sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>): WarmPathSetup {
  const linkedinConnections = (sources.linkedin_csv?.itemCount ?? 0) > 0;
  const linkedinProfile = Boolean(normaliseLinkedinUrl(settings.linkedinUrl ?? ""));
  const linkedinAccount = networkAccountConfigured();
  const x = hasEnv("TWITTERAPI_IO_KEY") && Boolean(cleanXHandle(settings.xHandle));
  const instagram = Boolean(cleanInstagramHandle(settings.instagramHandle));
  return { linkedinConnections, linkedinProfile, linkedinAccount, x, instagram, any: linkedinConnections || linkedinProfile || linkedinAccount || x, xAvailable: hasEnv("TWITTERAPI_IO_KEY") };
}

/** Your own roles and schools, when they were read from the profile URL now in Settings. */
export function ownProfileOf(settings: Settings, sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>): { profile: OwnProfile | null; readAt: string | null } {
  const url = normaliseLinkedinUrl(settings.linkedinUrl ?? "");
  const self = sources.linkedin_self;
  if (!url || !self || self.data.url !== url || !Array.isArray(self.data.roles)) return { profile: null, readAt: null };
  return {
    profile: { roles: self.data.roles as TargetRole[], schools: Array.isArray(self.data.schools) ? (self.data.schools as OwnProfile["schools"]) : [] },
    readAt: typeof self.data.readAt === "string" ? self.data.readAt : null,
  };
}

/** The cached X check, when it was made for the lead's current handle and your current handle. */
export function validXLive(live: XLive | null | undefined, lead: Pick<Lead, "xHandle">, settings: Pick<Settings, "xHandle">): XLive | null {
  const leadHandle = cleanXHandle(lead.xHandle);
  const own = cleanXHandle(settings.xHandle);
  if (!live || !leadHandle || !own) return null;
  return live.handle.toLowerCase() === leadHandle.toLowerCase() && live.ownHandle.toLowerCase() === own.toLowerCase() ? live : null;
}

/** The sources whose synced_at marks a change of your network (as networkChangedAt in src/lib/repo/network.ts). */
const NETWORK_CHANGE_KEYS: readonly NetworkSourceKey[] = ["linkedin_csv", "linkedin_self", "x_following", "x_followers"];

/** When your network last changed, from the source rows already read (no query of its own). */
export function networkChangedAtOf(sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>): string | null {
  let latest: string | null = null;
  for (const key of NETWORK_CHANGE_KEYS) {
    const at = sources[key]?.syncedAt;
    if (at && Number.isFinite(Date.parse(at)) && (latest === null || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}

/**
 * A lead research saw while nothing of yours was set up (its row holds the lead's side and was never
 * computed): the free part can run once it has something to compare, your connections or your own
 * profile as read. SQL only.
 */
export function readyForFreePart(row: WarmPathRow | null, settings: Settings, sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>): boolean {
  return Boolean(row && !row.computedAt && row.status !== "running" && targetIsCaptured(row.target) && (setupOf(settings, sources).linkedinConnections || ownProfileOf(settings, sources).profile));
}

/** The parts of the setup the footer lines and paths depend on. */
const SETUP_KEYS = ["linkedinConnections", "linkedinProfile", "linkedinAccount", "x", "xAvailable", "instagram"] as const;

/** True when two setups differ in what is set up (a missing one counts as different). */
export function setupChanged(before: WarmPathSetup | null | undefined, now: WarmPathSetup): boolean {
  if (!before) return true;
  return SETUP_KEYS.some((k) => Boolean(before[k]) !== Boolean(now[k]));
}

/**
 * True when the stored paths no longer match what they were computed from: your network changed
 * since (an upload, a list refresh, your profile), what is set up changed (a key added or removed
 * on the server, a handle or URL in Settings: the footer lines follow it), the lead's X handle or
 * your own changed, or the lead's profile changed. GET /api/leads/[id] then redoes the free part,
 * which keeps the cached live results.
 */
export function warmPathsStale(row: WarmPathRow | null, lead: Pick<Lead, "xHandle" | "linkedinSlug">, settings: Settings, changedAt: string | null, setup?: WarmPathSetup): boolean {
  if (!row?.computedAt || row.status === "running") return false;
  if (changedAt && Date.parse(changedAt) > Date.parse(row.computedAt)) return true;
  if (setup && setupChanged(row.setup, setup)) return true;
  if (row.xLive && !validXLive(row.xLive, lead, settings)) return true;
  // A different profile, or a first one added to a lead that had none (its row is kept).
  if (lead.linkedinSlug && row.target?.linkedinSlug !== lead.linkedinSlug) return true;
  const xKnown = (row.target?.xHandle ?? "").toLowerCase();
  if ((cleanXHandle(lead.xHandle) ?? "").toLowerCase() !== xKnown && row.sources.some((s) => s.network === "x" && s.state !== "not_set_up")) return true;
  return false;
}

// ------------------------------------------------------------------ the free part and the build

interface ComputeInput {
  lead: Lead;
  settings: Settings;
  sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>;
  setup: WarmPathSetup;
  row: WarmPathRow | null;
  target: WarmPathTarget;
  own: { profile: OwnProfile | null; state: "ok" | "missing" | "not_set_up" };
  linkedin: PartOutcome<LinkedinLive>;
  x: { own: { reason: WarmPathSource["reason"] & string; error: string } | null; ownNote: string | null; lead: PartOutcome<XLive> };
  now: Date;
}

interface Computed {
  paths: WarmPath[];
  companyPaths: WarmPath[];
  sources: WarmPathSource[];
  status: "done" | "error";
  /** The setup the paths were computed with (stored, so a change of setup makes them stale). */
  setup: WarmPathSetup;
}

const exportDateOf = (sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>): string | null => {
  const d = sources.linkedin_csv?.data ?? {};
  return typeof d.exportedAt === "string" ? d.exportedAt : typeof d.uploadedAt === "string" ? d.uploadedAt : (sources.linkedin_csv?.syncedAt ?? null);
};

async function compute(c: ComputeInput): Promise<Computed> {
  const { lead, target, setup, now } = c;
  // People at their company come only from the roles read from the lead's LinkedIn profile, never
  // from the company name, which anyone can edit on an open deploy: typing a company (or 4 letters
  // of one) would list your connections there, 5 at a time, with no outside call and no budget.
  const roles: TargetRole[] = target.roles;
  const mutuals = c.linkedin.live?.verified ? c.linkedin.live.mutuals : [];
  const xLive = c.x.lead.live && !c.x.lead.live.protected && !c.x.lead.live.unavailable && !c.x.lead.live.notFound ? c.x.lead.live : null;

  const slugs = [
    lead.linkedinSlug,
    target.linkedinPublicId?.toLowerCase() ?? null,
    target.linkedinMemberId,
    ...mutuals.map((m) => m.slug),
    ...(xLive?.connectors ?? []).map((x) => x.linkedinSlug),
  ];
  const companies = leadCompanies(roles.map((r) => ({ ...r, companyKey: r.companyKey || "" })), now);
  const [bySlug, companyContacts] = await Promise.all([
    setup.linkedinConnections ? connectionsBySlugs(slugs) : Promise.resolve([]),
    // By name: a company matches as a whole word or words, never part of one (sameCompanyWords).
    setup.linkedinConnections && companies.length ? connectionsAtCompanies(companies.map((x) => x.company)) : Promise.resolve([]),
  ]);
  const connections = new Map<string, ContactLike>(bySlug.map((x) => [x.slug, x]));
  const directKeys = [lead.linkedinSlug, target.linkedinPublicId?.toLowerCase(), target.linkedinMemberId].filter((k): k is string => Boolean(k));
  const directConnection = directKeys.map((k) => connections.get(k)).find(Boolean) ?? null;

  const handles = (xLive?.connectors ?? []).map((x) => x.handle);
  const personSlugs = [...mutuals.map((m) => m.slug), ...(xLive?.connectors ?? []).map((x) => x.linkedinSlug), ...companyContacts.map((x) => x.slug)].filter((s): s is string => Boolean(s));
  const others = await leadsBySlugsOrHandles([...new Set(personSlugs)], [...new Set(handles)], lead.id).catch(() => []);
  const alsoLeads: BuildInput["alsoLeads"] = { bySlug: new Map(), byHandle: new Map() };
  for (const o of others) {
    if (o.slug) alsoLeads.bySlug.set(o.slug, { id: o.id, stage: o.stage });
    if (o.xHandle) alsoLeads.byHandle.set(o.xHandle.toLowerCase(), { id: o.id, stage: o.stage });
  }

  const built = buildPaths({
    now,
    leadCompany: lead.companyName,
    leadSlug: lead.linkedinSlug,
    target,
    own: c.own.profile,
    directConnection,
    directFirstDegree: c.linkedin.live?.distance === "FIRST_DEGREE",
    mutuals,
    xDirect: xLive ? { youFollow: xLive.you.youFollow, followsYou: xLive.you.followsYou, leadFollowers: xLive.followers } : null,
    xConnectors: xLive?.connectors ?? [],
    connections,
    companyContacts,
    exportedAt: exportDateOf(c.sources),
    alsoLeads,
  });
  const intros = c.row?.intros ?? {};
  // Paths are built under internal keys ("li:<slug>"); stored and served under opaque ids.
  const withIntros = (p: Omit<WarmPath, "introDraft" | "askedAt">): WarmPath => {
    const id = publicPathId(lead.id, p.id);
    return { ...p, id, introDraft: intros[id]?.introDraft ?? null, askedAt: intros[id]?.askedAt ?? null };
  };

  const xLimit = quotaLimit("warm_path_x");
  const sources = composeSources({
    now,
    setup,
    lead: { hasLinkedin: Boolean(lead.linkedinUrl), xHandle: cleanXHandle(lead.xHandle), instagramHandle: target.instagramHandle, researched: Boolean(lead.researchFinishedAt) || lead.researchStatus === "running" },
    linkedin: {
      connections: setup.linkedinConnections ? (c.sources.linkedin_csv?.itemCount ?? 0) : null,
      atCompanies: built.companyTotal,
      exportedAt: exportDateOf(c.sources),
      ownProfile: c.own.state,
      targetCaptured: targetIsCaptured(target),
      live: c.linkedin,
    },
    x: { own: c.x.own, ownNote: c.x.ownNote, lead: c.x.lead, budgetUsd: xLimit / X_CREDITS_PER_USD, configured: hasEnv("TWITTERAPI_IO_KEY") },
  });
  return { paths: built.paths.map(withIntros), companyPaths: built.companyPaths.map(withIntros), sources, status: checkStatus(sources), setup };
}

// ------------------------------------------------------------------ your own profile

/**
 * Your roles and schools from the profile URL in Settings, read again when older than 30 days (a
 * Unipile-only read on the research account during a check). After a failed read (here or by Read
 * now) it waits a day; a new URL in Settings or a successful read clears that. `budgeted` (a check
 * outside a research run): the read takes a unit of the daily profile-read budget first, and is
 * skipped when there is none. Never throws.
 */
async function ownProfileFor(
  settings: Settings,
  sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>,
  opts: { live: boolean; budgeted?: boolean; stopAt: number; now: () => number },
): Promise<{ profile: OwnProfile | null; state: "ok" | "missing" | "not_set_up" }> {
  const url = normaliseLinkedinUrl(settings.linkedinUrl ?? "");
  if (!url) return { profile: null, state: "not_set_up" };
  const known = ownProfileOf(settings, sources);
  const kept = { profile: known.profile, state: known.profile ? ("ok" as const) : ("missing" as const) };
  const fresh = known.profile && known.readAt && opts.now() - Date.parse(known.readAt) < OWN_PROFILE_TTL_MS;
  // A failed read leaves a detail on the row (status error, or ok while an older profile is kept).
  const self = sources.linkedin_self;
  const failedRecently = Boolean(self && self.status !== "running" && self.detail && opts.now() - Date.parse(self.updatedAt) < OWN_PROFILE_RETRY_MS);
  if (fresh || failedRecently || !opts.live || opts.stopAt - opts.now() < 12_000) return kept;
  let slot: string | null = null;
  try {
    if (opts.budgeted) {
      slot = await takeProfileRead(null);
      if (!slot) return kept;
    }
    if (!(await claimNetworkSource("linkedin_self", 2 * 60_000))) {
      if (slot) await releaseQuota(slot);
      return kept;
    }
    const res = await withTimeout(getProfileUnipileOnly(url), Math.min(PROFILE_READ_MS, opts.stopAt - opts.now() - 5000), "Reading your LinkedIn profile").catch((err) => ({
      profile: null,
      error: errorMessage(err),
      sent: true,
    }));
    if (!res.profile) {
      if (!res.sent) {
        // Nothing reached LinkedIn (Unipile off, or a cooldown): the unit goes back, and there is no failure to wait a day for.
        if (slot) await releaseQuota(slot);
        await saveNetworkSource("linkedin_self", { status: self?.status === "error" ? "error" : "ok" });
        return kept;
      }
      await saveNetworkSource("linkedin_self", { status: known.profile ? "ok" : "error", detail: `Could not read your profile (${(res.error ?? "no profile").slice(0, 160)}).` });
      return kept;
    }
    const profile = await saveOwnProfile(url, res.profile, opts.now());
    return { profile, state: "ok" };
  } catch {
    return kept;
  }
}

/** Stores your roles and schools from a profile read (linkedin_self); the network counts as changed. */
export async function saveOwnProfile(url: string, profile: LinkedInProfile, at: number = Date.now()): Promise<OwnProfile> {
  const own: OwnProfile = { roles: rolesFromProfile(profile), schools: schoolsFromProfile(profile) };
  await saveNetworkSource("linkedin_self", {
    status: "ok",
    detail: null,
    itemCount: own.roles.length + own.schools.length,
    data: { url, roles: own.roles, schools: own.schools, readAt: new Date(at).toISOString() },
    replaceData: true,
    syncedAt: "now",
  });
  return own;
}

// ------------------------------------------------------------------ the view

/** "LinkedIn checks left" and "X dollars left" today, null for a source that is not set up. */
async function limitsOf(setup: WarmPathSetup): Promise<WarmPaths["limits"]> {
  const [li, x] = await Promise.all([
    setup.linkedinAccount ? quotaUsed("warm_path_linkedin").catch(() => null) : Promise.resolve(null),
    setup.x ? quotaUsed("warm_path_x").catch(() => null) : Promise.resolve(null),
  ]);
  return {
    linkedinChecksLeft: li === null ? null : Math.max(0, quotaLimit("warm_path_linkedin") - li),
    xUsdLeft: x === null ? null : Math.max(0, Math.floor((quotaLimit("warm_path_x") - x) / (X_CREDITS_PER_USD / 100)) / 100),
  };
}

/** A stored path with its intro draft and "asked" date as they are now (they change between checks). */
function withIntro(p: WarmPath, intros: WarmPathRow["intros"]): WarmPath {
  const i = intros[p.id];
  return { ...p, introDraft: i?.introDraft ?? null, askedAt: i?.askedAt ?? null };
}

function viewOf(lead: Lead, row: WarmPathRow | null, setup: WarmPathSetup, limits: WarmPaths["limits"], now: number): WarmPaths {
  const target = row?.target ?? null;
  const intros = row?.intros ?? {};
  const stale = row?.status === "running" && (!row.startedAt || now - Date.parse(row.startedAt) > CHECK_STALE_MS);
  const instagram = target?.instagramHandle ? { handle: target.instagramHandle, source: target.instagramSource ?? "manual" } : null;
  const li = row?.linkedinLive && linkedinLiveMatches(row.linkedinLive, target) ? row.linkedinLive : null;
  return {
    status: stale ? "error" : (row?.status ?? "idle"),
    startedAt: row?.startedAt ?? null,
    checkedAt: row?.computedAt ?? null,
    sources: row?.sources ?? [],
    linkedinShared: li && li.distance === "SECOND_DEGREE" && typeof li.sharedCount === "number" ? { count: li.sharedCount, shown: li.verified ? li.mutuals.length : 0 } : null,
    paths: (row?.paths ?? []).map((p) => withIntro(p, intros)),
    companyPaths: (row?.companyPaths ?? []).map((p) => withIntro(p, intros)),
    links: {
      linkedinMutuals: lead.linkedinUrl ? linkedinMutualsUrl({ memberId: target?.linkedinMemberId, profileUrl: lead.linkedinUrl, slug: lead.linkedinSlug }) : null,
      xFollowersYouKnow: xFollowersYouKnowUrl(lead.xHandle),
      instagram: instagramProfileUrl(target?.instagramHandle),
    },
    limits,
    setup,
    leadFirstName: firstNameOf(lead.name),
    instagram: instagram as WarmPaths["instagram"],
    error: stale ? "The last check stopped before it finished. Try again." : (row?.error ?? null),
  };
}

/** What loadWarmPaths reads besides the lead: the lead's row, your settings and your sources. */
export interface WarmPathInputs {
  row: WarmPathRow | null;
  settings: Settings;
  sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>;
}

/**
 * Reads what loadWarmPaths needs, so a route can start it alongside its own reads of the lead (one
 * round trip instead of two). Throws on a database error; pass it on with .catch(() => null).
 */
export async function readWarmPathInputs(leadId: string): Promise<WarmPathInputs> {
  const [row, settings, sources] = await Promise.all([getWarmPathRow(leadId), getSettings(), getNetworkSources()]);
  return { row, settings, sources };
}

/**
 * Leads whose free recompute is running on this server instance, with the work itself: a second
 * poll (or the page's second fetch) waits for it and shows what it saved, instead of starting
 * another or answering with what was stored before.
 */
const recomputing = new Map<string, Promise<unknown>>();

/**
 * What GET /api/leads/[id] returns as `paths`. Null before the first research run of a lead that
 * was never checked (unless the list chip says "Connected": see below), and when the warm-path
 * tables are not there yet. With `recompute` (the GET), redoes the free part first when the stored
 * paths are stale, or when the list chip says "Connected" (a connections upload set it) but the
 * paths were never computed (research may never have run: the lead's LinkedIn URL is enough for
 * the direct box, so the page says what the chip says), and neither a check nor research is
 * running: SQL only, no outside call. It is saved only over the row it was computed from (or
 * creates the row only when there is none), so a check that finished meanwhile, or another poll's
 * recompute, is never overwritten, and a row deleted meanwhile stays deleted; once saved the paths
 * are no longer stale, so it happens at most once per change; a second view asked for while it
 * runs waits for it. A failed recompute still shows the stored paths.
 * `inputs`: readWarmPathInputs() started earlier (null or a failure reads again). Never throws.
 */
export async function loadWarmPaths(
  lead: Lead,
  opts: { recompute?: boolean; now?: () => number; inputs?: WarmPathInputs | null | Promise<WarmPathInputs | null> } = {},
): Promise<WarmPaths | null> {
  const now = opts.now ?? Date.now;
  try {
    const pre = opts.inputs ? await Promise.resolve(opts.inputs).catch(() => null) : null;
    const { row: first, settings, sources } = pre ?? (await readWarmPathInputs(lead.id));
    let row = first;
    // The list chip says "Connected" (an upload set it) but this lead's paths were never computed,
    // even when research never ran: do the free part now, so the page says what the list says.
    const chipOnly = Boolean(lead.warmPath) && !row?.computedAt && row?.status !== "running";
    if (!row && !lead.researchFinishedAt && lead.researchStatus !== "running" && !(chipOnly && opts.recompute)) return null;
    const researching = lead.researchStatus === "running";
    const setupNow = setupOf(settings, sources);
    if (opts.recompute && !researching && (chipOnly || readyForFreePart(row, settings, sources) || (row && warmPathsStale(row, lead, settings, networkChangedAtOf(sources), setupNow)))) {
      const running = recomputing.get(lead.id);
      if (running) {
        await running;
      } else {
        const task = recompute(lead, row, settings, sources, now).catch((err) => {
          console.error(`[paths] could not recompute the warm paths of lead ${lead.id}: ${errorMessage(err).slice(0, 200)}`);
        });
        recomputing.set(lead.id, task);
        try {
          await task;
        } finally {
          recomputing.delete(lead.id);
        }
      }
      // Saved, lost to a newer write, or refused while a check runs: show what is stored now.
      row = await getWarmPathRow(lead.id).catch(() => row);
      if (!row && !lead.researchFinishedAt) return null;
    }
    return viewOf(lead, row, setupNow, await limitsOf(setupNow), now());
  } catch (err) {
    console.error(`[paths] could not load the warm paths of lead ${lead.id}: ${errorMessage(err).slice(0, 200)}`);
    return null;
  }
}

/**
 * One path of a lead by its opaque id ("direct", "li-<hash>", "x-<hash>"), among its paths and
 * company people, with its intro draft and "asked" date. Null when the lead has no such path. For
 * the intro routes: the path's evidence words the draft.
 */
export async function getWarmPath(leadId: string, pathId: string): Promise<WarmPath | null> {
  const row = await getWarmPathRow(leadId);
  if (!row) return null;
  const p = [...row.paths, ...row.companyPaths].find((x) => x.id === pathId);
  return p ? withIntro(p, row.intros) : null;
}

/**
 * The free part again from what is stored: no outside call. Saved only over the row as it was read
 * (its version), never while a check runs, and never creating a row deleted meanwhile. With no row
 * (a lead with only a list chip), the row is created, unless a check claimed it meanwhile.
 */
async function recompute(
  lead: Lead,
  row: WarmPathRow | null,
  settings: Settings,
  sources: Partial<Record<NetworkSourceKey, NetworkSourceRow>>,
  now: () => number,
): Promise<boolean> {
  const setup = setupOf(settings, sources);
  const target = captureTarget({ profile: null, lead, previous: row?.target ?? null, now: new Date(now()) });
  if (row?.target) {
    target.roles = row.target.roles;
    target.schools = row.target.schools;
    target.companySize = row.target.companySize;
    target.companySizeKey = row.target.companySizeKey ?? null;
  }
  const own = await ownProfileFor(settings, sources, { live: false, stopAt: now(), now });
  const li = row?.linkedinLive && linkedinLiveMatches(row.linkedinLive, target) ? row.linkedinLive : null;
  const x = validXLive(row?.xLive, lead, settings);
  const computed = await compute({
    lead,
    settings,
    sources,
    setup,
    row,
    target,
    own,
    linkedin: li ? { state: "cached", reason: null, error: null, live: li } : { state: "not_run", reason: null, error: null, live: null },
    x: { own: null, ownNote: null, lead: x ? { state: "cached", reason: null, error: null, live: x } : { state: "not_run", reason: null, error: null, live: null } },
    now: new Date(now()),
  });
  return saveWarmPathResult(
    lead.id,
    {
      status: computed.status,
      target,
      linkedinLive: li,
      xLive: x,
      paths: computed.paths,
      companyPaths: computed.companyPaths,
      sources: computed.sources,
      error: null,
      summary: summarizePaths(computed.paths, lead.name, new Date(now()).toISOString()),
      setup: computed.setup,
    },
    row ? { onlyIfIdle: true, updateOnly: true, ifVersion: row.version ?? null } : { insertOnly: true },
  );
}

/**
 * Redoes the free part of one lead (SQL only). False when there was nothing to redo, a check or
 * research is running, the row changed meanwhile, or the lead is gone. Never throws.
 */
export async function recomputeWarmPathsFree(leadId: string, opts: { now?: () => number } = {}): Promise<boolean> {
  if (recomputing.has(leadId)) return false;
  const task = (async () => {
    try {
      const [lead, row, settings, sources] = await Promise.all([getLead(leadId), getWarmPathRow(leadId), getSettings(), getNetworkSources()]);
      if (!lead || !row || row.status === "running" || lead.researchStatus === "running") return false;
      if (!row.computedAt && !readyForFreePart(row, settings, sources)) return false;
      return await recompute(lead, row, settings, sources, opts.now ?? Date.now);
    } catch (err) {
      console.error(`[paths] could not recompute the warm paths of lead ${leadId}: ${errorMessage(err).slice(0, 200)}`);
      return false;
    }
  })();
  recomputing.set(leadId, task);
  try {
    return await task;
  } finally {
    recomputing.delete(leadId);
  }
}

/**
 * The lead's side from the LinkedIn profile its research already read and stored, when that was
 * this lead's current profile: a lead researched before warm paths existed needs no new read.
 * SQL only: no LinkedIn call and no budget. Null when nothing usable is stored.
 */
export async function targetFromStoredResearch(lead: Lead, previous: WarmPathTarget | null, now: Date): Promise<WarmPathTarget | null> {
  if (!lead.linkedinSlug) return null;
  const stored = await storedResearchLinkedin(lead.id).catch(() => null);
  const p = stored?.profile;
  if (!stored || !p || !Array.isArray(p.experience) || !Array.isArray(p.education)) return null;
  const readUrl = stored.url ?? (typeof p.url === "string" ? p.url : null);
  // Only the profile the lead has now: a lead whose LinkedIn URL changed since keeps the old way.
  if (!readUrl || linkedinSlug(readUrl) !== lead.linkedinSlug) return null;
  const company = stored.company && typeof stored.company.name === "string" ? (stored.company as unknown as LinkedInCompany) : null;
  const target = captureTarget({ profile: p as unknown as LinkedInProfile, company, lead, previous, now });
  return targetIsCaptured(target) ? target : null;
}

/**
 * Leads researched before warm paths existed: their side, captured from what research stored, so
 * the free recompute that follows finds their paths (readyForFreePart). SQL only. Returns how many.
 */
async function backfillFromStoredResearch(stopAt: number): Promise<number> {
  let ids: string[] = [];
  try {
    ids = await leadIdsToBackfill();
  } catch {
    return 0;
  }
  let saved = 0;
  for (const id of ids) {
    if (Date.now() >= stopAt) break;
    try {
      const lead = await getLead(id);
      if (!lead || lead.researchStatus === "running") continue;
      const target = await targetFromStoredResearch(lead, null, new Date());
      if (!target) continue;
      await saveWarmPathTarget(id, target);
      saved++;
    } catch (err) {
      console.error(`[paths] could not capture the stored profile of lead ${id}: ${errorMessage(err).slice(0, 200)}`);
    }
  }
  return saved;
}

/**
 * Redoes the free part for every lead with warm paths, most recently checked first, until
 * `budgetMs` runs out (after a connections upload or removal, Read now or a settings save, in
 * after()). Leads researched before warm paths existed first get their side from what their
 * research stored. Never throws.
 */
export async function recomputeAllWarmPathsFree(opts: { budgetMs?: number } = {}): Promise<{ recomputed: number; left: number }> {
  const stopAt = Date.now() + (opts.budgetMs ?? 20_000);
  let ids: string[] = [];
  try {
    // Leads researched before warm paths existed first get their side from what research stored.
    const settings = await getSettings();
    if (setupOf(settings, await getNetworkSources()).any) await backfillFromStoredResearch(stopAt);
    ids = await warmPathLeadIds();
  } catch {
    return { recomputed: 0, left: 0 };
  }
  let recomputed = 0;
  let i = 0;
  for (; i < ids.length && Date.now() < stopAt; i++) if (await recomputeWarmPathsFree(ids[i])) recomputed++;
  return { recomputed, left: ids.length - i };
}

// ------------------------------------------------------------------ a check

const noLive = <T>(): PartOutcome<T> => ({ state: "not_run", reason: null, error: null, live: null });

/**
 * Finds warm paths for one lead: the free part always, LinkedIn on your account and X when they
 * are set up, within the daily budgets and `budgetMs`. Saves the result (le_warm_paths and the
 * lead's list summary) and returns it with one message line. Logs nothing: the caller writes the
 * one 'tool' event (research.ts does for runs). Never throws.
 */
export async function findWarmPaths(leadId: string, opts: FindWarmPathsOptions): Promise<FindWarmPathsResult> {
  const now = opts.now ?? Date.now;
  const started = now();
  const stopAt = started + Math.max(5000, opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const live: FindWarmPathsResult["live"] = { setUp: [], overBudget: [], failed: [] };
  const spent = { xCredits: 0, xUsd: 0, linkedinRequests: 0 };
  const result = (outcome: WarmPathOutcome, paths: WarmPaths | null, message: string): FindWarmPathsResult => ({
    outcome,
    paths,
    message,
    live,
    spent: { ...spent, xUsd: Math.round((spent.xCredits / X_CREDITS_PER_USD) * 1e6) / 1e6 },
  });

  let lead: Lead | null;
  try {
    lead = await getLead(leadId);
  } catch (err) {
    return result("error", null, `Warm paths: could not check (${errorMessage(err).slice(0, 160)})`);
  }
  if (!lead) return result("lead_missing", null, "Warm paths: the lead was not found");

  let claimed = false;
  try {
    const [settings, sources, row] = await Promise.all([getSettings(), getNetworkSources(), getWarmPathRow(leadId)]);
    const setup = setupOf(settings, sources);
    const leadHandle = cleanXHandle(lead.xHandle);
    if (!lead.linkedinUrl && !leadHandle) return result("nothing_to_check", await loadWarmPaths(lead), "Warm paths: nothing to check (no LinkedIn profile and no X handle)");

    // The lead's side: from the run, else what is stored.
    let target = captureTarget({ profile: opts.profile ?? null, company: opts.company ?? null, lead, previous: row?.target ?? null, now: new Date(now()) });
    if (!opts.profile && row?.target) {
      target.roles = row.target.roles;
      target.schools = row.target.schools;
      target.companySize = row.target.companySize;
      target.companySizeKey = row.target.companySizeKey ?? null;
    }

    if (!setup.any) {
      // Nothing of yours to compare with: keep the lead's side for later.
      await saveWarmPathTarget(leadId, target);
      return result("not_set_up", await loadWarmPaths(lead), "Warm paths skipped: nothing set up");
    }
    if (!(await claimWarmPathCheck(leadId))) return result("busy", null, "Warm paths: a check is already running for this lead");
    claimed = true;

    if (lead.linkedinUrl && setup.linkedinAccount) live.setUp.push("linkedin");
    if (leadHandle && setup.x) live.setUp.push("x");

    // A lead researched before warm paths existed: one Unipile-only read of its profile, within the
    // daily budget for profile reads outside research runs (given back when nothing was sent). With
    // no room, the footer says to re-run research.
    const needsProfile = setup.linkedinConnections || setup.linkedinProfile || setup.linkedinAccount;
    if (!targetIsCaptured(target) && lead.linkedinUrl && needsProfile && !opts.profile) {
      // What research already read and stored for this profile: no new read needed.
      const stored = await targetFromStoredResearch(lead, target, new Date(now()));
      if (stored) target = stored;
    }
    if (!targetIsCaptured(target) && lead.linkedinUrl && needsProfile && !opts.profileRead && stopAt - now() > 15_000) {
      const slot = await takeProfileRead(leadId);
      if (slot) {
        const read = await withTimeout(getProfileUnipileOnly(lead.linkedinUrl), Math.min(PROFILE_READ_MS, stopAt - now() - 10_000), "Reading the lead's profile").catch(() => null);
        if (read && !read.sent) await releaseQuota(slot);
        if (read?.profile) target = captureTarget({ profile: read.profile, lead, previous: target, now: new Date(now()) });
      }
    }

    // LinkedIn on your account, X, and your own profile (read again monthly), side by side.
    const cachedLi = row?.linkedinLive ?? null;
    const cachedX = validXLive(row?.xLive, lead, settings);
    const xStop = Math.min(stopAt, now() + X_PART_MS);
    const [li, x, own] = await Promise.all([
      live.setUp.includes("linkedin")
        ? checkLeadLinkedin({ leadId, target, slug: lead.linkedinSlug, cached: cachedLi, force: opts.force, stopAt, now })
        : Promise.resolve<LeadLinkedinResult | null>(null),
      live.setUp.includes("x") ? runX({ leadId, leadHandle: leadHandle!, settings, cachedX, force: opts.force, stopAt: xStop, now, cachedLi }) : Promise.resolve(null),
      // Research's own reads are capped by the run limits; a check from the button takes a unit of the profile-read budget.
      ownProfileFor(settings, sources, { live: true, budgeted: opts.trigger !== "research", stopAt, now }),
    ]);

    // LinkedIn: the new read, or the cached one while it is valid.
    let linkedin: PartOutcome<LinkedinLive> = noLive();
    if (li) {
      if (li.memberId && !target.linkedinMemberId) target.linkedinMemberId = li.memberId;
      spent.linkedinRequests = li.requests;
      const fallback = cachedLi && linkedinLiveMatches(cachedLi, target) ? cachedLi : null;
      linkedin = { state: li.state, reason: li.reason, error: li.error, live: li.live ?? fallback };
      if (li.state === "skipped" && (li.reason === "budget" || li.reason === "paused")) live.overBudget.push("linkedin");
      if (li.state === "failed") live.failed.push("linkedin");
    } else if (cachedLi && linkedinLiveMatches(cachedLi, target)) {
      linkedin = { state: "cached", reason: null, error: null, live: cachedLi };
    }

    let xPart: ComputeInput["x"] = { own: null, ownNote: null, lead: cachedX ? { state: "cached", reason: null, error: null, live: cachedX } : noLive() };
    if (x) {
      spent.xCredits = x.credits;
      xPart = x.part;
      if (x.overBudget) live.overBudget.push("x");
      if (x.failed) live.failed.push("x");
    }

    const computed = await compute({ lead, settings, sources: await getNetworkSources(), setup, row, target, own, linkedin, x: xPart, now: new Date(now()) });
    const checkedAt = new Date(now()).toISOString();
    const xLiveToStore = xPart.lead.live ?? null;
    // The claim made the row: update it only. A row deleted during the check (the lead got another
    // LinkedIn profile, or was deleted) stays deleted rather than coming back with the old data.
    const saved = await saveWarmPathResult(
      leadId,
      {
        status: computed.status,
        target,
        linkedinLive: linkedin.live,
        xLive: xLiveToStore,
        paths: computed.paths,
        companyPaths: computed.companyPaths,
        sources: computed.sources,
        // Each failed line with its network's label: "LinkedIn: your LinkedIn account did not answer (...). X: did not answer (...)."
        error: computed.status === "error" ? computed.sources.filter((s) => s.state === "failed").map(sourceLine).join(" ").slice(0, 500) || null : null,
        summary: summarizePaths(computed.paths, lead.name, checkedAt),
        setup: computed.setup,
      },
      { updateOnly: true },
    );
    claimed = false;
    const counters: Record<string, number> = {};
    if (spent.xCredits > 0) counters.xGraphCredits = spent.xCredits;
    if (spent.linkedinRequests > 0) counters.linkedinPathChecks = 1;
    if (Object.keys(counters).length) await addUsage(leadId, counters).catch(() => undefined);
    if (!saved) return result("lead_missing", null, "Warm paths: the lead was deleted, or got another LinkedIn profile, during the check");

    const outcome: WarmPathOutcome = computed.paths.length ? "found" : "none";
    const message = warmPathsEventMessage({ outcome: computed.status === "error" ? "failed" : outcome, best: computed.paths[0] ?? null, sources: computed.sources });
    return result(outcome, await loadWarmPaths({ ...lead, researchFinishedAt: lead.researchFinishedAt ?? checkedAt }), message);
  } catch (err) {
    if (claimed) await failWarmPathCheck(leadId, `The check failed: ${errorMessage(err).slice(0, 200)}`);
    return result("error", null, `Warm paths: could not check (${errorMessage(err).slice(0, 160)})`);
  } finally {
    if (claimed) await releaseWarmPathCheck(leadId);
  }
}

/** The X part of a check: your lists (refreshed at most daily), then the lead, unless the cached check is recent. */
async function runX(input: {
  leadId: string;
  leadHandle: string;
  settings: Settings;
  cachedX: XLive | null;
  cachedLi: LinkedinLive | null;
  force?: boolean;
  stopAt: number;
  now: () => number;
}): Promise<{ part: ComputeInput["x"]; credits: number; overBudget: boolean; failed: boolean }> {
  const { cachedX } = input;
  const ownHandle = cleanXHandle(input.settings.xHandle);
  const cachedPart = cachedX ? ({ state: "cached", reason: null, error: null, live: cachedX } as PartOutcome<XLive>) : noLive<XLive>();
  if (!ownHandle) return { part: { own: { reason: "no_owner_handle", error: "Add your X handle in Settings." }, ownNote: null, lead: cachedPart }, credits: 0, overBudget: false, failed: false };
  // A check cut short before it read the lead's follows (time ran out, or a page failed) is kept an
  // hour, not 7 days: research never forces, so it would not look at this lead on X for a week. One
  // that stopped at the 5,000 cap read what it reads, and is kept 7 days.
  const cutShort = Boolean(cachedX && cachedX.partial && cachedX.followingRead < Math.min(cachedX.following ?? 0, LEAD_FOLLOWING_MAX));
  if (!input.force && cachedX && input.now() - Date.parse(cachedX.checkedAt) < (cutShort ? X_LIVE_PARTIAL_TTL_MS : X_LIVE_TTL_MS)) {
    return { part: { own: null, ownNote: null, lead: cachedPart }, credits: 0, overBudget: false, failed: false };
  }
  const own: OwnXResult = await refreshOwnXLists({ handle: ownHandle, force: false, stopAt: input.stopAt, leadId: input.leadId, now: input.now });
  if (!own.ok) {
    const overBudget = own.reason === "budget" || own.reason === "paused";
    return {
      part: { own: { reason: own.reason, error: own.error }, ownNote: cachedX ? own.error : null, lead: cachedPart },
      credits: own.credits,
      overBudget,
      failed: !overBudget && own.reason !== "not_configured" && own.reason !== "no_owner_handle",
    };
  }
  const mutualPeople: ContactLike[] = (input.cachedLi?.verified ? input.cachedLi.mutuals : [])
    .filter((m) => m.slug)
    .map((m) => ({ slug: m.slug!, name: m.name, company: m.company, position: m.role, profileUrl: m.url, connectedOn: null }));
  const res = await checkLeadX({ leadId: input.leadId, leadHandle: input.leadHandle, own: own.state, stopAt: input.stopAt, linkedinPeople: mutualPeople, now: input.now });
  const credits = own.credits + res.credits;
  if (res.state === "checked" && res.xLive) {
    return { part: { own: null, ownNote: own.note, lead: { state: "checked", reason: res.reason, error: null, live: res.xLive } }, credits, overBudget: false, failed: false };
  }
  if (res.state === "skipped") {
    return {
      part: { own: null, ownNote: own.note, lead: cachedX ? { ...cachedPart, reason: res.reason } : { state: "skipped", reason: res.reason, error: null, live: null } },
      credits,
      overBudget: res.reason === "budget" || res.reason === "paused",
      failed: false,
    };
  }
  return {
    part: { own: null, ownNote: own.note, lead: { state: "failed", reason: res.reason, error: res.error, live: cachedX } },
    credits,
    overBudget: false,
    failed: true,
  };
}
