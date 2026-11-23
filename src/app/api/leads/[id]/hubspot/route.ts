import type { NextRequest } from "next/server";
import { hubspotStatus, pushLeadToHubSpot, type HubSpotPushResult } from "@/lib/providers/hubspot";
import { addEvent, listEvents } from "@/lib/repo/events";
import { getLead } from "@/lib/repo/leads";
import { getSettings } from "@/lib/repo/settings";
import type { Angle, Lead, LeadEvent } from "@/lib/types";
import { errorText, fail, json, leadIdFrom, leadNotFound, serverError, type LeadRouteContext } from "../../../_lib/api";

// A push is 8 to 14 HubSpot calls; the provider stops itself after 45 s.
export const maxDuration = 60;

/** Pushes in progress on this instance: a double click must not create two of everything. */
const inFlight = new Set<string>();

/** The angle and channel of the most recent "sent" event (events come newest first). */
function lastSent(lead: Lead, events: LeadEvent[]): { angle: Angle | null; channel: "email" | "linkedin" | null; at: string | null } {
  const sent = events.find((e) => e.type === "sent");
  const data = (sent?.data ?? null) as { angleId?: unknown; channel?: unknown } | null;
  const angleId = typeof data?.angleId === "string" ? data.angleId : null;
  const channel = data?.channel === "email" || data?.channel === "linkedin" ? data.channel : null;
  return { angle: angleId ? (lead.angles.find((a) => a.id === angleId) ?? null) : null, channel, at: sent?.createdAt ?? null };
}

function summary(result: HubSpotPushResult): string {
  const reused = (["company", "contact", "deal"] as const).filter(
    (kind) => !result.created.includes(kind) && result[`${kind}Id` as "companyId" | "contactId" | "dealId"],
  );
  const parts = [
    result.created.length ? `created ${result.created.join(", ")}` : "",
    reused.length ? `used existing ${reused.join(", ")}` : "",
  ].filter(Boolean);
  const head = result.ok ? `Pushed to HubSpot${parts.length ? `: ${parts.join("; ")}` : ""}` : `HubSpot push failed: ${result.error}`;
  return result.warnings.length ? `${head}. Notes: ${result.warnings.join(" ")}` : head;
}

/** POST /api/leads/[id]/hubspot -> { ok, contactId?, companyId?, dealId? }; 400 when HubSpot is not configured. */
export async function POST(_request: NextRequest, ctx: LeadRouteContext) {
  const id = await leadIdFrom(ctx);
  if (!id) return leadNotFound();
  if (!hubspotStatus().configured) {
    return fail(400, "HubSpot is not configured. Set HUBSPOT_ACCESS_TOKEN on the server (a HubSpot private app token).");
  }
  if (inFlight.has(id)) return fail(409, "This lead is already being pushed to HubSpot.");

  inFlight.add(id);
  try {
    const [lead, events, settings] = await Promise.all([getLead(id), listEvents(id), getSettings()]);
    if (!lead) return leadNotFound();
    if (!lead.email && !lead.name) {
      return fail(400, "This lead has no name or email yet. Wait for research to finish, or add them, before pushing to HubSpot.");
    }

    const sent = lastSent(lead, events);
    const result = await pushLeadToHubSpot({
      lead,
      sentAngle: sent.angle,
      channel: sent.channel,
      sentAt: sent.at,
      senderEmail: settings.senderEmail || null,
    });

    const ids = { contactId: result.contactId, companyId: result.companyId, dealId: result.dealId };
    await addEvent(id, "hubspot", summary(result), { ...ids, noteId: result.noteId, created: result.created, warnings: result.warnings, ok: result.ok }).catch(
      (err) => console.error(`[api] could not log the hubspot event for lead ${id}: ${errorText(err)}`),
    );

    // HubSpot (upstream) failed: 502, with whatever was already written so nothing is lost.
    if (!result.ok) return fail(502, result.error ?? "HubSpot did not accept the lead.", { ok: false, ...ids });
    return json({ ok: true, ...ids });
  } catch (err) {
    return serverError("POST /api/leads/[id]/hubspot", err);
  } finally {
    inFlight.delete(id);
  }
}
