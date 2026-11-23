import type { NextRequest } from "next/server";
import { z } from "zod";
import { addEvent } from "@/lib/repo/events";
import { json, leadIdFrom, leadNotFound, pgCode, readJson, serverError, type LeadRouteContext } from "../../../_lib/api";

/** Only the events a person creates from the page; the rest come from the server itself. */
const EventBody = z.object({
  type: z.enum(["copied", "note"], { error: 'type must be "copied" or "note".' }),
  message: z.string({ error: "message is required." }).trim().min(1, "message is required.").max(1000, "Keep it under 1,000 characters."),
});

/** POST /api/leads/[id]/events { type, message } -> { ok: true }. */
export async function POST(request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  const body = await readJson(request, EventBody);
  if (!body.ok) return body.response;
  try {
    await addEvent(id, body.data.type, body.data.message);
    return json({ ok: true });
  } catch (err) {
    // The foreign key on le_events answers "does this lead exist" without a second query.
    if (pgCode(err) === "23503") return leadNotFound();
    return serverError("POST /api/leads/[id]/events", err);
  }
}
