import "server-only";
import type { Angle, Lead, ProviderStatus } from "../types";

/**
 * HubSpot (V1). Needs HUBSPOT_ACCESS_TOKEN from a HubSpot private app with
 * CRM write scopes for contacts, companies and deals. Not tested against a live
 * account yet. CONTRACT: signatures fixed; owned by the api agent.
 */
export async function pushToHubSpot(input: {
  lead: Lead;
  sentAngle?: Angle | null;
  senderEmail?: string | null;
}): Promise<{ ok: boolean; contactId?: string; companyId?: string; dealId?: string; error?: string }> {
  void input;
  throw new Error("not implemented");
}

export function hubspotStatus(): ProviderStatus {
  throw new Error("not implemented");
}
