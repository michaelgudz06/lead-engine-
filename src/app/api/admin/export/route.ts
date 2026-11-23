import { NextResponse, type NextRequest } from "next/server";
import { usageCsv } from "@/lib/admin/export";
import { fail, serverError } from "../../_lib/api";
import { adminGuard, noindex, WINDOW_ERROR, windowParam } from "../_lib/guard";

/**
 * GET /api/admin/export?window=today|7d|30d|all (default 30d) -> the ledger rows of the
 * window as a CSV download, oldest first. Owner's computer only (404 elsewhere).
 */
export async function GET(request: NextRequest) {
  const denied = adminGuard(request);
  if (denied) return denied;
  const window = windowParam(request);
  if (!window) return noindex(fail(400, WINDOW_ERROR));
  try {
    const { csv, rows, truncated } = await usageCsv(window);
    const day = new Date().toISOString().slice(0, 10);
    return noindex(
      new NextResponse(csv, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="lead-engine-usage-${window}-${day}.csv"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-row-count": String(rows),
          ...(truncated ? { "x-truncated": "1" } : {}),
        },
      }),
    );
  } catch (err) {
    return serverError("GET /api/admin/export", err);
  }
}
