import "server-only";
import { query } from "../db";
import type { Finding, NewFinding, Source } from "../types";
import { toFinding } from "./map";

const clamp = (n: number | undefined, d: number) => Math.max(0, Math.min(1, n ?? d));

/** Inserts findings for a lead and returns them with their new ids. */
export async function insertFindings(leadId: string, items: NewFinding[]): Promise<Finding[]> {
  const clean = items.filter((f) => f.text && f.text.trim().length > 0);
  if (!clean.length) return [];
  const cols = 10;
  const values: string[] = [];
  const params: unknown[] = [];
  clean.forEach((f, i) => {
    const b = i * cols;
    values.push(
      `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${clean.length * cols + 1})`,
    );
    params.push(
      f.source,
      f.kind,
      f.title?.slice(0, 300) ?? null,
      f.text.trim().slice(0, 4000),
      f.url ?? null,
      f.publishedAt ?? null,
      clamp(f.confidence, 0.7),
      clamp(f.relevance, 0.5),
      f.passesCriteria ?? true,
      f.excludedReason ?? null,
    );
  });
  params.push(leadId);
  const rows = await query(
    `insert into le_findings
       (source, kind, title, text, url, published_at, confidence, relevance, passes_criteria, excluded_reason, lead_id)
     values ${values.join(", ")}
     returning *`,
    params,
  );
  return rows.map(toFinding);
}

export async function listFindings(leadId: string): Promise<Finding[]> {
  const rows = await query(
    "select * from le_findings where lead_id = $1 order by relevance desc, created_at asc",
    [leadId],
  );
  return rows.map(toFinding);
}

/** Removes a lead's findings, optionally only those from some sources. */
export async function clearFindings(leadId: string, sources?: Source[]): Promise<void> {
  if (sources?.length) {
    await query("delete from le_findings where lead_id = $1 and source = any($2::text[])", [leadId, sources]);
  } else {
    await query("delete from le_findings where lead_id = $1", [leadId]);
  }
}

export async function updateFindingCriteria(
  id: string,
  passesCriteria: boolean,
  excludedReason: string | null,
): Promise<void> {
  await query("update le_findings set passes_criteria = $2, excluded_reason = $3 where id = $1", [
    id,
    passesCriteria,
    excludedReason,
  ]);
}

/** Stores a raw provider response for debugging. Never pass secrets in request. */
export async function saveRaw(leadId: string, provider: string, request: unknown, response: unknown): Promise<void> {
  await query("insert into le_raw (lead_id, provider, request, response) values ($1, $2, $3::jsonb, $4::jsonb)", [
    leadId,
    provider,
    JSON.stringify(request ?? null),
    JSON.stringify(response ?? null).slice(0, 900_000),
  ]);
}
