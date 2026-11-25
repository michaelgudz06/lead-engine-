import "server-only";
import { hasEnv } from "../env";
import { normaliseLinkedinUrl } from "../linkedin-url";
import { getLinkedInProfile, getNetworkAccountState, networkAccountConfigured } from "../providers/linkedin";
import {
  claimNetworkSource,
  clearOwnXData,
  deleteConnections,
  getNetworkSources,
  markConnectedLeads,
  saveNetworkSource,
  storeConnectionsPart,
  validateConnectionTuples,
} from "../repo/network";
import { purgeLinkedinDerivedPaths, purgeXDerivedPaths } from "../repo/paths";
import { profileReadLimitMessage, quotaLimit, quotaUsed, releaseQuota, reserveQuota, X_CREDITS_PER_USD } from "../repo/quota";
import { getSettings } from "../repo/settings";
import { cleanXHandle, errorMessage } from "../research/util";
import type { Settings } from "../types";
import { withUsageContext } from "../usage/ledger";
import { saveOwnProfile } from "./engine";
import { cleanInstagramHandle } from "./links";
import type { NetworkStatus } from "./types";
import { refreshOwnXLists } from "./x-check";

/**
 * The owner's network, for Settings > Your network and its routes. Counts and states only: nothing
 * here returns a contact list, a contact's name or a key. Every outside call runs inside a usage
 * context, so its ledger rows are written before the function returns.
 */

const iso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

/** GET /api/network. Makes at most one Unipile accounts-list call (cached 10 minutes; it never touches LinkedIn). */
export async function getNetworkStatus(): Promise<NetworkStatus> {
  const [settings, sources] = await Promise.all([getSettings(), getNetworkSources()]);
  const [account, liUsed, xUsed] = await Promise.all([
    // The accounts list never touches LinkedIn; its ledger row is written before this returns.
    networkAccountConfigured() ? withUsageContext(null, () => getNetworkAccountState()) : Promise.resolve({ state: "not_set_up" as const, detail: null }),
    quotaUsed("warm_path_linkedin").catch(() => 0),
    quotaUsed("warm_path_x").catch(() => 0),
  ]);
  const csv = sources.linkedin_csv;
  const self = sources.linkedin_self;
  const acc = sources.linkedin_account?.data ?? {};
  const x = sources.x_self;
  const url = normaliseLinkedinUrl(settings.linkedinUrl ?? "");
  const handle = cleanXHandle(settings.xHandle);
  const xMatches = Boolean(handle && x && String(x.data.handle ?? "").toLowerCase() === handle.toLowerCase());
  const pausedUntil = iso(acc.pausedUntil);
  const paused = Boolean(pausedUntil && Date.parse(pausedUntil) > Date.now());
  // Why: stored with the pause (older pauses only have the reason's words).
  const reason = String(acc.pauseReason ?? "");
  const pauseKind: NetworkStatus["linkedin"]["account"]["pauseKind"] = !paused
    ? null
    : acc.pauseKind === "rate_limited" || acc.pauseKind === "auth" || acc.pauseKind === "error"
      ? acc.pauseKind
      : /\(429\)/.test(reason)
        ? "rate_limited"
        : /\(401\)/.test(reason)
          ? "auth"
          : "error";
  const state: NetworkStatus["linkedin"]["account"]["state"] =
    account.state === "not_set_up" ? "not_set_up" : paused ? "paused" : account.state === "connected" ? "connected" : "needs_reconnect";
  return {
    linkedin: {
      connections:
        csv && (csv.itemCount ?? 0) > 0
          ? { count: csv.itemCount ?? 0, exportedAt: iso(csv.data.exportedAt), uploadedAt: iso(csv.data.uploadedAt) ?? csv.syncedAt ?? csv.updatedAt }
          : null,
      self: url
        ? {
            url,
            readAt: self && self.data.url === url ? iso(self.data.readAt) : null,
            roles: self && self.data.url === url && Array.isArray(self.data.roles) ? self.data.roles.length : 0,
            schools: self && self.data.url === url && Array.isArray(self.data.schools) ? self.data.schools.length : 0,
            error: self?.status === "error" ? self.detail : null,
          }
        : null,
      account: {
        state,
        premium: typeof acc.premium === "boolean" ? acc.premium : null,
        salesNavigator: typeof acc.salesNavigator === "boolean" ? acc.salesNavigator : null,
        pausedUntil: paused ? pausedUntil : null,
        pauseKind,
        checksToday: liUsed,
        checksLimit: quotaLimit("warm_path_linkedin"),
      },
    },
    x: {
      configured: hasEnv("TWITTERAPI_IO_KEY"),
      handle: handle ?? null,
      following: xMatches ? Number(x!.data.following ?? 0) : null,
      followers: xMatches ? Number(x!.data.followers ?? 0) : null,
      syncedAt: xMatches ? x!.syncedAt : null,
      running: x?.status === "running" && Date.now() - Date.parse(x.updatedAt) < 3 * 60_000,
      error: x?.status === "error" ? x.detail : null,
      usdToday: Math.round((xUsed / X_CREDITS_PER_USD) * 100) / 100,
      usdLimit: quotaLimit("warm_path_x") / X_CREDITS_PER_USD,
    },
    instagram: { handle: cleanInstagramHandle(settings.instagramHandle) },
  };
}

/**
 * POST /api/network/linkedin/self: reads your profile now (one request on the research account;
 * the Apify fallback when Unipile fails) for your roles and schools. Returns counts only. Each read
 * takes a unit of the daily budget for profile reads outside research runs (10 a day, whatever URL
 * is set: a new URL resets the route's gaps, not this); too_soon when it has no room. A read that
 * did not start (busy) gives its unit back.
 */
export async function readOwnProfile(): Promise<{ ok: true; readAt: string; roles: number; schools: number } | { ok: false; code: "no_url" | "busy" | "too_soon" | "failed"; error: string }> {
  const settings = await getSettings();
  const url = normaliseLinkedinUrl(settings.linkedinUrl ?? "");
  if (!url) return { ok: false, code: "no_url", error: "Add your LinkedIn profile URL in Settings first." };
  const slot = await reserveQuota("profile_read");
  if (!slot.ok) return { ok: false, code: "too_soon", error: profileReadLimitMessage() };
  if (!(await claimNetworkSource("linkedin_self", 2 * 60_000))) {
    await releaseQuota(slot.id);
    return { ok: false, code: "busy", error: "Your profile is being read. Try again in a minute." };
  }
  try {
    const res = await withUsageContext(null, () => getLinkedInProfile(url));
    if (!res.profile) {
      await saveNetworkSource("linkedin_self", { status: "error", detail: `Could not read your profile (${(res.error ?? "no profile").slice(0, 160)}).` });
      return { ok: false, code: "failed", error: `Could not read your LinkedIn profile. ${res.error ? "LinkedIn did not answer." : "Check the URL."} Try again in a few minutes.` };
    }
    const own = await saveOwnProfile(url, res.profile);
    return { ok: true, readAt: new Date().toISOString(), roles: own.roles.length, schools: own.schools.length };
  } catch (err) {
    await saveNetworkSource("linkedin_self", { status: "error", detail: `Could not read your profile (${errorMessage(err).slice(0, 160)}).` }).catch(() => undefined);
    return { ok: false, code: "failed", error: "Could not read your LinkedIn profile. Try again in a few minutes." };
  }
}

/**
 * POST /api/network/x/sync: refreshes your X lists now (within the X budget), at most 50 s.
 * Returns the counts and the credits used. refreshed is false when the stored lists were kept
 * (the budget had no room, X did not answer, or another server was refreshing them); note says why.
 */
export async function syncOwnX(): Promise<
  | { ok: true; following: number; followers: number; syncedAt: string | null; creditsUsed: number; refreshed: boolean; note: string | null }
  | { ok: false; code: "not_configured" | "no_handle" | "warm_path_budget" | "upstream"; error: string }
> {
  if (!hasEnv("TWITTERAPI_IO_KEY")) return { ok: false, code: "not_configured", error: "X follows are off: TWITTERAPI_IO_KEY is not set on the server." };
  const settings = await getSettings();
  const handle = cleanXHandle(settings.xHandle);
  if (!handle) return { ok: false, code: "no_handle", error: "Add your X handle in Settings first." };
  const res = await withUsageContext(null, () => refreshOwnXLists({ handle, force: true, stopAt: Date.now() + 50_000 }));
  if (!res.ok) {
    const budget = res.reason === "budget" || res.reason === "paused";
    return { ok: false, code: budget ? "warm_path_budget" : "upstream", error: res.error };
  }
  return {
    ok: true,
    following: res.state.storedFollowing,
    followers: res.state.storedFollowers,
    syncedAt: res.state.syncedAt,
    creditsUsed: res.credits,
    refreshed: res.refreshed,
    note: res.refreshed ? null : res.note,
  };
}

/**
 * PUT /api/network/linkedin/connections: one part of a Connections.csv upload, checked again on
 * the server. On the last part the older upload's rows go, and the "Connected" chip is set on every
 * lead in your connections. status 400 for bad input, 409 when a newer upload replaced this one.
 */
export async function uploadConnectionsPart(input: { importId: unknown; part: unknown; parts: unknown; rows: unknown; exportedAt?: unknown }): Promise<
  { ok: true; received: number; total: number; done: boolean; connectedLeads: number } | { ok: false; status: 400 | 409; error: string }
> {
  const rows = validateConnectionTuples(input.rows);
  if (!rows.ok) return { ok: false, status: 400, error: rows.error };
  const res = await storeConnectionsPart({
    importId: String(input.importId ?? ""),
    part: Number(input.part),
    parts: Number(input.parts),
    rows: rows.rows,
    exportedAt: typeof input.exportedAt === "string" ? input.exportedAt : null,
  });
  if (!res.ok) return { ok: false, status: res.code === "replaced" ? 409 : 400, error: res.error };
  const connectedLeads = res.done ? await markConnectedLeads() : 0;
  return { ...res, connectedLeads };
}

/** DELETE /api/network/linkedin/connections: every stored connection, and every stored path that may name one. */
export async function removeConnections(): Promise<{ removed: number }> {
  const removed = await deleteConnections();
  await purgeLinkedinDerivedPaths();
  return { removed };
}

/**
 * PUT /api/settings, after saving: your X handle changed -> your X lists and every X-derived path
 * are forgotten; your LinkedIn URL changed -> your stored roles and schools are dropped (read
 * again from the new URL). Never throws.
 */
export async function applyNetworkSettingsChange(before: Pick<Settings, "xHandle" | "linkedinUrl">, after: Pick<Settings, "xHandle" | "linkedinUrl">): Promise<void> {
  try {
    const xBefore = (cleanXHandle(before.xHandle) ?? "").toLowerCase();
    const xAfter = (cleanXHandle(after.xHandle) ?? "").toLowerCase();
    if (xBefore !== xAfter) {
      await clearOwnXData();
      await purgeXDerivedPaths();
    }
    const liBefore = normaliseLinkedinUrl(before.linkedinUrl ?? "") ?? "";
    const liAfter = normaliseLinkedinUrl(after.linkedinUrl ?? "") ?? "";
    if (liBefore !== liAfter) await saveNetworkSource("linkedin_self", { status: "ok", detail: null, itemCount: 0, data: {}, replaceData: true, syncedAt: "now" });
  } catch (err) {
    console.error(`[paths] could not apply the network settings change: ${errorMessage(err).slice(0, 200)}`);
  }
}

/**
 * The three Settings fields for warm paths, checked and cleaned for PUT /api/settings: an X handle
 * ("" or [A-Za-z0-9_]{1,15}; "@jane" and x.com links accepted), an Instagram handle ("" or
 * [A-Za-z0-9._]{1,30}, not a reserved path) and a LinkedIn profile URL ("" or linkedin.com/in/...).
 */
export function cleanNetworkSettings(input: Partial<Pick<Settings, "xHandle" | "instagramHandle" | "linkedinUrl">>):
  | { ok: true; value: Partial<Pick<Settings, "xHandle" | "instagramHandle" | "linkedinUrl">> }
  | { ok: false; field: "xHandle" | "instagramHandle" | "linkedinUrl"; error: string } {
  const value: Partial<Pick<Settings, "xHandle" | "instagramHandle" | "linkedinUrl">> = {};
  if (input.xHandle !== undefined) {
    const raw = String(input.xHandle ?? "").trim();
    const clean = raw ? cleanXHandle(raw) : "";
    if (clean === null) return { ok: false, field: "xHandle", error: "Enter your X handle: letters, digits and _, up to 15." };
    value.xHandle = clean;
  }
  if (input.instagramHandle !== undefined) {
    const raw = String(input.instagramHandle ?? "").trim();
    const clean = raw ? cleanInstagramHandle(raw) : "";
    if (clean === null) return { ok: false, field: "instagramHandle", error: "Enter your Instagram handle: letters, digits, dots and _, up to 30." };
    value.instagramHandle = clean;
  }
  if (input.linkedinUrl !== undefined) {
    const raw = String(input.linkedinUrl ?? "").trim();
    const clean = raw ? normaliseLinkedinUrl(raw) : "";
    if (clean === null) return { ok: false, field: "linkedinUrl", error: "Enter your LinkedIn profile URL (linkedin.com/in/...)." };
    value.linkedinUrl = clean;
  }
  return { ok: true, value };
}
