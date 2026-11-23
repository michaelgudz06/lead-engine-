import "server-only";

/**
 * Typed access to environment variables. Server-only: importing this from a
 * client component fails the build, so no key can reach the browser bundle.
 */
const KEYS = [
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
] as const;

export type EnvKey = (typeof KEYS)[number];

/** The value, or undefined when unset or left as a placeholder. */
export function optionalEnv(key: EnvKey): string | undefined {
  const v = process.env[key]?.trim();
  if (!v || v.startsWith("REPLACE") || v.includes("XXXX")) return undefined;
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
