/**
 * The check-yourself links and handle cleaning for warm paths. Pure and client-safe.
 *
 * The links open in the owner's own logged-in browser, where the network itself shows who they
 * share with the lead. Nothing is read by the app:
 * - LinkedIn's shared-connections search for a member id (format from a Nov 2026 third-party
 *   sample of LinkedIn's own "mutual connections" link; not documented by LinkedIn). Without a
 *   member id, the lead's profile, which shows "N mutual connections" under the name.
 * - X's "Followers you know" tab (path not documented by X). The profile shows "Followed by ...".
 * - The lead's Instagram profile, which shows "Followed by ..." to a logged-in viewer.
 */

import { linkedinSlug } from "../linkedin-url";
import { cleanXHandle } from "../research/util";

const MEMBER_ID = /^A[CD]o[A-Za-z0-9_-]{8,}$/;

/** LinkedIn's own shared-connections search for a member id ("ACo..."), else null. */
export function sharedConnectionsSearchUrl(memberId: string | null | undefined): string | null {
  const id = (memberId ?? "").trim();
  if (!MEMBER_ID.test(id)) return null;
  const facet = (v: string) => encodeURIComponent(JSON.stringify([v]));
  return `https://www.linkedin.com/search/results/people/?facetNetwork=${facet("F")}&facetConnectionOf=${facet(id)}&origin=SHARED_CONNECTIONS_CANNED_SEARCH`;
}

/** The shared-connections search when the member id is known, else the lead's profile (it shows "N mutual connections"). */
export function linkedinMutualsUrl(input: { memberId?: string | null; profileUrl?: string | null; slug?: string | null }): string | null {
  const search = sharedConnectionsSearchUrl(input.memberId);
  if (search) return search;
  const slug = input.slug?.trim() || (input.profileUrl ? linkedinSlug(input.profileUrl) : null);
  return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}/` : null;
}

/** X's "Followers you know" tab for a handle, or null for a handle that is not valid. */
export function xFollowersYouKnowUrl(handle: string | null | undefined): string | null {
  const h = cleanXHandle(handle);
  return h ? `https://x.com/${h}/followers_you_follow` : null;
}

/** The X profile for a handle, or null. */
export function xProfileUrl(handle: string | null | undefined): string | null {
  const h = cleanXHandle(handle);
  return h ? `https://x.com/${h}` : null;
}

/** Instagram paths that are pages of the site, never a username. */
export const INSTAGRAM_RESERVED = ["p", "reel", "reels", "explore", "stories", "accounts", "direct", "tv", "about", "legal", "developer"] as const;

/**
 * An Instagram handle from "@ada.kim", "ada.kim" or an instagram.com link: [A-Za-z0-9._]{1,30},
 * lower case (Instagram usernames are case-insensitive), not a reserved path, not starting or
 * ending with a dot and without two dots in a row. Null otherwise.
 */
export function cleanInstagramHandle(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  const m = v.match(/(?:^|\/\/|\.)instagram\.com\/([^/?#\s]+)/i) ?? v.match(/^instagram\.com\/([^/?#\s]+)/i);
  if (m) v = m[1];
  else if (/[/:]/.test(v)) return null;
  v = v.replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(v)) return null;
  if (v.startsWith(".") || v.endsWith(".") || v.includes("..")) return null;
  const lower = v.toLowerCase();
  if ((INSTAGRAM_RESERVED as readonly string[]).includes(lower)) return null;
  return lower;
}

/** True for a value that names a reserved Instagram path ("explore", "instagram.com/reels/..."). */
export function isReservedInstagramPath(value: string | null | undefined): boolean {
  const v = (value ?? "").trim().replace(/^@/, "");
  const m = v.match(/instagram\.com\/([^/?#\s]+)/i);
  const first = (m ? m[1] : v.split("/")[0]).toLowerCase();
  return (INSTAGRAM_RESERVED as readonly string[]).includes(first);
}

/** The first Instagram handle among links (a LinkedIn profile's websites), or null. */
export function instagramHandleFromUrls(urls: ReadonlyArray<string | null | undefined>): string | null {
  for (const url of urls) {
    if (!url || !/instagram\.com\//i.test(url)) continue;
    const handle = cleanInstagramHandle(url);
    if (handle) return handle;
  }
  return null;
}

/** The lead's Instagram profile, or null. */
export function instagramProfileUrl(handle: string | null | undefined): string | null {
  const h = cleanInstagramHandle(handle);
  return h ? `https://www.instagram.com/${h}/` : null;
}
