import { after, connection, type NextRequest } from "next/server";
import { z } from "zod";
import { normaliseLinkedinUrl } from "@/lib/linkedin-url";
import { recomputeAllWarmPathsFree } from "@/lib/paths/engine";
import { applyNetworkSettingsChange, cleanNetworkSettings } from "@/lib/paths/network";
import { getSettings, saveSettings } from "@/lib/repo/settings";
import { cleanXHandle, errorMessage } from "@/lib/research/util";
import type { Settings } from "@/lib/types";
import { definedOnly, fail, isEmail, isHttpUrl, json, readJson, serverError } from "../_lib/api";

/** Partial<Settings>: send only what changed. saveSettings merges it over what is stored. */
const SettingsBody = z.object({
  senderName: z.string().trim().max(200, "Keep the name under 200 characters.").optional(),
  senderEmail: z
    .string()
    .trim()
    .max(320)
    .refine((v) => v === "" || isEmail(v), "senderEmail must be a valid email address (or empty).")
    .optional(),
  calendlyUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || isHttpUrl(v), "calendlyUrl must be an http(s) link (or empty).")
    .optional(),
  signature: z.string().trim().max(2000, "Keep the signature under 2,000 characters.").optional(),
  criteria: z
    .array(z.string().max(500, "Keep each rule under 500 characters."))
    .max(30, "Keep it to 30 rules or fewer.")
    .optional(),
  followUpDays: z.coerce
    .number({ error: "followUpDays must be a number of days." })
    .int("followUpDays must be a whole number of days.")
    .min(1, "followUpDays must be from 1 to 30.")
    .max(30, "followUpDays must be from 1 to 30.")
    .optional(),
  // Your own public usernames for warm paths, cleaned by cleanNetworkSettings: "" clears each.
  xHandle: z.string({ error: "xHandle must be text." }).trim().max(200, "That is too long for an X handle.").optional(),
  instagramHandle: z.string({ error: "instagramHandle must be text." }).trim().max(200, "That is too long for an Instagram username.").optional(),
  linkedinUrl: z.string({ error: "linkedinUrl must be text." }).trim().max(500, "That URL is too long.").optional(),
});

/** GET /api/settings -> { settings }. */
export async function GET() {
  await connection();
  try {
    return json({ settings: await getSettings() });
  } catch (err) {
    return serverError("GET /api/settings", err);
  }
}

/**
 * PUT /api/settings Partial<Settings> -> { settings } (the full, saved settings).
 * xHandle ("" or [A-Za-z0-9_]{1,15}; "@jane" and x.com links are accepted), instagramHandle ("" or
 * [A-Za-z0-9._]{1,30}, not an Instagram page such as "explore") and linkedinUrl ("" or a
 * linkedin.com/in/ URL) are saved cleaned; 400 { field } when one is not valid. A new X handle
 * drops your stored X lists and every path from them; a new LinkedIn URL drops your stored roles
 * and schools (read again from the new profile). Either way every lead's paths, and the list
 * chips, are redone for free after the reply.
 */
export async function PUT(request: NextRequest) {
  const body = await readJson(request, SettingsBody);
  if (!body.ok) return body.response;
  const { xHandle, instagramHandle, linkedinUrl, ...rest } = definedOnly(body.data);
  const network = cleanNetworkSettings({ xHandle, instagramHandle, linkedinUrl });
  if (!network.ok) return fail(400, network.error, { field: network.field });
  try {
    const before = await getSettings();
    const settings = await saveSettings({ ...(rest as Partial<Settings>), ...network.value });
    // Never throws: the settings are saved either way.
    await applyNetworkSettingsChange(before, settings);
    const xChanged = (cleanXHandle(before.xHandle) ?? "").toLowerCase() !== (cleanXHandle(settings.xHandle) ?? "").toLowerCase();
    const linkedinChanged = (normaliseLinkedinUrl(before.linkedinUrl ?? "") ?? "") !== (normaliseLinkedinUrl(settings.linkedinUrl ?? "") ?? "");
    if (xChanged || linkedinChanged) {
      // The change dropped stored paths and list chips: rebuild them (SQL only) once the reply is out.
      try {
        after(async () => {
          await recomputeAllWarmPathsFree();
        });
      } catch (err) {
        console.error(`[api] could not schedule the warm-path recompute: ${errorMessage(err).slice(0, 200)}`);
      }
    }
    return json({ settings });
  } catch (err) {
    return serverError("PUT /api/settings", err);
  }
}
