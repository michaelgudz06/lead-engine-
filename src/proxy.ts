import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * The access gate (BUILD_SPEC 8b). Next 16 calls this "proxy" (it was "middleware").
 *
 * First, gate on or off: a write (POST/PUT/PATCH/DELETE) sent by a browser from another
 * site is refused with 403, so no website can start research runs or change leads.
 * Gate off (APP_PASSWORD unset): a local run passes everything through; on Vercel every
 * request is refused with 503 until APP_PASSWORD is set, so a deploy is never open.
 * Gate on, no valid session:
 *   - pages redirect to /login?next=<where they were going>
 *   - /api/* answers 401 JSON (the UI's fetch helper then sends the person to /login)
 * Always open: /login, /api/login, /api/logout, and the static files the matcher skips.
 *
 * The cookie check is a pure HMAC verification (no database), so it stays fast.
 * Route handlers do not re-check the session: everything under /api is matched here.
 */

const ALWAYS_OPEN = new Set(["/login", "/api/login", "/api/logout"]);
const NO_STORE = { "cache-control": "no-store" } as const;

/** Methods that change something. Reads stay open to links from other sites. */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** An open app in production is almost always a missing env var: say so once per instance, in the logs. */
let warnedOpen = false;

/**
 * Where to send someone after login: a path on this site, never another site. The value is
 * resolved against our own origin the way a browser would resolve it (URL parsing drops tab,
 * CR and LF, so "/\t/evil.example" becomes "//evil.example"), and anything that does not stay
 * on this origin falls back to "/". Same rules as the login page.
 */
function safeNext(next: string | null, origin: string): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  try {
    const url = new URL(next, origin);
    if (url.origin !== origin || url.pathname.startsWith("/login")) return "/";
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

export async function proxy(request: NextRequest): Promise<Response> {
  // Before the gate, so a local run with the gate off is covered too.
  if (isCrossSiteWrite(request)) {
    return NextResponse.json({ error: "Cross-site requests are not accepted." }, { status: 403, headers: NO_STORE });
  }

  if (!authEnabled()) {
    // Vercel sets VERCEL=1 at runtime; a client cannot fake it the way it could a Host header.
    if (process.env.VERCEL === "1") {
      return NextResponse.json({ error: "Lead Engine is locked: set APP_PASSWORD and SESSION_SECRET on the server." }, { status: 503, headers: NO_STORE });
    }
    if (process.env.NODE_ENV === "production" && !warnedOpen) {
      warnedOpen = true;
      console.warn("[proxy] APP_PASSWORD is not set: Lead Engine is open to anyone with the URL. Set APP_PASSWORD and SESSION_SECRET.");
    }
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;
  const signedIn = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  // Someone already signed in has no use for the form.
  if (pathname === "/login" && signedIn) {
    return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next"), request.nextUrl.origin), request.url));
  }
  if (signedIn || ALWAYS_OPEN.has(pathname)) return NextResponse.next();

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
