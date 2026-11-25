import { after } from "next/server";
import { normaliseLinkedinUrl } from "@/lib/linkedin-url";
import { recomputeAllWarmPathsFree } from "@/lib/paths/engine";
import { readOwnProfile } from "@/lib/paths/network";
import { getNetworkSource } from "@/lib/repo/network";
import { getSettings } from "@/lib/repo/settings";
import { errorMessage } from "@/lib/research/util";
import { fail, json, serverError } from "../../../_lib/api";

/**
 * POST /api/network/linkedin/self (no body) -> { readAt, roles, schools }: reads your own LinkedIn
 * profile now, from the URL in Settings, for your roles and schools (shared employers and schools
 * with a lead). One profile read on the research account, with the usual Apify fallback when
 * Unipile fails. Counts only: the roles and schools themselves stay on the server.
 * - 400 { code: "no_url" }: Settings has no LinkedIn profile URL.
 * - 409 { code: "busy" }: your profile is being read already.
 * - 429 { code: "too_soon" }: read less than 10 minutes ago, a read failed less than 2 minutes ago,
 *   or the 10 profile reads a day outside research runs are used up (counted whatever URL is set;
 *   warm-path checks take from the same budget). Each read uses the research account's LinkedIn,
 *   and the app may run open.
 * - 502 { code: "failed" }: LinkedIn did not answer, or the URL is wrong.
 * Your paths with every lead are recomputed for free after the reply.
 */

// Unipile answers in seconds; its Apify fallback can take a few minutes.
export const maxDuration = 300;
const READ_GAP_MS = 10 * 60_000;
const RETRY_GAP_MS = 2 * 60_000;

export async function POST() {
  try {
    const [settings, self] = await Promise.all([getSettings(), getNetworkSource("linkedin_self")]);
    const url = normaliseLinkedinUrl(settings.linkedinUrl ?? "");
    if (url && self && self.status !== "running") {
      const readAt = self.data.url === url && typeof self.data.readAt === "string" ? Date.parse(self.data.readAt) : NaN;
      if (Number.isFinite(readAt) && Date.now() - readAt < READ_GAP_MS) {
        return fail(429, "Your profile was read less than 10 minutes ago. Try again later.", { code: "too_soon" });
      }
      if (self.status === "error" && Date.now() - Date.parse(self.updatedAt) < RETRY_GAP_MS) {
        return fail(429, "Reading your profile failed a moment ago. Try again in a few minutes.", { code: "too_soon" });
      }
    }
    const res = await readOwnProfile();
    if (!res.ok) return fail(res.code === "no_url" ? 400 : res.code === "busy" ? 409 : res.code === "too_soon" ? 429 : 502, res.error, { code: res.code });
    try {
      after(async () => {
        await recomputeAllWarmPathsFree();
      });
    } catch (err) {
      console.error(`[api] could not schedule the warm-path recompute: ${errorMessage(err).slice(0, 200)}`);
    }
    return json({ readAt: res.readAt, roles: res.roles, schools: res.schools });
  } catch (err) {
    return serverError("POST /api/network/linkedin/self", err);
  }
}
