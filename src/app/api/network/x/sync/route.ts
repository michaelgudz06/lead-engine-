import { syncOwnX } from "@/lib/paths/network";
import { fail, json, serverError } from "../../../_lib/api";

/**
 * POST /api/network/x/sync (no body) -> { following, followers, syncedAt, creditsUsed, refreshed,
 * note }: refreshes your X lists now through twitterapi.io, within the daily X budget, in at most
 * 50 s. Counts only. refreshed false (with a note) when the stored lists were kept: the budget had
 * no room for a refresh, X did not answer, or another server was refreshing them.
 * - 400 { code: "not_configured" }: TWITTERAPI_IO_KEY is not set. 400 { code: "no_handle" }: no X
 *   handle in Settings.
 * - 409 { code: "syncing" }: a refresh is already running on this server.
 * - 429 { code: "warm_path_budget" }: today's X budget is used up (or paused) and no lists are stored.
 * - 502 { code: "upstream" }: X did not answer (or your account is private, suspended or not found).
 */

// twitterapi.io pages: your follows (up to 5,000) and follower ids (up to 20,000) within 50 s.
export const maxDuration = 60;

/** A refresh in progress on this instance: a double click must not pay twice. */
let syncing = false;

export async function POST() {
  if (syncing) return fail(409, "Refreshing your X lists now. Try again when it finishes.", { code: "syncing" });
  syncing = true;
  try {
    const res = await syncOwnX();
    if (!res.ok) {
      const status = res.code === "warm_path_budget" ? 429 : res.code === "upstream" ? 502 : 400;
      return fail(status, res.error, { code: res.code });
    }
    return json({
      following: res.following,
      followers: res.followers,
      syncedAt: res.syncedAt,
      creditsUsed: res.creditsUsed,
      refreshed: res.refreshed,
      note: res.note,
    });
  } catch (err) {
    return serverError("POST /api/network/x/sync", err);
  } finally {
    syncing = false;
  }
}
