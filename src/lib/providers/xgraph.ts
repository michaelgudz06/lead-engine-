import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError } from "../http";
import { metered, type Metered } from "../usage/ledger";
import { twitterapiCostUsd, TWITTERAPI_CREDITS } from "../usage/prices";
import type { ProviderStatus } from "../types";

/**
 * X follow graphs through twitterapi.io, for warm paths. A third-party X data API: no X login and
 * no X account of the owner's is used. Off until TWITTERAPI_IO_KEY is set.
 *
 * Endpoints (https://docs.twitterapi.io, read 2026-11-25), base https://api.twitterapi.io, header
 * X-API-Key (the key travels in that header only, never in a URL, a log line or an error):
 *  - GET /twitter/user/info?userName=                     profile: id, followers, following,
 *        protected; an account that does not exist answers status "error" ("user not found"), a
 *        suspended one data.unavailable with unavailableReason
 *  - GET /twitter/user/followings?userName=&cursor=&pageSize=200   newest follows first,
 *        followings[] (id, screen_name, name, followers_count, description, url), has_next_page,
 *        next_cursor
 *  - GET /twitter/user/followers_ids?userName=&count=5000&cursor=  ids[] as strings; the list
 *        ends when next_cursor is "" or "0" and has_next_page is false
 *  - GET /twitter/user/check_follow_relationship?source_user_name=&target_user_name=
 *        data.following (the source follows the target), data.followed_by (the target follows
 *        the source)
 * The credit balance (GET /oapi/my/info) is not read: whether that call is charged is not documented.
 *
 * Every call goes through metered() into the usage ledger as provider "twitterapi". The API does
 * not return what a call was charged, so credits are estimated from the published credit table
 * (src/lib/usage/prices.ts: $1 = 100,000 credits) and booked "estimated". 15 s per call, no
 * retry (a retry could be charged twice). None of the exported functions throw: failures come
 * back as values, with a message that is the status and a hint, never a key or a URL.
 */

const BASE = "https://api.twitterapi.io";
const CALL_TIMEOUT_MS = 15_000;
/** Followings per page: 200 is the cheapest tier (1 credit each). */
const FOLLOWINGS_PAGE = 200;
/** Follower ids per page: 5,000 is the cheapest tier (0.45 credits each). */
const FOLLOWER_IDS_PAGE = 5000;
/** twitterapi.io's minimum charge for a call it answered, an empty answer included (twitterapi.io/pricing). */
const TWITTERAPI_MIN_CREDITS = 15;

/** An account as the follow lists give it. */
export interface XGraphUser {
  /** The numeric X id, as text. */
  id: string;
  /** The screen name, without "@". */
  handle: string;
  name: string | null;
  followers: number | null;
  /** Bio text and the profile link's expanded URL: read during a check to tie an X account to a LinkedIn connection, never stored. */
  bio: string | null;
}

export interface XUser {
  id: string;
  handle: string;
  name: string | null;
  followers: number | null;
  following: number | null;
  protected: boolean;
  /** Suspended or otherwise unavailable: no lists can be read. */
  unavailable: boolean;
}

/**
 * Why a call failed. sent: false when no request left (no key, a bad handle), so nothing can have
 * been charged. status: the HTTP status, when there was one.
 */
export interface XFailure {
  error: string;
  status: number | null;
  sent: boolean;
  /** Credits a failed call may have been charged (the most it costs), for the budget. */
  maxCredits: number;
}

export type XResult<T> = ({ ok: true; credits: number } & T) | ({ ok: false } & XFailure);

/** A list read: the pages read so far come back even when a later page failed (partial). */
export type XListResult<T> = ({ ok: true } & XListPage<T>) | ({ ok: false; partial: XListPage<T> } & XFailure);

export function xGraphStatus(): ProviderStatus {
  const base = { id: "twitterapi", label: "X follows (twitterapi.io)" };
  if (!hasEnv("TWITTERAPI_IO_KEY")) {
    return { ...base, configured: false, detail: "Off: set TWITTERAPI_IO_KEY to compare your X follows with a lead's for warm paths." };
  }
  return {
    ...base,
    configured: true,
    detail: "Reads who you and a lead follow on X, for warm paths. Billed per account returned; capped by WARM_PATH_X_USD_PER_DAY.",
  };
}

/** A screen name, or null: [A-Za-z0-9_]{1,15}. */
function handleOf(value: string): string | null {
  const v = String(value ?? "").trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(v) ? v : null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const str = (v: unknown, max = 400): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : null);

const HINTS: Record<number, string> = {
  400: "the request was refused; check the handle",
  401: "check TWITTERAPI_IO_KEY",
  402: "out of twitterapi.io credits; top up",
  403: "the key may not use this endpoint; check TWITTERAPI_IO_KEY",
  404: "not found",
  429: "twitterapi.io rate limit; try again in a minute",
};

/** "twitterapi.io HTTP 502 (the X data service had an error; try again later)": the status and a hint, never a key or a URL. */
export function describeXError(err: unknown): string {
  if (err instanceof HttpError) {
    const hint = HINTS[err.status] ?? (err.status >= 500 ? "the X data service had an error; try again later" : "");
    return `twitterapi.io HTTP ${err.status}${hint ? ` (${hint})` : ""}`;
  }
  if (err instanceof XAnswerError) return `twitterapi.io: ${err.message}`;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "twitterapi.io did not answer in time";
  if (err instanceof SyntaxError) return "twitterapi.io sent an unreadable answer";
  return "twitterapi.io could not be reached";
}

/** An answer with status "error" (HTTP 200), phrased for people. The API's own message is kept only when it is a short, plain phrase. */
class XAnswerError extends Error {}

function answerError(body: Json): XAnswerError | null {
  if (String(body.status ?? "").toLowerCase() !== "error") return null;
  const raw = str(body.msg ?? body.message, 120) ?? "";
  const key = optionalEnv("TWITTERAPI_IO_KEY");
  const safe = raw && /^[\w .,'()-]+$/.test(raw) && !(key && raw.includes(key)) ? raw : "the request failed";
  return new XAnswerError(safe);
}

/** One metered GET. `estimate` reads the credits from the answer; `maxCredits` is what a failed call may have cost. */
async function call(
  operation: string,
  path: string,
  query: Record<string, string | number>,
  estimate: (body: Json) => { credits: number; items: number },
  opts: { timeoutMs?: number } = {},
): Promise<Json> {
  const key = optionalEnv("TWITTERAPI_IO_KEY");
  if (!key) throw new NotSentError("X follows are off: TWITTERAPI_IO_KEY is not set");
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ""}`;
  return metered(
    {
      provider: "twitterapi",
      operation,
      onOk: (body: Json) => {
        const { credits, items } = estimate(body);
        return { units: { requests: 1, credits, items }, costUsd: twitterapiCostUsd(credits), costBasis: "estimated" };
      },
      // An answer with status "error" (HTTP 200, e.g. "user not found") was served, and twitterapi.io
      // bills at least 15 credits a call even when nothing comes back. An HTTP error or a timeout
      // stays unknown: the pricing pages do not say those are charged.
      onFail: (err: unknown): Metered =>
        err instanceof XAnswerError
          ? { units: { requests: 1, credits: TWITTERAPI_MIN_CREDITS }, costUsd: twitterapiCostUsd(TWITTERAPI_MIN_CREDITS), costBasis: "estimated" }
          : { units: { requests: 1 } },
    },
    async () => {
      const body = obj(await fetchJson<unknown>(url, { headers: { "X-API-Key": key }, timeoutMs: Math.max(1000, Math.min(CALL_TIMEOUT_MS, opts.timeoutMs ?? CALL_TIMEOUT_MS)), retry: false }));
      const bad = answerError(body);
      if (bad) throw bad;
      return body;
    },
  );
}

/** Nothing was sent: no key, or the input was not valid. */
class NotSentError extends Error {}

function failure(err: unknown, maxCredits: number): XFailure {
  if (err instanceof NotSentError) return { error: err.message, status: null, sent: false, maxCredits: 0 };
  return { error: describeXError(err), status: err instanceof HttpError ? err.status : null, sent: true, maxCredits };
}

/**
 * The profile of a screen name: id, counts, protected, unavailable. `user` is null when the account
 * does not exist ("user not found"). About 18 credits.
 */
export async function getXUser(handle: string, opts: { timeoutMs?: number } = {}): Promise<XResult<{ user: XUser | null }>> {
  const h = handleOf(handle);
  if (!h) return { ok: false, error: "Not a valid X handle", status: null, sent: false, maxCredits: 0 };
  try {
    const body = await call("user-info", "/twitter/user/info", { userName: h }, () => ({ credits: TWITTERAPI_CREDITS.userInfo, items: 1 }), opts);
    const d = obj(body.data);
    const id = str(d.id, 40);
    if (!id && d.unavailable !== true) return { ok: true, credits: TWITTERAPI_CREDITS.userInfo, user: null };
    return {
      ok: true,
      credits: TWITTERAPI_CREDITS.userInfo,
      user: {
        id: id ?? "",
        handle: str(d.userName, 40) ?? h,
        name: str(d.name, 200),
        followers: num(d.followers),
        following: num(d.following),
        protected: d.protected === true,
        unavailable: d.unavailable === true,
      },
    };
  } catch (err) {
    if (err instanceof XAnswerError && /not found/i.test(err.message)) return { ok: true, credits: TWITTERAPI_CREDITS.userInfo, user: null };
    return { ok: false, ...failure(err, TWITTERAPI_CREDITS.userInfo) };
  }
}

function userFrom(raw: unknown): XGraphUser | null {
  const u = obj(raw);
  const id = str(u.id ?? u.id_str, 40);
  const handle = str(u.screen_name ?? u.userName, 40);
  if (!id || !/^\d+$/.test(id) || !handle) return null;
  const links = [str(u.url, 300), ...(Array.isArray(obj(obj(u.entities).url).urls) ? (obj(obj(u.entities).url).urls as unknown[]).map((x) => str(obj(x).expanded_url, 300)) : [])];
  const bio = [str(u.description, 600), ...links].filter(Boolean).join(" ") || null;
  return { id, handle: handle.replace(/^@/, ""), name: str(u.name, 200), followers: num(u.followers_count ?? u.followers), bio };
}

export interface XListPage<T> {
  items: T[];
  /** False when more pages were left unread (the cap, the time or a failure). */
  complete: boolean;
  pages: number;
  credits: number;
}

/**
 * Who a screen name follows, newest first, up to `max` (5,000 by default), 200 a page. Stops early
 * at `stopAt` (epoch ms), or before a call whose worst case would take the read past `maxCredits`,
 * with complete false. On a failed page the pages read so far are returned with `error`. Credits:
 * 1 per account at 200 a page (2 or 3 on a short page), at least 60 a call.
 */
export async function getXFollowings(
  handle: string,
  opts: { max?: number; stopAt?: number; maxCredits?: number } = {},
): Promise<XListResult<XGraphUser>> {
  const h = handleOf(handle);
  if (!h) return { ok: false, error: "Not a valid X handle", status: null, sent: false, maxCredits: 0, partial: { items: [], complete: false, pages: 0, credits: 0 } };
  const max = Math.max(1, Math.min(opts.max ?? 5000, 50_000));
  const items: XGraphUser[] = [];
  const seen = new Set<string>();
  let cursor = "";
  let pages = 0;
  let credits = 0;
  for (;;) {
    const left = opts.stopAt ? opts.stopAt - Date.now() : CALL_TIMEOUT_MS;
    if (left < 1500) return { ok: true, items, complete: false, pages, credits };
    // Never send a call that could take the read past its credits (short pages cost more each).
    if (opts.maxCredits !== undefined && credits + TWITTERAPI_CREDITS.followingsMaxCall > opts.maxCredits) return { ok: true, items, complete: false, pages, credits };
    try {
      const body = await call(
        "followings",
        "/twitter/user/followings",
        { userName: h, cursor, pageSize: FOLLOWINGS_PAGE },
        (b) => {
          const n = Array.isArray(b.followings) ? b.followings.length : 0;
          return { credits: followingsCredits(n), items: n };
        },
        { timeoutMs: left },
      );
      const page = Array.isArray(body.followings) ? body.followings : [];
      pages++;
      credits += followingsCredits(page.length);
      for (const raw of page) {
        const u = userFrom(raw);
        if (u && !seen.has(u.id) && items.length < max) {
          seen.add(u.id);
          items.push(u);
        }
      }
      const next = str(body.next_cursor, 400) ?? "";
      const more = body.has_next_page === true && next !== "" && next !== "0" && page.length > 0;
      if (!more) return { ok: true, items, complete: true, pages, credits };
      if (items.length >= max) return { ok: true, items, complete: false, pages, credits };
      cursor = next;
    } catch (err) {
      const f = failure(err, TWITTERAPI_CREDITS.followingsMaxCall);
      return { ok: false, ...f, partial: { items, complete: false, pages, credits } };
    }
  }
}

/**
 * The ids of an account's followers, up to `max` (20,000 by default), 5,000 a call. Stops early at
 * `stopAt`, or before a call whose worst case would take the read past `maxCredits`. Credits: 0.45
 * per id at 4,000 to 5,000 a call, 1 at 200 to 3,999, 2 below; at least 100.
 */
export async function getXFollowerIds(
  handle: string,
  opts: { max?: number; stopAt?: number; maxCredits?: number } = {},
): Promise<XListResult<string>> {
  const h = handleOf(handle);
  if (!h) return { ok: false, error: "Not a valid X handle", status: null, sent: false, maxCredits: 0, partial: { items: [], complete: false, pages: 0, credits: 0 } };
  const max = Math.max(1, Math.min(opts.max ?? 20_000, 200_000));
  const items: string[] = [];
  const seen = new Set<string>();
  let cursor = "";
  let pages = 0;
  let credits = 0;
  for (;;) {
    const left = opts.stopAt ? opts.stopAt - Date.now() : CALL_TIMEOUT_MS;
    if (left < 1500) return { ok: true, items, complete: false, pages, credits };
    if (opts.maxCredits !== undefined && credits + TWITTERAPI_CREDITS.followerIdsMaxCall > opts.maxCredits) return { ok: true, items, complete: false, pages, credits };
    try {
      const body = await call(
        "followers-ids",
        "/twitter/user/followers_ids",
        { userName: h, count: FOLLOWER_IDS_PAGE, ...(cursor ? { cursor } : {}) },
        (b) => {
          const n = Array.isArray(b.ids) ? b.ids.length : 0;
          return { credits: followerIdsCredits(n), items: n };
        },
        { timeoutMs: left },
      );
      const ids = Array.isArray(body.ids) ? body.ids : [];
      pages++;
      credits += followerIdsCredits(ids.length);
      for (const raw of ids) {
        const id = str(raw, 40);
        if (id && /^\d+$/.test(id) && !seen.has(id) && items.length < max) {
          seen.add(id);
          items.push(id);
        }
      }
      const next = str(body.next_cursor, 400) ?? "";
      const more = body.has_next_page === true && next !== "" && next !== "0" && ids.length > 0;
      if (!more) return { ok: true, items, complete: true, pages, credits };
      if (items.length >= max) return { ok: true, items, complete: false, pages, credits };
      cursor = next;
    } catch (err) {
      const f = failure(err, TWITTERAPI_CREDITS.followerIdsMaxCall);
      return { ok: false, ...f, partial: { items, complete: false, pages, credits } };
    }
  }
}

/**
 * Whether `source` follows `target` (following) and `target` follows `source` (followedBy).
 * 100 credits.
 */
export async function checkXFollow(source: string, target: string, opts: { timeoutMs?: number } = {}): Promise<XResult<{ following: boolean; followedBy: boolean }>> {
  const s = handleOf(source);
  const t = handleOf(target);
  if (!s || !t) return { ok: false, error: "Not a valid X handle", status: null, sent: false, maxCredits: 0 };
  try {
    const body = await call(
      "follow-check",
      "/twitter/user/check_follow_relationship",
      { source_user_name: s, target_user_name: t },
      () => ({ credits: TWITTERAPI_CREDITS.followCheck, items: 1 }),
      opts,
    );
    const d = obj(body.data);
    return { ok: true, credits: TWITTERAPI_CREDITS.followCheck, following: d.following === true, followedBy: d.followed_by === true };
  } catch (err) {
    return { ok: false, ...failure(err, TWITTERAPI_CREDITS.followCheck) };
  }
}

/** Credits for one followings page of `n` accounts: 1 each at 200, 2 at 100 to 199, 3 below 100; at least 60 a call. */
export function followingsCredits(n: number): number {
  const each = n >= 200 ? 1 : n >= 100 ? 2 : 3;
  return Math.max(TWITTERAPI_CREDITS.followingsMinCall, Math.ceil(Math.max(0, n) * each));
}

/** Credits for one follower-ids call returning `n` ids: 0.45 each at 4,000+, 1 at 200 to 3,999, 2 below; at least 100 a call. */
export function followerIdsCredits(n: number): number {
  const each = n >= 4000 ? 0.45 : n >= 200 ? 1 : 2;
  return Math.max(TWITTERAPI_CREDITS.followerIdsMinCall, Math.ceil(Math.max(0, n) * each));
}

/** The credits a list of `total` follower ids costs, 5,000 a call. */
export function estimateFollowerIdsCredits(total: number, max = 20_000): number {
  let left = Math.max(0, Math.min(total, max));
  let credits = 0;
  do {
    const n = Math.min(FOLLOWER_IDS_PAGE, left);
    credits += followerIdsCredits(n);
    left -= n;
  } while (left > 0);
  return credits;
}

/** The credits the newest `total` follows cost, 200 a page. */
export function estimateFollowingsCredits(total: number, max = 5000): number {
  let left = Math.max(0, Math.min(total, max));
  let credits = 0;
  do {
    const n = Math.min(FOLLOWINGS_PAGE, left);
    credits += followingsCredits(n);
    left -= n;
  } while (left > 0);
  return credits;
}
