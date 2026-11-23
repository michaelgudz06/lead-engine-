import "server-only";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { requireEnv } from "./env";

/**
 * Neon over HTTPS (@neondatabase/serverless, HTTP transport).
 *
 * Why HTTP and not node-postgres: it works from every runtime this app meets,
 * including locked-down networks that only allow port 443 and serverless
 * functions that should not hold a socket. Each query is one HTTPS request.
 * For multi-statement atomic work use `sql.transaction([...])`.
 */
let client: NeonQueryFunction<false, false> | null = null;

export function db(): NeonQueryFunction<false, false> {
  if (!client) client = neon(requireEnv("DATABASE_URL"));
  return client;
}

/** Parameterised query with $1..$n placeholders. Returns rows. */
export async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await db().query(text, params);
  return rows as T[];
}

/** JSON for a jsonb parameter. Always pair with an explicit ::jsonb cast in SQL. */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
