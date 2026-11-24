import { NextResponse, type NextRequest } from "next/server";
import { usageCsv } from "@/lib/usage/export";
import { fail, serverError } from "../../_lib/api";
import { windowParam } from "../_lib/params";

/**
 * GET /api/usage/export?window=today|7d|30d|all (default 30d) -> every ledger row of the
 * window as a CSV download, oldest first. Cells a spreadsheet would run as a formula are
 * written as text (src/lib/usage/export.ts).
 */
export async function GET(request: NextRequest) {
  const window = windowParam(request);
  if (!window.ok) return fail(400, window.error);
  try {
    const { csv, rows, truncated } = await usageCsv(window.value);
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="lead-engine-usage-${window.value}-${day}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-row-count": String(rows),
        ...(truncated ? { "x-truncated": "1" } : {}),
      },
    });
  } catch (err) {
    return serverError("GET /api/usage/export", err);
  }
}
