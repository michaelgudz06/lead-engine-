import { connection } from "next/server";
import { getNetworkStatus } from "@/lib/paths/network";
import { json, serverError } from "../_lib/api";

/**
 * GET /api/network -> NetworkStatus (src/lib/paths/types.ts): Settings > Your network.
 * Counts and states only: how many connections are stored and from when, whether your own
 * profile was read (with how many roles and schools), your LinkedIn account's state, your X lists'
 * sizes and today's budgets. No route ever returns your contact lists or a contact's name. Makes at
 * most one Unipile accounts call (cached 10 minutes; it never touches LinkedIn).
 */
export async function GET() {
  await connection();
  try {
    return json(await getNetworkStatus());
  } catch (err) {
    return serverError("GET /api/network", err);
  }
}
