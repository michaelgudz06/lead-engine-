import "server-only";
import { query } from "../db";
import { LEAD_NAME_SQL, windowStart } from "./queries";
import { USAGE_PROVIDER_LABELS, type UsageProvider, type UsageWindow } from "./types";

/**
 * Ledger rows as CSV for GET /api/usage/export: every row in the window, oldest first, read in
 * pages by id. Cells that a spreadsheet would run as a formula are neutralised: lead and
 * company names come from LinkedIn and from imported files, so they are untrusted text. A
 * UTF-8 byte order mark makes Excel read accents.
 */

export const CSV_COLUMNS = [
  "created_at_utc",
  "provider",
  "provider_label",
  "operation",
  "lead_id",
  "lead_name",
  "company",
  "units",
  "cost_usd",
  "cost_basis",
  "ok",
  "ms",
  "id",
] as const;

/** Far above a small team's ledger; a guard so one request cannot read without end. */
export const MAX_EXPORT_ROWS = 200_000;
const PAGE = 5_000;

interface Row {
  id: string;
  created_at: string | Date;
  provider: string;
  operation: string;
  lead_id: string | null;
  lead_name: string | null;
  company: string | null;
  units: unknown;
  cost_usd: string | null;
  cost_basis: string;
  ok: boolean;
  ms: number | null;
}

/**
 * One CSV cell: quoted when it holds a comma, quote or line break; a leading = + - @ (or tab,
 * CR) gets a ' in front so spreadsheet apps show it as text instead of running it.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Units as "inputTokens=443; outputTokens=10": readable in a sheet, easy to split. */
export function unitsCell(units: unknown): string {
  if (!units || typeof units !== "object" || Array.isArray(units)) return "";
  return Object.entries(units as Record<string, unknown>)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function line(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

function iso(v: string | Date): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

export async function usageCsv(window: UsageWindow): Promise<{ csv: string; rows: number; truncated: boolean }> {
  const from = windowStart(window);
  const lines: string[] = [line([...CSV_COLUMNS])];
  let after = 0;
  let rows = 0;
  let truncated = false;
  for (;;) {
    const page = await query<Row>(
      `select u.id, u.created_at, u.provider, u.operation, u.lead_id, ${LEAD_NAME_SQL} as lead_name,
              l.company_name as company, u.units, u.cost_usd, u.cost_basis, u.ok, u.ms
         from le_usage u
         left join le_leads l on l.id = u.lead_id
        where ($1::timestamptz is null or u.created_at >= $1::timestamptz)
          and u.id > $2
        order by u.id asc
        limit $3`,
      [from ? from.toISOString() : null, after, PAGE],
    );
    for (const r of page) {
      if (rows >= MAX_EXPORT_ROWS) {
        truncated = true;
        break;
      }
      lines.push(
        line([
          iso(r.created_at),
          r.provider,
          USAGE_PROVIDER_LABELS[r.provider as UsageProvider] ?? r.provider,
          r.operation,
          r.lead_id,
          r.lead_name,
          r.company,
          unitsCell(r.units),
          r.cost_usd,
          r.cost_basis,
          r.ok ? "true" : "false",
          r.ms,
          r.id,
        ]),
      );
      rows++;
    }
    if (truncated || page.length < PAGE) break;
    after = Number(page[page.length - 1].id);
  }
  return { csv: `\uFEFF${lines.join("\r\n")}\r\n`, rows, truncated };
}
