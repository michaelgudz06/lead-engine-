import { connection } from "next/server";
import { authEnabled } from "@/lib/auth";
import { CLAUDE_EFFORT, CLAUDE_MODEL } from "@/lib/env";
import { providerStatuses } from "@/lib/providers";
import { json, serverError } from "../_lib/api";

/**
 * GET /api/status -> { providers, model: { name, effort }, authEnabled }.
 * Reads env only (no network). connection() keeps it out of the build-time
 * prerender, so the answer always reflects the running server's env.
 */
export async function GET() {
  await connection();
  try {
    return json({
      providers: providerStatuses(),
      model: { name: CLAUDE_MODEL, effort: CLAUDE_EFFORT },
      authEnabled: authEnabled(),
    });
  } catch (err) {
    return serverError("GET /api/status", err);
  }
}
