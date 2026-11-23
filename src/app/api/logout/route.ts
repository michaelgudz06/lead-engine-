import { sessionCookie } from "@/lib/auth";
import { json } from "../_lib/api";

/**
 * POST /api/logout -> { ok: true } and an expired le_session cookie. Always allowed
 * (the proxy lets it through): clearing a cookie needs no session.
 */
export async function POST() {
  const res = json({ ok: true });
  res.cookies.set(sessionCookie("", 0));
  return res;
}
