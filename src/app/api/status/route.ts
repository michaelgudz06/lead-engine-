import { connection } from "next/server";
import { authEnabled } from "@/lib/auth";
import { CLAUDE_EFFORT, CLAUDE_MODEL } from "@/lib/env";
import { providerStatuses } from "@/lib/providers";
import { getNetworkAccountState, networkAccountConfigured } from "@/lib/providers/linkedin";
import { withUsageContext } from "@/lib/usage/ledger";
import { json, serverError } from "../_lib/api";

/**
 * GET /api/status -> { providers, model: { name, effort }, authEnabled, linkedinAccount }.
 * providers: one row per integration, from env only (no network), twitterapi.io's included.
 * linkedinAccount: your own LinkedIn on Unipile for warm paths (UNIPILE_NETWORK_ACCOUNT_ID):
 * { state: "not_set_up" | "connected" | "needs_reconnect" | "unavailable", detail }. Off (the
 * default) it makes no call. Set, it comes from Unipile's accounts list, which never touches
 * LinkedIn and is cached 10 minutes; a slow answer is "unavailable" after 3 s.
 * connection() keeps it out of the build-time prerender, so the answer always reflects the
 * running server's env.
 */

const ACCOUNT_WAIT_MS = 3000;

type AccountState = Awaited<ReturnType<typeof getNetworkAccountState>>;

async function linkedinAccount(): Promise<AccountState> {
  if (!networkAccountConfigured()) return { state: "not_set_up", detail: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<AccountState>((resolve) => {
    timer = setTimeout(() => resolve({ state: "unavailable", detail: "Unipile did not answer in time." }), ACCOUNT_WAIT_MS);
  });
  try {
    // The accounts call's ledger row is written in this context (never on a lead).
    return await Promise.race([withUsageContext(null, () => getNetworkAccountState()), slow]);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  await connection();
  try {
    return json({
      providers: providerStatuses(),
      model: { name: CLAUDE_MODEL, effort: CLAUDE_EFFORT },
      authEnabled: authEnabled(),
      linkedinAccount: await linkedinAccount(),
    });
  } catch (err) {
    return serverError("GET /api/status", err);
  }
}
