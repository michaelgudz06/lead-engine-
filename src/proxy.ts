import { NextResponse, type NextRequest } from "next/server";
import { adminDenial, isAdminApiPath, isAdminPath } from "@/lib/admin/access";
import { authEnabled, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { optionalEnv } from "@/lib/env";

/**
 * The access gate (BUILD_SPEC 8b) and the owner's usage panel. Next 16 calls this "proxy"
 * (it was "middleware"). Rules, in order:
 *
 * 1. A write (POST/PUT/PATCH/DELETE) sent by a browser from another site is refused with 403
 *    on every path, gate on or off, so no website can start research runs or change leads.
 * 2. /ingest and /ingest/* pass: PostHog's same-origin reverse proxy (rewrites in
 *    next.config.ts). It carries analytics events only, and the login page sends them before
 *    anyone has a session, so it is exempt from the gate and from the Vercel lock. Its
 *    requests go on without their Cookie header, so the session never reaches PostHog.
 * 3. Gate off (APP_PASSWORD unset): a local run passes. On Vercel every request is refused
 *    with 503, so a deploy is never open by accident, unless the owner chose an open deploy
 *    with ALLOW_OPEN_ACCESS=1: then requests pass, and the logs say so once per instance.
 * 4. Gate on, no valid session: pages redirect to /login?next=<where they were going>, and
 *    /api/* answers 401 JSON (the UI's fetch helper then sends the person to /login).
 *    Always open: /login, /api/login, /api/logout, and the static files the matcher skips.
 * 5. The owner's usage panel (/admin, /admin/*, /api/admin/*), for a request the rules above
 *    let through: it has no password and answers only on the owner's own computer, run with
 *    `npm run admin` (or `npm run dev`); see src/lib/admin/access.ts. Anywhere else (Vercel, a
 *    production build, a LAN address, any other host name) it gets exactly what a missing
 *    page gets: Next's own 404 page, or 404 JSON for the API. Because this comes after rules
 *    3 and 4, a locked or gated deploy answers /admin like every other path, so nothing
 *    tells a visitor the panel exists. The admin layout and every admin handler check again.
 *
 * The session check is a pure HMAC verification (no database), so this stays fast. The team
 * route handlers do not re-check the session: everything under /api is matched here.
 */

const ALWAYS_OPEN = new Set(["/login", "/api/login", "/api/logout"]);
const NO_STORE = { "cache-control": "no-store" } as const;

/** Methods that change something. Reads stay open to links from other sites. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Where a refused admin page request is sent internally: a path no route can match (app
 * folders starting with "_" never become routes), so Next answers with its usual 404 page,
 * the same one any unknown address gets.
 */
const MISSING_PAGE = "/_missing";

/** An open app in production is almost always a missing env var: say so once per instance, in the logs. */
let warnedOpen = false;

/** The owner's explicit choice to run a deploy without the team password. Only the exact value "1" counts. */
function openAccessAllowed(): boolean {
  return optionalEnv("ALLOW_OPEN_ACCESS") === "1";
}

/**
 * Where to send someone after login: a path on this site, never another site. The value is
 * resolved against our own origin the way a browser would resolve it (URL parsing drops tab,
 * CR and LF, so "/\t/evil.example" becomes "//evil.example"), and anything that does not stay
 * on this origin falls back to "/". The returned path is resolved again by the redirect, so
 * it must not start with "//" either: dot segments ("/.//evil.example") resolve to exactly
 * that. Same rules as the login page.
 */
function safeNext(next: string | null, origin: string): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname.startsWith("//") || url.pathname.startsWith("/login")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/**
 * A write a browser sends on behalf of another site (CSRF). Every current browser sets
 * Sec-Fetch-Site, and page scripts cannot change it; older browsers are judged by Origin.
 * Scripts and other non-browser clients send neither header and pass. No page here
 * accepts writes (there are no Server Actions), so the rule applies to every path.
 */
function isCrossSiteWrite(request: NextRequest): boolean {
  if (!WRITE_METHODS.has(request.method)) return false;
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = request.headers.get("origin");
  return origin !== null && origin !== request.nextUrl.origin;
}

/**
 * PostHog's reverse proxy: /ingest and anything under it, as plain paths only. An encoded
 * slash or backslash or a dot segment could be read as another path further down, so such a
 * path gets no exemption (it simply meets the gate like any other).
 */
function isIngest(pathname: string): boolean {
  if (pathname !== "/ingest" && !pathname.startsWith("/ingest/")) return false;
  return !/%2f|%5c|\\|(^|\/)\.\.?(\/|$)/i.test(pathname);
}

/** Rule 5: a request the gate and the lock let through. The usage panel also needs the owner's computer. */
function pass(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!isAdminPath(pathname)) return NextResponse.next();
  const api = isAdminApiPath(pathname);
  if (adminDenial({ headers: request.headers, urlHostname: request.nextUrl.hostname, api }) !== null) {
    if (api) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    return NextResponse.rewrite(new URL(MISSING_PAGE, request.url));
  }
  const res = NextResponse.next();
  res.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  // Nothing may frame the panel, not even a page on this computer.
  res.headers.set("x-frame-options", "DENY");
  res.headers.set("content-security-policy", "frame-ancestors 'none'");
  return res;
}

export async function proxy(request: NextRequest): Promise<Response> {
  // Before the gate, so a local run with the gate off is covered too.
  if (isCrossSiteWrite(request)) {
    return NextResponse.json({ error: "Cross-site requests are not accepted." }, { status: 403, headers: NO_STORE });
  }

  const { pathname, search } = request.nextUrl;
  if (isIngest(pathname)) {
    // PostHog needs no cookies: never forward the team session (le_session) to it.
    const headers = new Headers(request.headers);
    headers.delete("cookie");
    return NextResponse.next({ request: { headers } });
  }

  if (!authEnabled()) {
    // Vercel sets VERCEL=1 at runtime; a client cannot fake it the way it could a Host header.
    const onVercel = process.env.VERCEL === "1";
    if (onVercel && !openAccessAllowed()) {
      return NextResponse.json(
        { error: "Lead Engine is locked: set APP_PASSWORD and SESSION_SECRET on the server (or ALLOW_OPEN_ACCESS=1 to run it open)." },
        { status: 503, headers: NO_STORE },
      );
    }
    if (!warnedOpen && (onVercel || process.env.NODE_ENV === "production")) {
      warnedOpen = true;
      console.warn(
        onVercel
          ? "[proxy] ALLOW_OPEN_ACCESS=1 and APP_PASSWORD is not set: Lead Engine is open to anyone with the URL, as the owner chose. Set APP_PASSWORD and SESSION_SECRET to close it."
          : "[proxy] APP_PASSWORD is not set: Lead Engine is open to anyone with the URL. Set APP_PASSWORD and SESSION_SECRET.",
      );
    }
    return pass(request);
  }

  const signedIn = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  // Someone already signed in has no use for the form.
  if (pathname === "/login" && signedIn) {
    return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next"), request.nextUrl.origin), request.url));
  }
  if (signedIn || ALWAYS_OPEN.has(pathname)) return pass(request);

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Log in to use Lead Engine." }, { status: 401, headers: NO_STORE });
  }

  const login = new URL("/login", request.url);
  if (pathname !== "/" || search) login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except build assets, image optimisation, the favicon and public
    // files with a static extension (icons, robots.txt, the manifest, fonts).
    "/((?!_next/static|_next/image|favicon\\.ico$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|woff|woff2)$).*)",
  ],
};
