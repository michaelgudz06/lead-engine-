import { connection, type NextRequest } from "next/server";
import { z } from "zod";
import { getSettings, saveSettings } from "@/lib/repo/settings";
import type { Settings } from "@/lib/types";
import { definedOnly, isEmail, isHttpUrl, json, readJson, serverError } from "../_lib/api";

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

/** PUT /api/settings Partial<Settings> -> { settings } (the full, saved settings). */
export async function PUT(request: NextRequest) {
  const body = await readJson(request, SettingsBody);
  if (!body.ok) return body.response;
  try {
    const settings = await saveSettings(definedOnly(body.data) as Partial<Settings>);
    return json({ settings });
  } catch (err) {
    return serverError("PUT /api/settings", err);
  }
}
