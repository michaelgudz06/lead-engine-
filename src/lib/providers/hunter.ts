import "server-only";
import type { ProviderStatus } from "../types";

/**
 * Hunter: a work email from a LinkedIn handle, or from name + company domain.
 * Free plan: 50 credits a month, so callers make at most one call per lead.
 * CONTRACT: signatures fixed; owned by the apollo-hunter agent.
 */
export async function findEmail(input: {
  linkedinUrl?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  domain?: string | null;
  company?: string | null;
}): Promise<{ email: string | null; score: number | null; status: string | null; sources: string[]; error?: string }> {
  void input;
  throw new Error("not implemented");
}

export function hunterStatus(): ProviderStatus {
  throw new Error("not implemented");
}
