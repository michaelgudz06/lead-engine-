import { type NextRequest } from "next/server";
import { z } from "zod";
import { authConfigError, authEnabled, checkPassword, createSessionToken, sessionCookie } from "@/lib/auth";
import { fail, json, readJson, serverError } from "../_lib/api";

const LoginBody = z.object({
  password: z.string({ error: "Enter the team password." }).max(1024, "That password is too long."),
});

/** Every wrong password costs the caller this long: a fixed delay, so timing reveals nothing. */
const FAILURE_DELAY_MS = 600;

/**
 * Failed attempts per client IP, per server instance. On Vercel each instance keeps
 * its own count, so this slows guessing down rather than stopping it outright; the
 * real protection is a long team password.
 */
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: NextRequest): string {
  // Vercel sets x-forwarded-for itself (clients cannot spoof the first entry there).
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "local";
}

function blockedForMs(key: string, now: number): number {
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) return 0;
  return entry.count >= MAX_FAILURES ? entry.resetAt - now : 0;
}

function recordFailure(key: string, now: number): void {
  if (failures.size > 5000) {
    for (const [k, v] of failures) if (v.resetAt <= now) failures.delete(k);
    if (failures.size > 5000) failures.clear();
  }
  const entry = failures.get(key);
  if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

/** POST /api/login { password } -> { ok: true } and the le_session cookie; 401 for a wrong password. */
export async function POST(request: NextRequest) {
  // Gate off (no APP_PASSWORD): there is nothing to log in to.
  if (!authEnabled()) return json({ ok: true });

  const configError = authConfigError();
  if (configError) {
    console.error(`[api] login is not possible: ${configError}`);
    return fail(500, `Login is not set up on the server: ${configError}`);
  }

  const key = clientKey(request);
  const blocked = blockedForMs(key, Date.now());
  if (blocked > 0) {
    const minutes = Math.max(1, Math.ceil(blocked / 60_000));
    const res = fail(429, `Too many wrong passwords. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    res.headers.set("retry-after", String(Math.ceil(blocked / 1000)));
    return res;
  }

  const body = await readJson(request, LoginBody);
  if (!body.ok) return body.response;

  try {
    if (!(await checkPassword(body.data.password))) {
      recordFailure(key, Date.now());
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
      return fail(401, "That password is not right.");
    }
    failures.delete(key);
    const res = json({ ok: true });
    res.cookies.set(sessionCookie(await createSessionToken()));
    return res;
  } catch (err) {
    return serverError("POST /api/login", err);
  }
}
