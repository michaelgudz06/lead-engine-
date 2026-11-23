import "server-only";
import { query } from "../db";
import type { EventType, LeadEvent } from "../types";
import { toEvent } from "./map";

export async function addEvent(leadId: string, type: EventType, message: string, data?: unknown): Promise<void> {
  await query("insert into le_events (lead_id, type, message, data) values ($1, $2, $3, $4::jsonb)", [
    leadId,
    type,
    message.slice(0, 1000),
    JSON.stringify(data ?? null),
  ]);
}

export async function listEvents(leadId: string, limit = 200): Promise<LeadEvent[]> {
  const rows = await query("select * from le_events where lead_id = $1 order by id desc limit $2", [leadId, limit]);
  return rows.map(toEvent);
}
