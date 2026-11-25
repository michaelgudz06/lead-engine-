import "server-only";

/**
 * Typed access to environment variables. Server-only: importing this from a
 * client component fails the build, so no key can reach the browser bundle.
 */
export const KEYS = [
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_EFFORT",
  "EXA_API_KEY",
  "UNIPILE_API_KEY",
  "UNIPILE_DSN",
  "UNIPILE_ACCOUNT_ID",
  "APIFY_TOKEN",
  "APOLLO_API_KEY",
  "HUNTER_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_X_MODEL",
  "ABSTRACT_API_KEY",
  "HUBSPOT_ACCESS_TOKEN",
  "APP_PASSWORD",
  "SESSION_SECRET",
  "HF_TOKEN",
  "ALLOW_OPEN_ACCESS",
  "RUN_LIMIT_PER_HOUR",
  "RUN_LIMIT_PER_DAY",
  "IMPORT_LIMIT_PER_DAY",
  "HUNTER_CREDITS_PER_DAY",
  // Warm paths: X follows through twitterapi.io, and the owner's own LinkedIn on Unipile (step 2,
  // off until set). Both daily budgets are whole numbers; 0 pauses that source.
  "TWITTERAPI_IO_KEY",
  "UNIPILE_NETWORK_ACCOUNT_ID",
  "WARM_PATH_LINKEDIN_CHECKS_PER_DAY",
  "WARM_PATH_X_USD_PER_DAY",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
] as const;

export type EnvKey = (typeof KEYS)[number];

/**
 * Secrets that guard access. Any non-empty value counts as set, so a placeholder left
 * in place keeps the gate closed instead of silently turning it off.
 */
const FAIL_CLOSED: ReadonlySet<EnvKey> = new Set<EnvKey>(["APP_PASSWORD", "SESSION_SECRET"]);

/** The value, or undefined when unset or left as a placeholder. */
export function optionalEnv(key: EnvKey): string | undefined {
  const v = process.env[key]?.trim();
  if (!v) return undefined;
  if (!FAIL_CLOSED.has(key) && (v.startsWith("REPLACE") || v.includes("XXXX"))) return undefined;
  return v;
}

export function requireEnv(key: EnvKey): string {
  const v = optionalEnv(key);
  if (!v) throw new Error(`${key} is not set. Add it to .env.local (see .env.example).`);
  return v;
}

export function hasEnv(...keys: EnvKey[]): boolean {
  return keys.every((k) => optionalEnv(k) !== undefined);
}

/** The only Claude model and effort this app runs. Fixed by the owner: Haiku, low. */
export const CLAUDE_MODEL = "claude-haiku-5-5" as const;
export const CLAUDE_EFFORT = "low" as const;
