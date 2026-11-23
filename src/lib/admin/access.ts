import "server-only";

/**
 * Who may open the owner's usage panel: /admin, /admin/* and /api/admin/*.
 *
 * The panel has no username and no password. It works only on the owner's own computer:
 * run `npm run admin` (next dev bound to 127.0.0.1 on port 3001, so no other machine on the
 * network can even connect) or `npm run dev`, then open http://localhost:3001/admin (or
 * :3000). Everywhere else it answers exactly like a page that does not exist (src/proxy.ts).
 *
 * A request is allowed only when all of these hold:
 *  1. Not deployed: VERCEL is unset, and this is not a production build (NODE_ENV is not
 *     "production"). A deployed copy never serves the panel, whatever sits in front of it;
 *     a reverse proxy that forwards to 127.0.0.1 with its own Host header cannot open it.
 *  2. The Host header is localhost, 127.0.0.1 or [::1] (any port). The browser always sends
 *     the name it connected to, so another site that points its own name at this computer
 *     (DNS rebinding) arrives with that name and is refused.
 *  3. The URL's hostname, when the caller has one, is loopback too. In `next dev` it is the
 *     address the server was started on ("localhost" unless -H was given).
 *  4. Forwarding headers, when present, point at this computer as well: X-Forwarded-Host,
 *     every hop of X-Forwarded-For, X-Real-IP and Forwarded. A tunnel or proxy in front of
 *     the dev server puts the visitor's host or address there. In route handlers and pages,
 *     Next fills X-Forwarded-For from the socket when the client sent none, so a request
 *     from another machine (to a dev server listening on every interface) is refused there.
 *  5. /api/admin/* only: not sent by a browser on behalf of another site (Sec-Fetch-Site
 *     cross-site or same-site), so no web page can make the panel call providers or
 *     download the ledger. Pages can be opened from anywhere on this computer.
 *
 * Pure: reads env and headers, no I/O. The team gate (APP_PASSWORD) is separate and runs
 * first in the proxy.
 */

export type AdminDenial = "deployed" | "host" | "url" | "forwarded" | "cross-site";

export interface AdminRequestInfo {
  headers: { get(name: string): string | null };
  /** request.nextUrl.hostname in the proxy and route handlers. Leave undefined where there is no URL (a layout). */
  urlHostname?: string | null;
  /** True for /api/admin/*: cross-site browser requests are refused too. */
  api?: boolean;
}

/** Why this request may not use the panel, or null when it may. */
export function adminDenial({ headers, urlHostname, api = false }: AdminRequestInfo): AdminDenial | null {
  if (process.env.VERCEL?.trim() || process.env.NODE_ENV === "production") return "deployed";
  if (!isLoopbackHost(headers.get("host"))) return "host";
  if (urlHostname !== undefined && !isLoopbackName(urlHostname)) return "url";

  const forwardedHost = headers.get("x-forwarded-host");
  if (forwardedHost !== null && !forwardedHost.split(",").every(isLoopbackHost)) return "forwarded";
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && !forwardedFor.split(",").every(isLoopbackAddress)) return "forwarded";
  const realIp = headers.get("x-real-ip");
  if (realIp !== null && !isLoopbackAddress(realIp)) return "forwarded";
  const forwarded = headers.get("forwarded");
  if (forwarded !== null && !forwardedIsLocal(forwarded)) return "forwarded";

  if (api) {
    const site = headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return "cross-site";
  }
  return null;
}

export function adminAllowed(info: AdminRequestInfo): boolean {
  return adminDenial(info) === null;
}

/** /admin and everything under it, and the panel's API. */
export function isAdminPath(pathname: string): boolean {
  const p = routerPath(pathname);
  return p === "/admin" || p.startsWith("/admin/") || isAdminApi(p);
}

/** /api/admin and everything under it. */
export function isAdminApiPath(pathname: string): boolean {
  return isAdminApi(routerPath(pathname));
}

function isAdminApi(p: string): boolean {
  return p === "/api/admin" || p.startsWith("/api/admin/");
}

/**
 * The path roughly as the router could read it: escapes decoded, backslashes and repeated
 * slashes folded ("//admin" reaches /admin), letter case ignored. Generous on purpose:
 * anything that might reach the panel is treated as the panel, and the rest 404s anyway.
 */
function routerPath(pathname: string): string {
  let p = String(pathname ?? "");
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(p); i++) {
    try {
      p = decodeURIComponent(p);
    } catch {
      break; // A malformed escape: keep what we have.
    }
  }
  return p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

// ------------------------------------------------------------------ loopback names and addresses

/** A Host header value: localhost, 127.0.0.1 or [::1], with an optional port, nothing else. */
const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;

export function isLoopbackHost(value: string | null | undefined): boolean {
  return typeof value === "string" && LOOPBACK_HOST_RE.test(value.trim());
}

/** A URL hostname (URL keeps IPv6 brackets: "[::1]"). */
export function isLoopbackName(hostname: string | null | undefined): boolean {
  const h = String(hostname ?? "").trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

const IPV4_LOOPBACK_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** An address as Node and proxies write it: 127.x.x.x, ::1, ::ffff:127.0.0.1, "[::1]:5000", "127.0.0.1:5000". */
export function isLoopbackAddress(value: string | null | undefined): boolean {
  let v = String(value ?? "").trim().replace(/^"(.*)"$/, "$1").toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(v);
  if (bracketed) v = bracketed[1];
  else if (/^[\d.]+:\d{1,5}$/.test(v)) v = v.slice(0, v.lastIndexOf(":"));
  if (v === "::1" || v === "0:0:0:0:0:0:0:1") return true;
  return IPV4_LOOPBACK_RE.test(v.startsWith("::ffff:") ? v.slice(7) : v);
}

/** RFC 7239 Forwarded: every for= must be a loopback address and every host= a loopback host. */
function forwardedIsLocal(value: string): boolean {
  for (const element of value.split(",")) {
    for (const pair of element.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) {
        if (pair.trim()) return false;
        continue;
      }
      const key = pair.slice(0, eq).trim().toLowerCase();
      const val = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
      if (key === "for" && !isLoopbackAddress(val)) return false;
      if (key === "host" && !isLoopbackHost(val)) return false;
    }
  }
  return true;
}
