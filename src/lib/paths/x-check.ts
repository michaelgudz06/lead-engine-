import "server-only";
import { hasEnv } from "../env";
import { checkXFollow, estimateFollowerIdsCredits, estimateFollowingsCredits, getXFollowerIds, getXFollowings, getXUser } from "../providers/xgraph";
import { claimNetworkSource, connectionsByNamePairs, getNetworkSource, replaceXList, saveNetworkSource, xContactsByIds, xListCounts } from "../repo/network";
import type { XLive } from "../repo/paths";
import { releaseQuota, reserveQuota, settleQuota, type QuotaReservation } from "../repo/quota";
import { twitterapiCostUsd, TWITTERAPI_CREDITS } from "../usage/prices";
import { nameSearchPair, tieXToLinkedin, type ContactLike } from "./build";
import { BIG_ACCOUNT_FOLLOWERS } from "./score";
import { LEAD_FOLLOWING_MAX, OWN_X_LISTS_TTL_MS, type WarmSourceReason } from "./types";

/**
 * The X part of a warm-path check, through twitterapi.io (src/lib/providers/xgraph.ts).
 *
 * Your lists: who you follow (up to the newest 5,000, with names) and your followers (ids, up to
 * 20,000), refreshed at most once a day, by the first check that needs them or by "Refresh now".
 * Per lead: their profile, who they follow (up to the newest 5,000), then whether the people they
 * follow from your lists follow them back: their follower ids (20,000 followers or fewer) or one
 * follow check per person (at most 50), whichever costs fewer credits. Only the computed relations
 * are kept (le_warm_paths.x_live), never the lead's lists.
 *
 * Budget: twitterapi.io credits in le_quota_uses (warm_path_x). Each step reserves its worst case
 * first and settles to the credits counted from the answers; a call that failed after it was sent
 * keeps the most it could have cost.
 */

const OWN_FOLLOWING_MAX = 5000;
const OWN_FOLLOWERS_MAX = 20_000;
/** The lead's newest follows read, at most (src/lib/paths/types.ts, so the footer can say so). */
export { LEAD_FOLLOWING_MAX };
/** Follower ids are read for leads with at most this many followers; above it, follow checks. */
const LEAD_FOLLOWER_IDS_MAX = 20_000;
const FOLLOW_CHECKS_MAX = 50;
/** What one lead's check may reserve: 5,000 follows and 20,000 follower ids with room to spare. */
export const LEAD_X_RESERVE_CREDITS = 15_000;
const USER_INFO_CREDITS = 18;
const CONNECTORS_KEPT = 30;

export interface OwnXState {
  handle: string;
  userId: string | null;
  /** Your counts as X reports them, and the sizes of the lists stored. */
  following: number;
  followers: number;
  storedFollowing: number;
  storedFollowers: number;
  syncedAt: string | null;
  /** True when the lists hold fewer than X says (a cap, or time ran out). */
  partial: boolean;
}

export type OwnXResult =
  | { ok: true; state: OwnXState; refreshed: boolean; credits: number; note: string | null }
  | { ok: false; reason: WarmSourceReason; error: string; credits: number; state: OwnXState | null };

const sameHandle = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** Your stored lists' state, or null when they are missing or belong to another handle. */
export async function ownXState(handle: string): Promise<OwnXState | null> {
  const self = await getNetworkSource("x_self");
  const d = self?.data ?? {};
  if (!self || !sameHandle(String(d.handle ?? ""), handle)) return null;
  const counts = await xListCounts();
  return {
    handle,
    userId: typeof d.userId === "string" ? d.userId : null,
    following: Number(d.following ?? counts.following) || 0,
    followers: Number(d.followers ?? counts.followers) || 0,
    storedFollowing: counts.following,
    storedFollowers: counts.followers,
    syncedAt: self.syncedAt,
    partial: d.partial === true,
  };
}

/** Takes credits for the X budget; a reservation that does not fit says why. */
async function reserve(units: number, leadId: string | null): Promise<{ slot: Extract<QuotaReservation, { ok: true }> } | { reason: WarmSourceReason; limit: number }> {
  const slot = await reserveQuota("warm_path_x", Math.max(1, Math.ceil(units)), leadId);
  if (slot.ok) return { slot };
  return { reason: slot.limit === 0 ? "paused" : "budget", limit: slot.limit };
}

/**
 * Refreshes your X lists when they are older than a day, belong to another handle, or `force`.
 * Your lists are replaced only by a complete read, or a read that reached the cap (the newest 5,000
 * follows or 20,000 followers are the list kept), or when none are stored, so a read cut short
 * never shrinks them. Each list reserves its full-page estimate plus one call at the worst rate,
 * and its read stops before it could cost more. One refresh at a time across servers. Never throws.
 */
export async function refreshOwnXLists(opts: { handle: string; force?: boolean; stopAt: number; leadId?: string | null; now?: () => number }): Promise<OwnXResult> {
  const now = opts.now ?? Date.now;
  let credits = 0;
  try {
    if (!hasEnv("TWITTERAPI_IO_KEY")) return { ok: false, reason: "not_configured", error: "X follows are off on this server.", credits, state: null };
    const before = await ownXState(opts.handle);
    const fresh = before?.syncedAt && now() - Date.parse(before.syncedAt) < OWN_X_LISTS_TTL_MS;
    if (before && fresh && !opts.force) return { ok: true, state: before, refreshed: false, credits, note: null };
    if (!(await claimNetworkSource("x_self", 3 * 60_000))) {
      if (before) return { ok: true, state: before, refreshed: false, credits, note: "Your X lists are being refreshed elsewhere; the stored ones were used." };
      return { ok: false, reason: "upstream", error: "Your X lists are being refreshed. Try again in a minute.", credits, state: null };
    }
    let status: "ok" | "error" = "error";
    let detail: string | null = null;
    try {
      const info = await reserve(USER_INFO_CREDITS, opts.leadId ?? null);
      if ("reason" in info) {
        detail = info.reason === "paused" ? "X checks are paused." : "Today's X budget is used up.";
        return before
          ? { ok: true, state: before, refreshed: false, credits, note: detail }
          : { ok: false, reason: info.reason, error: detail, credits, state: null };
      }
      const me = await getXUser(opts.handle, { timeoutMs: Math.min(15_000, opts.stopAt - now()) });
      if (!me.ok) {
        await settleQuota(info.slot.id, me.sent ? me.maxCredits : 0);
        detail = `Your X account could not be read (${me.error}).`;
        return before ? { ok: true, state: before, refreshed: false, credits, note: detail } : { ok: false, reason: "upstream", error: detail, credits, state: null };
      }
      credits += me.credits;
      await settleQuota(info.slot.id, me.credits);
      if (!me.user) {
        detail = `@${opts.handle} was not found on X. Check your X handle in Settings.`;
        return { ok: false, reason: "not_found", error: detail, credits, state: null };
      }
      if (me.user.protected || me.user.unavailable) {
        detail = me.user.protected ? "Your X account is private, so its lists cannot be read." : "Your X account is unavailable.";
        return { ok: false, reason: me.user.protected ? "private" : "unavailable", error: detail, credits, state: null };
      }
      const wantFollowing = Math.min(me.user.following ?? OWN_FOLLOWING_MAX, OWN_FOLLOWING_MAX);
      const wantFollowers = Math.min(me.user.followers ?? OWN_FOLLOWERS_MAX, OWN_FOLLOWERS_MAX);
      // Pages can come back short and cost more per account: each list may cost its full-page
      // estimate plus one call at the worst rate, and never more (the reads stop before that).
      const followingCap = estimateFollowingsCredits(wantFollowing) + TWITTERAPI_CREDITS.followingsMaxCall;
      const followersCap = estimateFollowerIdsCredits(wantFollowers) + TWITTERAPI_CREDITS.followerIdsMaxCall;
      const lists = await reserve(followingCap + followersCap, opts.leadId ?? null);
      if ("reason" in lists) {
        detail = lists.reason === "paused" ? "X checks are paused." : "Today's X budget has no room to refresh your lists.";
        return before ? { ok: true, state: before, refreshed: false, credits, note: detail } : { ok: false, reason: lists.reason, error: detail, credits, state: null };
      }
      const [following, followers] = await Promise.all([
        getXFollowings(opts.handle, { max: OWN_FOLLOWING_MAX, stopAt: opts.stopAt, maxCredits: followingCap }),
        getXFollowerIds(opts.handle, { max: OWN_FOLLOWERS_MAX, stopAt: opts.stopAt, maxCredits: followersCap }),
      ]);
      const fPage = following.ok ? following : following.partial;
      const rPage = followers.ok ? followers : followers.partial;
      const listCredits = fPage.credits + rPage.credits + (following.ok ? 0 : following.sent ? following.maxCredits : 0) + (followers.ok ? 0 : followers.sent ? followers.maxCredits : 0);
      credits += fPage.credits + rPage.credits;
      await settleQuota(lists.slot.id, listCredits);
      const importId = `x-${now()}`;
      let storedFollowing = before?.storedFollowing ?? 0;
      let storedFollowers = before?.storedFollowers ?? 0;
      const followingDone = following.ok && fPage.complete;
      const followersDone = followers.ok && rPage.complete;
      // A read that stopped at the cap holds the newest 5,000 or 20,000: the list kept, so it
      // replaces too (an ok read only holds that many when it stopped at the cap).
      const followingFull = followingDone || (following.ok && fPage.items.length >= OWN_FOLLOWING_MAX);
      const followersFull = followersDone || (followers.ok && rPage.items.length >= OWN_FOLLOWERS_MAX);
      // A complete read replaces a list; a read cut short only fills a list that was empty.
      if (followingFull || (!before && fPage.items.length) || (fPage.items.length > storedFollowing && following.ok)) {
        storedFollowing = await replaceXList("following", fPage.items.map((u) => ({ id: u.id, handle: u.handle, name: u.name, followers: u.followers })), importId);
        await saveNetworkSource("x_following", { status: "ok", itemCount: storedFollowing, syncedAt: "now" });
      }
      if (followersFull || (!before && rPage.items.length) || (rPage.items.length > storedFollowers && followers.ok)) {
        storedFollowers = await replaceXList("follower", rPage.items.map((id) => ({ id })), importId);
        await saveNetworkSource("x_followers", { status: "ok", itemCount: storedFollowers, syncedAt: "now" });
      }
      const partial = !followingDone || !followersDone;
      const failed = [following, followers].find((r) => !r.ok) as { error: string } | undefined;
      if (failed && !fPage.items.length && !rPage.items.length && !before) {
        detail = `Your X lists could not be read (${failed.error}).`;
        return { ok: false, reason: "upstream", error: detail, credits, state: null };
      }
      const state: OwnXState = {
        handle: opts.handle,
        userId: me.user.id,
        following: me.user.following ?? storedFollowing,
        followers: me.user.followers ?? storedFollowers,
        storedFollowing,
        storedFollowers,
        syncedAt: new Date(now()).toISOString(),
        partial,
      };
      await saveNetworkSource("x_self", {
        status: "ok",
        detail: failed ? `Partly refreshed (${failed.error}).` : null,
        itemCount: storedFollowing + storedFollowers,
        data: { userId: me.user.id, handle: opts.handle, following: state.following, followers: state.followers, partial },
        replaceData: true,
        syncedAt: "now",
      });
      status = "ok";
      return { ok: true, state, refreshed: true, credits, note: failed ? `Your X lists were partly refreshed (${failed.error}).` : null };
    } finally {
      // Ends the claim. A successful refresh already wrote status "ok" with its data.
      if (status !== "ok") await saveNetworkSource("x_self", { status: before ? "ok" : "error", detail }).catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, reason: "upstream", error: `Your X lists could not be refreshed (${err instanceof Error ? err.message.slice(0, 120) : "error"}).`, credits, state: null };
  }
}

export interface LeadXResult {
  state: "checked" | "skipped" | "failed";
  reason: WarmSourceReason | null;
  error: string | null;
  /** The new X data; null when nothing was read (the cached data, if any, stays). */
  xLive: XLive | null;
  credits: number;
}

/** Ranks connectors to keep: two-way ties first, damped big accounts last, smaller accounts first. */
function connectorRank(c: { youFollow: boolean; followsYou: boolean; followsLead: boolean | null; followers: number | null }): number {
  const big = typeof c.followers === "number" && c.followers > BIG_ACCOUNT_FOLLOWERS;
  const you = c.youFollow && c.followsYou ? 3 : c.followsYou && !big ? 1 : 0;
  const lead = c.followsLead ? 3 : big ? 0 : 1;
  return you + lead;
}

/**
 * The lead's side on X. Needs your lists (refreshOwnXLists first). Reserves 15,000 credits, reads
 * the lead's profile (stops when private, unavailable or not found), their newest follows, then
 * whether the people from your lists among them follow the lead back, and settles. Ties each
 * connector to one of `linkedinPeople` or your stored connections when the names match and the X
 * bio names their slug or company. Never throws.
 */
export async function checkLeadX(input: {
  leadId: string;
  leadHandle: string;
  own: OwnXState;
  stopAt: number;
  /** Shared connections from LinkedIn (step 2), to tie X accounts to. */
  linkedinPeople?: ContactLike[];
  now?: () => number;
}): Promise<LeadXResult> {
  const now = input.now ?? Date.now;
  let reservation: Extract<QuotaReservation, { ok: true }> | null = null;
  let spent = 0;
  let maybeSpent = 0;
  try {
    const r = await reserve(LEAD_X_RESERVE_CREDITS, input.leadId);
    if ("reason" in r) return { state: "skipped", reason: r.reason, error: null, xLive: null, credits: 0 };
    reservation = r.slot;
    const left = () => input.stopAt - now();
    const base = {
      handle: input.leadHandle,
      ownHandle: input.own.handle,
      ownFollowing: input.own.storedFollowing,
      ownFollowers: input.own.storedFollowers,
    };
    const lead = await getXUser(input.leadHandle, { timeoutMs: Math.min(15_000, left()) });
    if (!lead.ok) {
      if (lead.sent) maybeSpent += lead.maxCredits;
      return { state: "failed", reason: lead.status === null ? "timeout" : "upstream", error: lead.error, xLive: null, credits: 0 };
    }
    spent += lead.credits;
    const stamp = () => new Date(now()).toISOString();
    const empty = (over: Partial<XLive>): XLive => ({
      ...base,
      userId: null,
      protected: false,
      unavailable: false,
      notFound: false,
      following: null,
      followers: null,
      followingRead: 0,
      followsLeadBy: "none",
      you: { youFollow: false, followsYou: false },
      connectors: [],
      partial: false,
      credits: spent,
      costUsd: twitterapiCostUsd(spent),
      checkedAt: stamp(),
      ...over,
    });
    if (!lead.user) return { state: "checked", reason: "not_found", error: null, xLive: empty({ notFound: true }), credits: spent };
    const user = lead.user;
    if (user.unavailable || user.protected) {
      return {
        state: "checked",
        reason: user.protected ? "private" : "unavailable",
        error: null,
        xLive: empty({ userId: user.id || null, protected: user.protected, unavailable: user.unavailable, following: user.following, followers: user.followers }),
        credits: spent,
      };
    }

    // Who the lead follows (newest first), and who of them is in your lists.
    // Never past the reservation: short pages cost more per account.
    const follows = await getXFollowings(input.leadHandle, { max: LEAD_FOLLOWING_MAX, stopAt: Math.min(input.stopAt, now() + 40_000), maxCredits: LEAD_X_RESERVE_CREDITS - spent - maybeSpent });
    const page = follows.ok ? follows : follows.partial;
    spent += page.credits;
    if (!follows.ok && follows.sent) maybeSpent += follows.maxCredits;
    if (!follows.ok && !page.items.length) {
      return { state: "failed", reason: follows.status === null ? "timeout" : "upstream", error: follows.error, xLive: null, credits: spent };
    }
    // Partial means a gap: time ran out or a page failed. A read that stopped at the cap read the
    // newest 5,000, which is what a check reads (the footer says so), so it is not partial.
    let partial = !page.complete && page.items.length < Math.min(user.following ?? 0, LEAD_FOLLOWING_MAX);
    const leadFollows = new Map(page.items.map((u) => [u.id, u]));
    const mine = await xContactsByIds([...leadFollows.keys(), user.id].filter(Boolean));
    const rel = new Map<string, { youFollow: boolean; followsYou: boolean; handle: string | null; name: string | null; followers: number | null }>();
    for (const c of mine) {
      const r0 = rel.get(c.id) ?? { youFollow: false, followsYou: false, handle: null, name: null, followers: null };
      if (c.relation === "following") r0.youFollow = true;
      else r0.followsYou = true;
      r0.handle ??= c.handle;
      r0.name ??= c.name;
      r0.followers ??= c.followers;
      rel.set(c.id, r0);
    }
    const you = {
      youFollow: rel.get(user.id)?.youFollow ?? false,
      followsYou: Boolean(input.own.userId && leadFollows.has(input.own.userId)) || (rel.get(user.id)?.followsYou ?? false),
    };
    const candidates = page.items
      .filter((u) => u.id !== user.id && u.id !== input.own.userId && rel.has(u.id))
      .map((u) => {
        const r0 = rel.get(u.id)!;
        return { user: u, youFollow: r0.youFollow, followsYou: r0.followsYou, followers: u.followers ?? r0.followers, followsLead: null as boolean | null };
      });

    // Do they follow the lead back? The lead's follower ids, or follow checks: whichever costs less.
    let followsLeadBy: XLive["followsLeadBy"] = "none";
    if (candidates.length) {
      const budgetLeft = LEAD_X_RESERVE_CREDITS - spent - maybeSpent;
      const followers = user.followers ?? 0;
      const idsCost = followers <= LEAD_FOLLOWER_IDS_MAX ? estimateFollowerIdsCredits(followers) : Infinity;
      const checks = Math.min(FOLLOW_CHECKS_MAX, candidates.length);
      const checksCost = checks * 100;
      const useIds = idsCost <= checksCost && idsCost <= budgetLeft;
      if (useIds && left() > 3000) {
        const ids = await getXFollowerIds(input.leadHandle, { max: LEAD_FOLLOWER_IDS_MAX, stopAt: Math.min(input.stopAt, now() + 20_000), maxCredits: budgetLeft });
        const p = ids.ok ? ids : ids.partial;
        spent += p.credits;
        if (!ids.ok && ids.sent) maybeSpent += ids.maxCredits;
        const set = new Set(p.items);
        // Nothing read (no time, or the reservation had no room for a call): not answered by ids.
        if (p.pages > 0 && (p.items.length || ids.ok)) {
          for (const c of candidates) c.followsLead = set.has(c.user.id) ? true : p.complete ? false : null;
          if (input.own.userId && set.has(input.own.userId)) you.youFollow = true;
          followsLeadBy = "ids";
        }
        if (!p.complete) partial = true;
      } else if (checksCost <= budgetLeft && left() > 3000) {
        // Most promising first: people you follow each other with, then people who follow you.
        const order = [...candidates].sort((a, b) => connectorRank(b) - connectorRank(a) || (a.followers ?? 0) - (b.followers ?? 0));
        const picked = order.slice(0, checks);
        let i = 0;
        const worker = async () => {
          while (i < picked.length && left() > 2500) {
            const c = picked[i++];
            const res = await checkXFollow(c.user.handle, input.leadHandle, { timeoutMs: Math.min(15_000, left()) });
            if (res.ok) {
              spent += res.credits;
              c.followsLead = res.following;
            } else if (res.sent) {
              maybeSpent += res.maxCredits;
            }
          }
        };
        await Promise.all([worker(), worker(), worker(), worker(), worker()]);
        followsLeadBy = "checks";
        // People past the first 50 stay "the lead follows them"; a check that did not run is a gap.
        if (picked.some((c) => c.followsLead === null)) partial = true;
      } else {
        partial = true;
      }
    }

    // Keep the best 30, and tie them to your LinkedIn connections where the bio allows.
    const kept = [...candidates].sort((a, b) => connectorRank(b) - connectorRank(a) || (a.followers ?? 0) - (b.followers ?? 0)).slice(0, CONNECTORS_KEPT);
    const pairs = kept.flatMap((c) => nameSearchPair(c.user.name) ?? []);
    const linkedinPeople = [...(input.linkedinPeople ?? []), ...(pairs.length ? await connectionsByNamePairs(pairs).catch(() => []) : [])];
    const connectors: XLive["connectors"] = kept.map((c) => ({
      id: c.user.id,
      handle: c.user.handle,
      name: c.user.name,
      followers: c.followers,
      youFollow: c.youFollow,
      followsYou: c.followsYou,
      followsLead: c.followsLead,
      linkedinSlug: tieXToLinkedin(c.user, linkedinPeople),
    }));
    return {
      state: "checked",
      reason: partial ? "partial" : null,
      error: null,
      xLive: {
        ...base,
        userId: user.id,
        protected: false,
        unavailable: false,
        notFound: false,
        following: user.following,
        followers: user.followers,
        followingRead: page.items.length,
        followsLeadBy,
        you,
        connectors,
        partial,
        credits: spent,
        costUsd: twitterapiCostUsd(spent),
        checkedAt: stamp(),
      },
      credits: spent,
    };
  } catch (err) {
    return { state: "failed", reason: "upstream", error: `X check failed (${err instanceof Error ? err.message.slice(0, 120) : "error"})`, xLive: null, credits: spent };
  } finally {
    if (reservation) {
      const used = spent + maybeSpent;
      if (used > 0) await settleQuota(reservation.id, used);
      else await releaseQuota(reservation.id);
    }
  }
}
