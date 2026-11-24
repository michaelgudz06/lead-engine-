import { connection, type NextRequest } from "next/server";
import { authEnabled } from "@/lib/auth";
import { HUBSPOT_LIST_MAX, HubSpotError, hubspotStatus, listHubSpotContacts } from "@/lib/providers/hubspot";
import { fail, json, serverError } from "../../_lib/api";

/**
 * GET /api/import/hubspot?limit=500 -> { headers, rows, total, more, linkedinProperties, warnings }.
 *
 * Lists HubSpot contacts for the import screen (src/lib/providers/hubspot.ts, listHubSpotContacts):
 * HubSpot ID, first and last name, email, company, job title and LinkedIn URL, 100 a page, at
 * most `limit` (1 to 2,000, default 500). Nothing is saved here; the import screen sends the rows
 * to POST /api/leads/import with source "hubspot". Without HUBSPOT_ACCESS_TOKEN: 400 with how to
 * connect HubSpot.
 *
 * Refused (403 needs_password) on a Vercel deploy without the team password: an open deploy would
 * hand anyone with the link the first 2,000 contacts of the CRM, and a loop of listings would use
 * up HubSpot's API limit so pushes fail. Local runs with the gate off still list.
 */

// Up to 20 pages of contacts; the HubSpot client stops itself after 45 s.
export const maxDuration = 60;

const NEEDS_PASSWORD =
  "HubSpot contacts can't be listed while Lead Engine is open to anyone with the link, because the list holds your CRM contacts. Set APP_PASSWORD and SESSION_SECRET in Vercel, redeploy and log in, then import from HubSpot.";

const NOT_CONNECTED =
  "HubSpot is not connected. In HubSpot, create a private app with the crm.objects.contacts.read scope (add crm.schemas.contacts.read to find LinkedIn URLs in custom properties), then add its access token as HUBSPOT_ACCESS_TOKEN in Vercel (Project Settings, Environment Variables) and redeploy.";

export async function GET(request: NextRequest) {
  await connection(); // live data: never prerender
  const raw = request.nextUrl.searchParams.get("limit");
  if (raw !== null && !/^\d{1,6}$/.test(raw.trim())) return fail(400, `limit must be a whole number from 1 to ${HUBSPOT_LIST_MAX.toLocaleString("en-US")}.`);
  const limit = raw === null ? 500 : Math.max(1, Math.min(HUBSPOT_LIST_MAX, Number(raw.trim())));
  // The same open-deploy test as src/proxy.ts. Before the token check, so an open deploy never
  // suggests adding a token.
  if (process.env.VERCEL === "1" && !authEnabled()) return fail(403, NEEDS_PASSWORD, { code: "needs_password" });
  if (!hubspotStatus().configured) return fail(400, NOT_CONNECTED, { code: "not_connected" });
  try {
    return json(await listHubSpotContacts({ limit }));
  } catch (err) {
    if (err instanceof HubSpotError) {
      // A rejected token or a missing scope is for the owner to fix; anything else is HubSpot's side.
      if (err.status === 401 || err.status === 403) return fail(400, err.message, { code: "hubspot_access" });
      return fail(502, err.message, { code: "upstream" });
    }
    return serverError("GET /api/import/hubspot", err);
  }
}
