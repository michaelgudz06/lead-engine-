import "server-only";
import { optionalEnv } from "./env";

/**
 * The access gate: one shared team password, no user accounts (BUILD_SPEC 8b).
 *
 * - The gate is on exactly when APP_PASSWORD is set. Local dev leaves it unset; on
 *   Vercel (VERCEL=1) the proxy then refuses every request with 503 instead.
 * - A login sets `le_session`, a token signed with HMAC-SHA256 under SESSION_SECRET.
 * - Only Web Crypto and other Web APIs are used, so this module runs unchanged in
 *   the proxy (src/proxy.ts), in route handlers and in plain Node scripts.
 *
 * Token format: `v1.<expiresAtMs>.<base64url HMAC>`. The HMAC covers the expiry and
 * the current APP_PASSWORD (the password never leaves the server), so changing the
 * password, or SESSION_SECRET, signs everyone out.
 */

export const SESSION_COOKIE = "le_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
/** Tolerates small clock differences between the instance that signed and the one that verifies. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A shorter secret is treated as missing: it could be brute-forced from one cookie. */
const MIN_SECRET_LENGTH = 16;
/** Bounds the work an attacker can make us do per request. */
const MAX_TOKEN_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;

const TOKEN_RE = /^v1\.(\d{12,15})\.([A-Za-z0-9_-]{43})$/;
const encoder = new TextEncoder();

/** True when the app requires the team password (APP_PASSWORD is set). When false, see the Vercel lock in src/proxy.ts. */
export function authEnabled(): boolean {
  return optionalEnv("APP_PASSWORD") !== undefined;
}

/**
 * Why a gate that is on cannot issue or check sessions, or null when it can (or is off).
 * A misconfigured gate fails closed: every protected request is refused.
 */
export function authConfigError(): string | null {
  if (!authEnabled()) return null;
  const secret = optionalEnv("SESSION_SECRET");
  if (!secret) return "SESSION_SECRET is not set. Set it to a long random string, for example the output of `openssl rand -hex 32`.";
  if (secret.length < MIN_SECRET_LENGTH) {
    return `SESSION_SECRET is too short (at least ${MIN_SECRET_LENGTH} characters). Use the output of \`openssl rand -hex 32\`.`;
  }
  return null;
}

function gateSecrets(): { password: string; secret: string } | null {
  const password = optionalEnv("APP_PASSWORD");
  const secret = optionalEnv("SESSION_SECRET");
  if (!password || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  return { password, secret };
}

// ------------------------------------------------------------------ password

let compareKey: Promise<CryptoKey> | null = null;

/** A random per-process key: both sides are HMACed before comparing, which hides length and content timing. */
function getCompareKey(): Promise<CryptoKey> {
  if (!compareKey) {
    compareKey = crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]).catch((err: unknown) => {
      compareKey = null;
      throw err;
    }) as Promise<CryptoKey>;
  }
  return compareKey;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Constant-time check of a login attempt against APP_PASSWORD. Both are trimmed,
 * the same way env.ts trims the stored value. False when the gate is off.
 */
export async function checkPassword(candidate: string): Promise<boolean> {
  const expected = optionalEnv("APP_PASSWORD");
  if (!expected || typeof candidate !== "string" || candidate.length > MAX_PASSWORD_LENGTH) return false;
  const key = await getCompareKey();
  const [a, b] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(candidate.trim())),
    crypto.subtle.sign("HMAC", key, encoder.encode(expected)),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

// ------------------------------------------------------------------ session token

let signingKeyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

function signingKey(secret: string): Promise<CryptoKey> {
  if (signingKeyCache?.secret !== secret) {
    const key = crypto.subtle
      .importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
      .catch((err: unknown) => {
        signingKeyCache = null;
        throw err;
      });
    signingKeyCache = { secret, key };
  }
  return signingKeyCache.key;
}

function signedMessage(expiresAt: number, password: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`le_session|v1|${expiresAt}|${password}`);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A fresh session token valid for 30 days. Throws when the gate is off or misconfigured. */
export async function createSessionToken(now: number = Date.now()): Promise<string> {
  const gate = gateSecrets();
  if (!gate) throw new Error(authConfigError() ?? "The access gate is off (APP_PASSWORD is not set).");
  const expiresAt = Math.floor(now) + SESSION_MAX_AGE_MS;
  const mac = await crypto.subtle.sign("HMAC", await signingKey(gate.secret), signedMessage(expiresAt, gate.password));
  return `v1.${expiresAt}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * True only for an unexpired token signed with the current SESSION_SECRET and
 * APP_PASSWORD. Never throws: anything malformed is simply not a session.
 */
export async function verifySessionToken(token: string | null | undefined, now: number = Date.now()): Promise<boolean> {
  const gate = gateSecrets();
  if (!gate || typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return false;
  const match = TOKEN_RE.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  // Expired, or further out than this code ever signs: refuse.
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + SESSION_MAX_AGE_MS + CLOCK_SKEW_MS) return false;
  const mac = fromBase64Url(match[2]);
  // Re-encoding rejects non-canonical spellings of the same bytes, so a token has exactly one valid form.
  if (!mac || mac.length !== 32 || toBase64Url(mac) !== match[2]) return false;
  try {
    // subtle.verify compares in constant time.
    return await crypto.subtle.verify("HMAC", await signingKey(gate.secret), mac, signedMessage(expiresAt, gate.password));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ cookie

export interface SessionCookie {
  name: string;
  value: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  maxAge: number;
}

/**
 * Attributes for `response.cookies.set(...)`. SameSite=Lax keeps the cookie off
 * cross-site POSTs, which is what protects the JSON API from CSRF. Pass an empty
 * value and maxAge 0 to clear it.
 */
export function sessionCookie(value: string, maxAge: number = SESSION_MAX_AGE_SECONDS): SessionCookie {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}
