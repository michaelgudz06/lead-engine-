import "server-only";
import { db, json, query } from "../db";
import { linkedinSlug } from "../linkedin-url";
import type { ConnectionRow } from "../paths/csv";
import { companyKeyPrefixes } from "../paths/overlap";
import { CONNECTIONS_MAX_PARTS, CONNECTIONS_ROWS_PER_PART } from "../paths/types";
import { nameTokens, normaliseName } from "../research/util";

/**
 * The owner's side of the graph (migration 007): le_network_contacts (LinkedIn connections from a
 * Connections.csv upload, the owner's X follows and followers) and le_network_sources (one row per
 * source: its state, counts and small data such as the owner's own roles and schools).
 *
 * Nothing here returns a contact list to a route: callers match contacts against one lead at a
 * time, and the routes only ever see counts (src/lib/paths/network.ts). No email address is ever
 * stored, and contact names never go to logs or error messages.
 */

export const NETWORK_SOURCE_KEYS = ["linkedin_csv", "linkedin_self", "linkedin_account", "x_self", "x_following", "x_followers"] as const;
export type NetworkSourceKey = (typeof NETWORK_SOURCE_KEYS)[number];

export interface NetworkSourceRow {
  key: NetworkSourceKey;
  status: "ok" | "running" | "error";
  detail: string | null;
  itemCount: number | null;
  cursor: string | null;
  data: Record<string, unknown>;
  syncedAt: string | null;
  updatedAt: string;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string).toISOString());
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function toSource(r: Record<string, unknown>): NetworkSourceRow {
  return {
    key: r.key as NetworkSourceKey,
    status: r.status === "running" || r.status === "error" ? r.status : "ok",
    detail: r.detail == null ? null : String(r.detail),
    itemCount: r.item_count == null ? null : Number(r.item_count),
    cursor: r.cursor == null ? null : String(r.cursor),
    data: isObj(r.data) ? r.data : {},
    syncedAt: iso(r.synced_at),
    updatedAt: iso(r.updated_at) ?? new Date(0).toISOString(),
  };
}

/** Every source row there is, by key. */
export async function getNetworkSources(): Promise<Partial<Record<NetworkSourceKey, NetworkSourceRow>>> {
  const rows = await query("select * from le_network_sources");
  const out: Partial<Record<NetworkSourceKey, NetworkSourceRow>> = {};
  for (const r of rows) {
    const s = toSource(r);
    if ((NETWORK_SOURCE_KEYS as readonly string[]).includes(s.key)) out[s.key] = s;
  }
  return out;
}

export async function getNetworkSource(key: NetworkSourceKey): Promise<NetworkSourceRow | null> {
  const rows = await query("select * from le_network_sources where key = $1", [key]);
  return rows[0] ? toSource(rows[0]) : null;
}

export interface NetworkSourcePatch {
  status?: "ok" | "running" | "error";
  detail?: string | null;
  itemCount?: number | null;
  cursor?: string | null;
  /** Merged over the stored data (keys set to null stay as null). With replaceData, replaces it. */
  data?: Record<string, unknown>;
  replaceData?: boolean;
  /** "now" stamps synced_at: the network changed (paths computed before it are recomputed for free). */
  syncedAt?: "now" | null;
}

/** Creates or updates one source row with the fields given. */
export async function saveNetworkSource(key: NetworkSourceKey, patch: NetworkSourcePatch): Promise<NetworkSourceRow> {
  const cols: string[] = ["key"];
  const vals: string[] = ["$1"];
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [key];
  const add = (col: string, value: unknown, cast = "") => {
    params.push(value);
    cols.push(col);
    vals.push(`$${params.length}${cast}`);
    return `$${params.length}${cast}`;
  };
  if (patch.status !== undefined) sets.push(`status = ${add("status", patch.status)}`);
  if (patch.detail !== undefined) sets.push(`detail = ${add("detail", patch.detail)}`);
  if (patch.itemCount !== undefined) sets.push(`item_count = ${add("item_count", patch.itemCount, "::int")}`);
  if (patch.cursor !== undefined) sets.push(`cursor = ${add("cursor", patch.cursor)}`);
  if (patch.data !== undefined) {
    const ref = add("data", json(patch.data), "::jsonb");
    sets.push(patch.replaceData ? `data = ${ref}` : `data = le_network_sources.data || ${ref}`);
  }
  if (patch.syncedAt !== undefined) {
    cols.push("synced_at");
    vals.push(patch.syncedAt === "now" ? "now()" : "null");
    sets.push(`synced_at = ${patch.syncedAt === "now" ? "now()" : "null"}`);
  }
  const rows = await query(
    `insert into le_network_sources (${cols.join(", ")}) values (${vals.join(", ")})
     on conflict (key) do update set ${sets.join(", ")}
     returning *`,
    params,
  );
  return toSource(rows[0]);
}

/**
 * Marks a source "running" unless another server instance is already running it (a run older
 * than staleMs counts as lost). True when this caller got it; it must end with saveNetworkSource
 * (status ok or error).
 */
export async function claimNetworkSource(key: NetworkSourceKey, staleMs: number): Promise<boolean> {
  const rows = await query(
    `insert into le_network_sources (key, status, updated_at) values ($1, 'running', now())
     on conflict (key) do update set status = 'running', updated_at = now()
      where le_network_sources.status <> 'running' or le_network_sources.updated_at < now() - make_interval(secs => $2::double precision)
     returning key`,
    [key, staleMs / 1000],
  );
  return rows.length > 0;
}

export async function deleteNetworkSources(keys: NetworkSourceKey[]): Promise<void> {
  await query("delete from le_network_sources where key = any($1::text[])", [keys]);
}

/** When the owner's network last changed (an upload finished, a list or the profile was read, something was removed). */
export async function networkChangedAt(): Promise<string | null> {
  const rows = await query<{ at: string | null }>(
    "select max(synced_at) as at from le_network_sources where key in ('linkedin_csv', 'linkedin_self', 'x_following', 'x_followers')",
  );
  return iso(rows[0]?.at);
}

// ------------------------------------------------------------------ LinkedIn connections

/** One stored connection, for matching against a lead. Never sent to a client as a list. */
export interface ConnectionContact {
  slug: string;
  name: string | null;
  company: string | null;
  companyKey: string | null;
  position: string | null;
  profileUrl: string | null;
  /** YYYY-MM-DD. */
  connectedOn: string | null;
}

function toContact(r: Record<string, unknown>): ConnectionContact {
  const day = r.connected_on == null ? null : new Date(r.connected_on as string);
  return {
    slug: String(r.external_id),
    name: r.name == null ? null : String(r.name),
    company: r.company == null ? null : String(r.company),
    companyKey: r.company_key == null ? null : String(r.company_key),
    position: r.position == null ? null : String(r.position),
    profileUrl: r.profile_url == null ? null : String(r.profile_url),
    connectedOn: day && Number.isFinite(day.getTime()) ? day.toISOString().slice(0, 10) : null,
  };
}

const CONTACT_COLUMNS = "external_id, name, company, company_key, position, profile_url, connected_on";

/** Your connections among these slugs (and member ids). */
export async function connectionsBySlugs(slugs: ReadonlyArray<string | null | undefined>): Promise<ConnectionContact[]> {
  const keys = [...new Set(slugs.filter((s): s is string => typeof s === "string" && s.length > 0))];
  if (!keys.length) return [];
  const rows = await query(
    `select ${CONTACT_COLUMNS} from le_network_contacts where network = 'linkedin' and relation = 'connection' and external_id = any($1::text[])`,
    [keys],
  );
  return rows.map(toContact);
}

/**
 * Your connections whose company may be one of these company names: the same key
 * (normaliseName), the name's first whole words ("Acme" for "Acme Robotics"), or a longer name
 * that starts with it ("Acme Robotics Labs"). Never part of a word. The caller confirms each with
 * sameCompanyWords (company_key keeps no word breaks, so "acme%" also finds "AcmeCorp", which it
 * refuses). At most `limit` rows.
 */
export async function connectionsAtCompanies(names: ReadonlyArray<string>, limit = 500): Promise<ConnectionContact[]> {
  const exact = new Set<string>();
  const patterns = new Set<string>();
  for (const name of names) {
    const key = normaliseName(name);
    if (!key) continue;
    exact.add(key);
    for (const prefix of companyKeyPrefixes(name)) exact.add(prefix);
    if (key.length >= 4) patterns.add(`${key}%`);
  }
  if (!exact.size) return [];
  const rows = await query(
    `select ${CONTACT_COLUMNS} from le_network_contacts
      where network = 'linkedin' and relation = 'connection' and company_key is not null
        and (company_key = any($1::text[]) or company_key like any($2::text[]))
      order by connected_on desc nulls last, id
      limit $3`,
    [[...exact], [...patterns], limit],
  );
  return rows.map(toContact);
}

/**
 * Your connections named like these X accounts: each pair is a first and a last name as nameTokens
 * reads them, matched as whole words of the stored name_key (so "José García" is found by "jose"
 * and "garcia"), at most 5 per name, the most recently connected first. tieXToLinkedin then decides.
 */
export async function connectionsByNamePairs(pairs: ReadonlyArray<{ first: string; last: string }>): Promise<ConnectionContact[]> {
  // nameTokens words are [a-z0-9] only, so nothing in them is a LIKE wildcard; checked again here.
  const ok = (w: string) => /^[a-z0-9]{2,40}$/.test(w);
  const seen = new Set<string>();
  const clean = pairs.filter((p) => ok(p.first) && ok(p.last) && !seen.has(`${p.first} ${p.last}`) && seen.add(`${p.first} ${p.last}`)).slice(0, 40);
  if (!clean.length) return [];
  const rows = await query(
    `select distinct on (x.external_id) x.* from unnest($1::text[], $2::text[]) as w(first, last)
     cross join lateral (
       select ${CONTACT_COLUMNS} from le_network_contacts
        where network = 'linkedin' and relation = 'connection' and name_key is not null
          and (' ' || name_key || ' ') like ('% ' || w.first || ' %')
          and (' ' || name_key || ' ') like ('% ' || w.last || ' %')
        order by connected_on desc nulls last, external_id
        limit 5
     ) x
     order by x.external_id`,
    [clean.map((p) => p.first), clean.map((p) => p.last)],
  );
  return rows.map(toContact);
}

export async function connectionCount(): Promise<number> {
  const rows = await query<{ n: number }>("select count(*)::int as n from le_network_contacts where network = 'linkedin' and relation = 'connection'");
  return Number(rows[0]?.n ?? 0);
}

/** A connection from the upload, checked on the server: a slug with linkedinSlug's rules, short trimmed text, a real date. */
export function validateConnectionTuples(rows: unknown): { ok: true; rows: ConnectionRow[] } | { ok: false; error: string } {
  if (!Array.isArray(rows)) return { ok: false, error: "rows must be a list." };
  if (rows.length > CONNECTIONS_ROWS_PER_PART) return { ok: false, error: `Send at most ${CONNECTIONS_ROWS_PER_PART.toLocaleString("en-US")} rows a part.` };
  const out: ConnectionRow[] = [];
  const text = (v: unknown, max: number): string | null => {
    if (v === null || v === undefined) return "";
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    if (t.length > max) return null;
    // Email addresses never belong here (the browser drops that column).
    return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(t) ? "" : t;
  };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const where = `Row ${i + 1}`;
    if (!Array.isArray(r) || r.length < 1 || r.length > 6) return { ok: false, error: `${where}: expected [slug, firstName, lastName, company, position, connectedOn].` };
    const slug = typeof r[0] === "string" ? r[0].trim() : "";
    if (!slug || slug.length > 200 || linkedinSlug(`https://www.linkedin.com/in/${encodeURIComponent(slug)}`) !== slug) {
      return { ok: false, error: `${where}: not a LinkedIn profile slug.` };
    }
    const first = text(r[1], 100);
    const last = text(r[2], 100);
    const company = text(r[3], 200);
    const position = text(r[4], 300);
    if (first === null || last === null || company === null || position === null) return { ok: false, error: `${where}: a field is not text or is too long.` };
    const on = r[5];
    let connectedOn: string | null = null;
    if (on !== null && on !== undefined && on !== "") {
      if (typeof on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(on) || !Number.isFinite(Date.parse(`${on}T00:00:00Z`))) {
        return { ok: false, error: `${where}: connectedOn must be a date (YYYY-MM-DD) or null.` };
      }
      connectedOn = on;
    }
    out.push({ slug, firstName: first, lastName: last, company, position, connectedOn });
  }
  return { ok: true, rows: out };
}

export interface ConnectionsPart {
  /** A UUID the browser makes per upload. */
  importId: string;
  part: number;
  parts: number;
  rows: ConnectionRow[];
  /** When the export was made (the file's date), YYYY-MM-DD or ISO; null when unknown. */
  exportedAt?: string | null;
}

export type ConnectionsPartResult =
  | { ok: true; received: number; total: number; done: boolean }
  | { ok: false; code: "bad_part" | "replaced"; error: string };

/** Advisory lock for an upload's waiting rows and its last step (RUN_LOCK_KEY is 74_221_001, the quota kinds 74_221_002 to 008). */
const CONNECTIONS_LOCK_KEY = 74_221_009;
/** SQL: this upload ($1) is the one in progress. */
const UPLOAD_IN_PROGRESS = "select 1 from le_network_sources where key = 'linkedin_csv' and data -> 'pending' ->> 'importId' = $1";

/** The stored total when this upload already finished (a part sent again after the last one went through), else null. */
async function finishedUploadTotal(importId: string): Promise<number | null> {
  const finished = await query<{ n: number | null }>(
    "select item_count as n from le_network_sources where key = 'linkedin_csv' and data ->> 'importId' = $1 and jsonb_typeof(data -> 'pending') is distinct from 'object'",
    [importId],
  );
  return finished[0] ? Number(finished[0].n ?? 0) : null;
}

/**
 * Stores one part of a Connections.csv upload. The rows wait as connection_pending under the
 * upload's importId, where nothing matches them; when every part 1..parts has arrived, they replace
 * the stored connections in one transaction, the source row gets the count and the dates, and the
 * network counts as changed. A part 1 of a newer upload drops the waiting rows of the upload it
 * replaces, and an upload holds at most parts x 5,000 rows however often a part is sent again. A
 * part for an upload that a newer one replaced is refused (parts after the first only belong to the
 * upload in progress); the last part sent again after it went through (its reply was lost) answers
 * as done. received: rows in this part; total: rows waiting for this upload so far, or stored.
 */
export async function storeConnectionsPart(input: ConnectionsPart): Promise<ConnectionsPartResult> {
  const { importId, part, parts } = input;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(importId)) return { ok: false, code: "bad_part", error: "importId must be a UUID." };
  if (!Number.isInteger(parts) || parts < 1 || parts > CONNECTIONS_MAX_PARTS) return { ok: false, code: "bad_part", error: `parts must be 1 to ${CONNECTIONS_MAX_PARTS}.` };
  if (!Number.isInteger(part) || part < 1 || part > parts) return { ok: false, code: "bad_part", error: `part must be 1 to ${parts}.` };
  const exportedAt = input.exportedAt && Number.isFinite(Date.parse(input.exportedAt)) ? new Date(input.exportedAt).toISOString() : null;

  // Within one part a slug appears once (the browser dedupes; this keeps the last).
  const bySlug = new Map<string, ConnectionRow>();
  for (const r of input.rows) bySlug.set(r.slug, r);
  const rows = [...bySlug.values()];
  // At most parts x 5,000 rows wait per upload, however often a part is sent again (a client retry
  // of the same part still fits: its own rows are not counted twice).
  if (rows.length) {
    const staged = await query<{ n: number }>(
      "select count(*)::int as n from le_network_contacts where network = 'linkedin' and relation = 'connection_pending' and import_id = $1 and not (external_id = any($2::text[]))",
      [importId, rows.map((r) => r.slug)],
    );
    if (Number(staged[0]?.n ?? 0) + rows.length > parts * CONNECTIONS_ROWS_PER_PART) {
      return { ok: false, code: "bad_part", error: `An upload of ${parts} ${parts === 1 ? "part" : "parts"} holds at most ${(parts * CONNECTIONS_ROWS_PER_PART).toLocaleString("en-US")} connections.` };
    }
  }

  // Register the part first: parts after the first only belong to the upload in progress.
  const pending = await query<{ pending: { importId?: string; parts?: number; received?: number[] } | null }>(
    `insert into le_network_sources (key, status, data, updated_at)
       values ('linkedin_csv', 'running', jsonb_build_object('pending', jsonb_build_object('importId', $1::text, 'parts', $2::int, 'received', jsonb_build_array($3::int), 'exportedAt', $4::text)), now())
     on conflict (key) do update set
       status = 'running',
       data = case
         when le_network_sources.data -> 'pending' ->> 'importId' = $1::text
           then jsonb_set(le_network_sources.data, '{pending,received}',
                  (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(le_network_sources.data -> 'pending' -> 'received', '[]'::jsonb) || to_jsonb($3::int)) as x))
         else le_network_sources.data || jsonb_build_object('pending', jsonb_build_object('importId', $1::text, 'parts', $2::int, 'received', jsonb_build_array($3::int), 'exportedAt', $4::text))
       end,
       updated_at = now()
      where le_network_sources.data -> 'pending' ->> 'importId' = $1::text or $3::int = 1
     returning data -> 'pending' as pending`,
    [importId, parts, part, exportedAt],
  );
  if (!pending[0]) {
    // The last part sent again after it went through (its reply was lost): that upload is stored.
    const total = await finishedUploadTotal(importId);
    if (total !== null) return { ok: true, received: rows.length, total, done: true };
    return { ok: false, code: "replaced", error: "A newer upload replaced this one. Choose the file again." };
  }

  // One step behind a lock, and only while this upload is the one in progress: an upload this one
  // replaced loses its waiting rows, and this part's rows wait only if the upload stays within its
  // cap (parts sent at the same time would otherwise each count the rows from before the others).
  const col = <T>(f: (r: ConnectionRow) => T) => rows.map(f);
  const sql = db();
  const [, , stagedRows] = await sql.transaction([
    sql.query(`select pg_advisory_xact_lock(${CONNECTIONS_LOCK_KEY})`),
    sql.query(
      `delete from le_network_contacts where network = 'linkedin' and relation = 'connection_pending' and import_id is distinct from $1
         and exists (select 1 from le_network_sources where key = 'linkedin_csv' and data -> 'pending' ->> 'importId' = $1)`,
      [importId],
    ),
    sql.query(
      `with cur as (
         select exists (select 1 from le_network_sources where key = 'linkedin_csv' and data -> 'pending' ->> 'importId' = $8) as ok
       ), have as (
         select count(*)::int as n from le_network_contacts
          where network = 'linkedin' and relation = 'connection_pending' and import_id = $8 and not (external_id = any($1::text[]))
       ), ins as (
         insert into le_network_contacts (network, relation, external_id, name, name_key, company, company_key, position, profile_url, connected_on, import_id, seen_at)
         select 'linkedin', 'connection_pending', t.slug, nullif(t.name, ''), nullif(t.nkey, ''), nullif(t.company, ''), nullif(t.ckey, ''), nullif(t.position, ''), t.url, t.connected::date, $8, now()
           from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $10::text[]) as t(slug, name, company, ckey, position, url, connected, nkey), cur, have
          where cur.ok and have.n + cardinality($1::text[]) <= $9
         on conflict (network, relation, external_id) do update set
           name = excluded.name, name_key = excluded.name_key, company = excluded.company, company_key = excluded.company_key, position = excluded.position,
           profile_url = excluded.profile_url, connected_on = excluded.connected_on, import_id = excluded.import_id, seen_at = now()
         returning 1
       )
       select (select ok from cur) as current, (select n from have) as have, (select count(*) from ins)::int as stored`,
      [
        col((r) => r.slug),
        col((r) => [r.firstName, r.lastName].filter(Boolean).join(" ")),
        col((r) => r.company),
        col((r) => normaliseName(r.company)),
        col((r) => r.position),
        col((r) => `https://www.linkedin.com/in/${encodeURIComponent(r.slug)}`),
        col((r) => r.connectedOn),
        importId,
        parts * CONNECTIONS_ROWS_PER_PART,
        col((r) => nameTokens([r.firstName, r.lastName].filter(Boolean).join(" ")).join(" ")),
      ],
    ),
  ]);
  const staged = (stagedRows as Array<{ current: boolean; have: number }>)[0];
  if (!staged?.current) {
    // Finished meanwhile by the same part sent twice at once, or replaced by a newer upload.
    const total = await finishedUploadTotal(importId);
    if (total !== null) return { ok: true, received: rows.length, total, done: true };
    return { ok: false, code: "replaced", error: "A newer upload replaced this one. Choose the file again." };
  }
  if (Number(staged.have) + rows.length > parts * CONNECTIONS_ROWS_PER_PART) {
    return { ok: false, code: "bad_part", error: `An upload of ${parts} ${parts === 1 ? "part" : "parts"} holds at most ${(parts * CONNECTIONS_ROWS_PER_PART).toLocaleString("en-US")} connections.` };
  }

  const state = pending[0].pending ?? {};
  const received = new Set((state.received ?? []).map(Number));
  const done = Array.from({ length: parts }, (_, i) => i + 1).every((p) => received.has(p));
  if (done) {
    // The upload replaces the stored connections at once (matching never sees half of each), in one
    // transaction behind the upload lock and only while this upload is still the one in progress: a
    // last part sent again, or twice at once, finds it finished and changes nothing. Done in separate
    // steps, a retry after a lost reply deleted the stored upload and kept only its own part's rows.
    const [, , , saved] = await sql.transaction([
      sql.query(`select pg_advisory_xact_lock(${CONNECTIONS_LOCK_KEY})`),
      sql.query(`delete from le_network_contacts where network = 'linkedin' and relation = 'connection' and exists (${UPLOAD_IN_PROGRESS})`, [importId]),
      sql.query(
        `update le_network_contacts set relation = 'connection'
          where network = 'linkedin' and relation = 'connection_pending' and import_id = $1 and exists (${UPLOAD_IN_PROGRESS})`,
        [importId],
      ),
      sql.query(
        `update le_network_sources set
            status = 'ok', detail = null,
            item_count = (select count(*)::int from le_network_contacts where network = 'linkedin' and relation = 'connection'),
            data = jsonb_build_object('importId', $1::text, 'exportedAt', $2::text, 'uploadedAt', $3::text, 'pending', null),
            synced_at = now(), updated_at = now()
          where key = 'linkedin_csv' and data -> 'pending' ->> 'importId' = $1
          returning item_count`,
        [importId, exportedAt, new Date().toISOString()],
      ),
    ]);
    const row = (saved as Array<{ item_count: number | null }>)[0];
    if (row) return { ok: true, received: rows.length, total: Number(row.item_count ?? 0), done: true };
    const total = await finishedUploadTotal(importId);
    if (total !== null) return { ok: true, received: rows.length, total, done: true };
    return { ok: false, code: "replaced", error: "A newer upload replaced this one. Choose the file again." };
  }
  const counted = await query<{ n: number }>(
    "select count(*)::int as n from le_network_contacts where network = 'linkedin' and relation = 'connection_pending' and import_id = $1",
    [importId],
  );
  return { ok: true, received: rows.length, total: Number(counted[0]?.n ?? 0), done: false };
}

/** Deletes every stored connection (and the rows of an upload in progress) and the upload's record. Returns how many rows went. */
export async function deleteConnections(): Promise<number> {
  // Behind the upload lock, in one transaction: an upload finishing at the same moment cannot put
  // rows back after the record says none are stored.
  const sql = db();
  const [, deleted] = await sql.transaction([
    sql.query(`select pg_advisory_xact_lock(${CONNECTIONS_LOCK_KEY})`),
    sql.query("delete from le_network_contacts where network = 'linkedin' and relation in ('connection', 'connection_pending') returning id"),
    sql.query(
      `insert into le_network_sources (key, status, detail, item_count, data, synced_at, updated_at)
         values ('linkedin_csv', 'ok', null, 0, '{}'::jsonb, now(), now())
       on conflict (key) do update set status = 'ok', detail = null, item_count = 0, data = '{}'::jsonb, synced_at = now(), updated_at = now()`,
    ),
  ]);
  return (deleted as unknown[]).length;
}

/**
 * The "Connected" chip on every lead whose LinkedIn slug is in your connections, in one statement
 * (after an upload). A lead whose summary is already a direct path keeps it; a two-hop or empty
 * one becomes "Connected" (a direct tie ranks first). A lead never checked (no warm-paths row)
 * whose chip came from an earlier upload and who is no longer in your connections loses it. Leads
 * with a row are corrected by their free recompute. updated_at is left alone, so the Leads list
 * keeps its order. Returns how many of your leads are in your connections (Settings says so after
 * an upload), whether or not their chip changed.
 */
export async function markConnectedLeads(): Promise<number> {
  await query(
    `update le_leads l set warm_path = null
      where l.warm_path is not null
        and not exists (select 1 from le_warm_paths w where w.lead_id = l.id)
        and not exists (select 1 from le_network_contacts c where c.network = 'linkedin' and c.relation = 'connection' and c.external_id = l.linkedin_slug)`,
  );
  await query(
    `update le_leads l
        set warm_path = jsonb_build_object(
              'strength', 'medium', 'hops', 1, 'via', null, 'network', 'linkedin', 'connected', true,
              'label', case when c.connected_on is not null then 'LinkedIn 1st degree since ' || to_char(c.connected_on, 'YYYY') else 'LinkedIn 1st degree' end,
              'checkedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       from le_network_contacts c
      where c.network = 'linkedin' and c.relation = 'connection' and c.external_id = l.linkedin_slug
        and (l.warm_path is null or coalesce(l.warm_path ->> 'hops', '2') <> '1')`,
  );
  const n = await query<{ n: number }>(
    `select count(*)::int as n from le_leads l
      where l.linkedin_slug is not null
        and exists (select 1 from le_network_contacts c where c.network = 'linkedin' and c.relation = 'connection' and c.external_id = l.linkedin_slug)`,
  );
  return Number(n[0]?.n ?? 0);
}

// ------------------------------------------------------------------ the owner's X lists

/** One account in your X lists. Followers come as ids only (no handle or name). */
export interface XListEntry {
  id: string;
  handle?: string | null;
  name?: string | null;
  followers?: number | null;
}

export interface XContact {
  id: string;
  /** following: you follow them; follower: they follow you. */
  relation: "following" | "follower";
  handle: string | null;
  name: string | null;
  followers: number | null;
}

/**
 * Replaces one of your X lists with `entries` (one sync): upserts under importId in chunks, then
 * deletes the rows of that list that this sync did not see. Returns the list's size.
 */
export async function replaceXList(relation: "following" | "follower", entries: ReadonlyArray<XListEntry>, importId: string): Promise<number> {
  const unique = new Map<string, XListEntry>();
  for (const e of entries) if (/^\d{1,30}$/.test(e.id)) unique.set(e.id, e);
  const all = [...unique.values()];
  for (let i = 0; i < all.length; i += 5000) {
    const chunk = all.slice(i, i + 5000);
    await query(
      `insert into le_network_contacts (network, relation, external_id, handle, name, followers_count, import_id, seen_at)
       select 'x', $1, t.id, t.handle, t.name, t.followers, $6, now()
         from unnest($2::text[], $3::text[], $4::text[], $5::int[]) as t(id, handle, name, followers)
       on conflict (network, relation, external_id) do update set
         handle = coalesce(excluded.handle, le_network_contacts.handle), name = coalesce(excluded.name, le_network_contacts.name),
         followers_count = coalesce(excluded.followers_count, le_network_contacts.followers_count), import_id = excluded.import_id, seen_at = now()`,
      [
        relation,
        chunk.map((e) => e.id),
        chunk.map((e) => e.handle ?? null),
        chunk.map((e) => (e.name ? e.name.slice(0, 200) : null)),
        chunk.map((e) => (typeof e.followers === "number" && Number.isFinite(e.followers) ? Math.min(2_147_483_647, Math.max(0, Math.round(e.followers))) : null)),
        importId,
      ],
    );
  }
  await query("delete from le_network_contacts where network = 'x' and relation = $1 and import_id is distinct from $2", [relation, importId]);
  return all.length;
}

/** Your X contacts among these ids (both lists). */
export async function xContactsByIds(ids: ReadonlyArray<string>): Promise<XContact[]> {
  const clean = [...new Set(ids.filter((id) => /^\d{1,30}$/.test(id)))];
  if (!clean.length) return [];
  const rows = await query(
    `select external_id, relation, handle, name, followers_count from le_network_contacts
      where network = 'x' and relation in ('following', 'follower') and external_id = any($1::text[])`,
    [clean],
  );
  return rows.map((r) => ({
    id: String(r.external_id),
    relation: r.relation === "follower" ? "follower" : "following",
    handle: r.handle == null ? null : String(r.handle),
    name: r.name == null ? null : String(r.name),
    followers: r.followers_count == null ? null : Number(r.followers_count),
  }));
}

export async function xListCounts(): Promise<{ following: number; followers: number }> {
  const rows = await query<{ following: number; followers: number }>(
    `select count(*) filter (where relation = 'following')::int as following, count(*) filter (where relation = 'follower')::int as followers
       from le_network_contacts where network = 'x'`,
  );
  return { following: Number(rows[0]?.following ?? 0), followers: Number(rows[0]?.followers ?? 0) };
}

/** Forgets your X lists (your handle changed, or X follows were turned off). */
export async function clearOwnXData(): Promise<void> {
  await query("delete from le_network_contacts where network = 'x'");
  await deleteNetworkSources(["x_self", "x_following", "x_followers"]);
  // The lists changed: stamp the change so paths computed before it are recomputed.
  await saveNetworkSource("x_following", { status: "ok", itemCount: 0, data: {}, replaceData: true, syncedAt: "now" });
}
