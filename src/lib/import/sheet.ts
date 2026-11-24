import "server-only";

/**
 * Reads a Google Sheet shared as "anyone with the link" as CSV, for POST /api/import/sheet.
 *
 * Only links of the form https://docs.google.com/spreadsheets/d/<id>/... are accepted (also
 * with /u/<n>/ for a second Google account, and without the scheme). The download URL is built
 * here from the id and the tab's gid, never taken from the request, and redirects are followed
 * only to Google's own download hosts (docs.google.com and *.googleusercontent.com), so the
 * server cannot be pointed anywhere else. A redirect to Google's sign-in page, a 401 or 403, or
 * an HTML page instead of CSV means the sheet is not shared.
 */

export type SheetErrorCode = "bad_link" | "not_shared" | "not_found" | "too_large" | "timeout" | "upstream";

export class SheetError extends Error {
  constructor(
    message: string,
    readonly code: SheetErrorCode,
    /** The HTTP status the route answers with. */
    readonly status: number,
  ) {
    super(message);
    this.name = "SheetError";
  }
}

export const SHEET_TIMEOUT_MS = 15_000;
export const SHEET_MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export const SHEET_MESSAGES = {
  badLink: "Paste the link of a Google Sheet (https://docs.google.com/spreadsheets/d/...). Or download it as a CSV and upload the file.",
  notShared:
    "This sheet isn't shared. In Google Sheets choose Share, then Anyone with the link, Viewer. Or download it as a CSV and upload the file.",
  notFound: "That sheet was not found. Check the link, or download it as a CSV and upload the file.",
  tooLarge: "This sheet is larger than 5 MB. Download it as a CSV and upload the file.",
  timeout: "Google took too long to send the sheet. Try again, or download it as a CSV and upload the file.",
  redirected: "Google sent the download to an unexpected address, so it was stopped. Download the sheet as a CSV and upload the file.",
} as const;

/** The sheet id and the tab (gid) from a sharing link, or null when it is not a Google Sheets link. */
export function parseSheetLink(input: string): { id: string; gid: string | null } | null {
  const raw = String(input ?? "").trim();
  if (!raw || raw.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() !== "docs.google.com" || url.port || url.username || url.password) return null;
  // /spreadsheets/d/<id>/edit, also /spreadsheets/u/1/d/<id>/... ("Publish to web" links, /d/e/2PACX-..., are not supported).
  const m = /^\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,100})(?:\/|$)/.exec(url.pathname);
  if (!m) return null;
  const fromHash = /(?:^|[#&])gid=(\d{1,20})(?:&|$)/.exec(url.hash);
  const fromQuery = url.searchParams.get("gid");
  const gid = fromHash?.[1] ?? (fromQuery && /^\d{1,20}$/.test(fromQuery) ? fromQuery : null);
  return { id: m[1], gid };
}

/** The CSV export of one tab: https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid> (the first tab without a gid). */
export function sheetExportUrl(id: string, gid: string | null): string {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/export`);
  url.searchParams.set("format", "csv");
  if (gid) url.searchParams.set("gid", gid);
  return url.toString();
}

/** A host the download may be redirected to: Google Docs itself and its download servers. */
export function isAllowedSheetHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.port && (host === "docs.google.com" || host.endsWith(".googleusercontent.com"));
}

/** Google's sign-in pages: where a private sheet sends a visitor who is not signed in. */
function isGoogleSignIn(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "accounts.google.com" || ((host === "google.com" || host === "www.google.com") && /^\/(accounts|ServiceLogin|signin)/i.test(url.pathname));
}

/** Downloads the sheet's CSV text. Throws SheetError with a message for the person importing. */
export async function downloadSheetCsv(link: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<string> {
  const sheet = parseSheetLink(link);
  if (!sheet) throw new SheetError(SHEET_MESSAGES.badLink, "bad_link", 400);
  const maxBytes = opts.maxBytes ?? SHEET_MAX_BYTES;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? SHEET_TIMEOUT_MS);
  let url = new URL(sheetExportUrl(sheet.id, sheet.gid));
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(url, {
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: { accept: "text/csv, text/plain;q=0.9, */*;q=0.1" },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get("location");
        if (!location || hop >= MAX_REDIRECTS) throw new SheetError(SHEET_MESSAGES.redirected, "upstream", 502);
        const next = new URL(location, url);
        if (isGoogleSignIn(next)) throw new SheetError(SHEET_MESSAGES.notShared, "not_shared", 400);
        if (!isAllowedSheetHost(next)) throw new SheetError(SHEET_MESSAGES.redirected, "upstream", 502);
        url = next;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new SheetError(SHEET_MESSAGES.notShared, "not_shared", 400);
      }
      if (res.status === 404 || res.status === 410) {
        await res.body?.cancel().catch(() => undefined);
        throw new SheetError(SHEET_MESSAGES.notFound, "not_found", 400);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new SheetError(`Google could not send the sheet (HTTP ${res.status}). Try again, or download it as a CSV and upload the file.`, "upstream", 502);
      }
      // A sign-in or error page served directly instead of the file.
      if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
        await res.body?.cancel().catch(() => undefined);
        throw new SheetError(SHEET_MESSAGES.notShared, "not_shared", 400);
      }
      return await readCapped(res, maxBytes);
    }
  } catch (err) {
    if (err instanceof SheetError) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new SheetError(SHEET_MESSAGES.timeout, "timeout", 504);
    }
    throw new SheetError(`Could not reach Google to read the sheet (${err instanceof Error ? err.message : String(err)}).`, "upstream", 502);
  }
}

/** The body as UTF-8 text, stopping as soon as it passes maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new SheetError(SHEET_MESSAGES.tooLarge, "too_large", 400);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SheetError(SHEET_MESSAGES.tooLarge, "too_large", 400);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}
