import { NextResponse, type NextRequest } from "next/server";
import { authEnabled, SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * The access gate (BUILD_SPEC 8b). Next 16 calls this "proxy" (it was "middleware").
 *
 * Gate off (APP_PASSWORD unset, local dev): everything passes through.
 * Gate on, no valid session:
 *   - pages redirect to /login?next=<where they were going>
 *   - /api/* answers 401 JSON (the UI's fetch helper then sends the person to /login)
 * Always open: /login, /api/login, /api/logout, and the static files the matcher skips.
 *
 * The cookie check is a pure HMAC verification (no database), so it stays fast.
 * Route handlers do not re-check the session: everything under /api is matched here.
 */

const ALWAYS_OPEN = new Set(["/login", "/api/login", "/api/logout"]);

/** An open app in production is almost always a missing env var: say so once per instance, in the logs. */
let warnedOpen = false;

/** Same rules as the login page: only same-site paths, so `next` cannot send anyone elsewhere. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.startsWith("/login")) return "/";
  return next;
}

export async function proxy(request: NextRequest): Promise<Response> {
  if (!authEnabled()) {
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
    return NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url));
  }
  if (signedIn || ALWAYS_OPEN.has(pathname)) return NextResponse.next();

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Log in to use Lead Engine." }, { status: 401, headers: { "cache-control": "no-store" } });
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
