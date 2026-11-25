/**
 * LinkedIn's Connections.csv export, read in the browser. Pure and client-safe: no server-only
 * imports, so email addresses never leave the browser (the Email Address column is never read
 * into a row, and any field that looks like an address is blanked).
 *
 * The file, as LinkedIn writes it (Download your data > Connections):
 *   Notes:
 *   "When exporting your connection data, you may notice that some of the email addresses are ..."
 *   <blank line>
 *   First Name,Last Name,URL,Email Address,Company,Position,Connected On
 *   Ada,Kim,https://www.linkedin.com/in/ada-kim,,Acme Robotics,Head of Robotics,25 Nov 2024
 *
 * Read leniently: a byte order mark, CRLF, quoted commas and quotes (parseCsv), blank Company or
 * Position, any number of "Notes:" lines. Headers may be in another language, so the header is
 * found as the row followed by rows holding linkedin.com/in URLs, the URL column by its content,
 * and the other columns by their names in a few languages, else by their place around the URL
 * column (LinkedIn's order) with the date and email columns told apart by their content.
 */

import { parseCsv, type CsvDelimiter } from "../import/csv";
import { linkedinSlug } from "../linkedin-url";
import { CONNECTIONS_MAX_PARTS, CONNECTIONS_ROWS_PER_PART } from "./types";

/** One connection as PUT /api/network/linkedin/connections takes it. connectedOn is YYYY-MM-DD or null. */
export type ConnectionTuple = [slug: string, firstName: string, lastName: string, company: string, position: string, connectedOn: string | null];

export interface ConnectionRow {
  /** The profile slug, as linkedinSlug() makes it. */
  slug: string;
  firstName: string;
  lastName: string;
  company: string;
  position: string;
  /** "Connected On" as YYYY-MM-DD, or null when it is missing or unreadable. */
  connectedOn: string | null;
}

export interface ParsedConnections {
  rows: ConnectionRow[];
  /** Data rows after the header (blank lines not counted). */
  total: number;
  /** Rows left out: no LinkedIn profile URL, the same profile twice, or past the 30,000 cap. */
  skipped: { noUrl: number; duplicate: number; overLimit: number };
  /** How the columns were found. */
  columnsBy: "names" | "positions";
  /** 1-based record number of the header row, 0 when none was found. */
  headerRow: number;
  /** Why the file cannot be used, in a short sentence; null when it can. */
  error: string | null;
}

/** The most connections one upload keeps (LinkedIn's own cap is 30,000). */
export const CONNECTIONS_MAX = CONNECTIONS_ROWS_PER_PART * CONNECTIONS_MAX_PARTS;

const FIELD_MAX = { name: 100, company: 200, position: 300 } as const;
const PROFILE_URL = /linkedin\.com\/in\/[^/?#\s]+/i;
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

type Field = "firstName" | "lastName" | "url" | "email" | "company" | "position" | "connectedOn";

/** Header names per field, normalised (lower case, accents and punctuation gone), in several languages. */
const HEADER_NAMES: Record<Field, string[]> = {
  firstName: ["first name", "firstname", "given name", "prenom", "vorname", "nombre", "nome", "voornaam", "imie", "fornavn", "fornamn", "etunimi", "ad"],
  lastName: ["last name", "lastname", "surname", "family name", "nom", "nom de famille", "nachname", "apellidos", "apellido", "cognome", "sobrenome", "achternaam", "nazwisko", "efternavn", "efternamn", "sukunimi", "soyad"],
  url: ["url", "profile url", "linkedin url", "profile", "profil url", "url du profil"],
  email: ["email address", "email", "e mail", "e mail address", "adresse e mail", "adresse email", "e mail adresse", "direccion de correo electronico", "correo electronico", "indirizzo email", "indirizzo e mail", "endereco de e mail", "e mailadres", "adres e mail"],
  company: ["company", "entreprise", "societe", "unternehmen", "firma", "empresa", "azienda", "bedrijf", "organisation", "organization", "selskab", "foretag", "yritys", "sirket"],
  position: ["position", "poste", "titre", "cargo", "posizione", "ruolo", "functie", "stanowisko", "stilling", "befattning", "tehtava", "pozisyon", "job title", "title"],
  connectedOn: ["connected on", "date de connexion", "connecte le", "verbunden am", "vernetzt am", "fecha de conexion", "conectado el", "data di collegamento", "collegato il", "conectado em", "data da conexao", "verbonden op", "verbonden sinds", "data polaczenia", "forbundet den", "ansluten", "yhteys luotu", "baglanti tarihi"],
};

function normHeader(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Every known header name, to tell the header row from a connection without a profile URL. */
const KNOWN_HEADER = new Set(Object.values(HEADER_NAMES).flat());
const blank = (r: readonly string[]) => r.every((c) => c.trim() === "");
const hasProfileUrl = (r: readonly string[]) => r.some((c) => PROFILE_URL.test(c));

// ------------------------------------------------------------------ dates

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: Array<[number, string[]]> = [
  [1, ["jan", "janv", "januar", "janeiro", "ene", "enero", "gen", "gennaio", "januari", "sty", "tammi"]],
  [2, ["feb", "fev", "fevr", "februar", "fevereiro", "febrero", "febbraio", "februari", "lut", "helmi"]],
  [3, ["mar", "mars", "marz", "maerz", "marco", "marzo", "maart", "maalis"]],
  [4, ["apr", "avr", "avril", "april", "abr", "abril", "aprile", "kwi", "huhti"]],
  [5, ["may", "mai", "maio", "mayo", "mag", "maggio", "mei", "maj", "touko"]],
  [6, ["jun", "juin", "juni", "junho", "junio", "giu", "giugno", "cze", "kesa"]],
  [7, ["jul", "juil", "juillet", "juli", "julho", "julio", "lug", "luglio", "lip", "heina"]],
  [8, ["aug", "aout", "august", "ago", "agosto", "augustus", "sie", "elo"]],
  [9, ["sep", "sept", "september", "set", "setembro", "septiembre", "settembre", "wrz", "syys"]],
  [10, ["oct", "okt", "octobre", "oktober", "out", "outubro", "octubre", "ott", "ottobre", "paz", "loka"]],
  [11, ["nov", "novembre", "november", "novembro", "noviembre", "lis", "marras"]],
  [12, ["dec", "dez", "dic", "decembre", "dezember", "dezembro", "diciembre", "dicembre", "december", "gru", "joulu"]],
];
for (const [n, names] of MONTH_NAMES) for (const name of names) MONTHS[name] = n;

function monthNumber(word: string): number | null {
  const w = word
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
  if (!w) return null;
  return MONTHS[w] ?? MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)] ?? null;
}

function isoDate(year: number, month: number, day: number): string | null {
  const y = year < 100 ? 2000 + year : year;
  if (y < 2003 || y > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(y, month - 1, day));
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * "Connected On" as YYYY-MM-DD: "25 Nov 2024" (LinkedIn's English export), "25 nov. 2024",
 * "Nov 25, 2024", "2024-11-25", "25.11.2024", "25/11/2024" or "11/25/2024". For numbers alone
 * the day comes first unless `monthFirst` (a file whose dates show the month first). Null
 * otherwise.
 */
export function parseConnectedOn(value: string | null | undefined, opts: { monthFirst?: boolean } = {}): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:$|[T\s])/.exec(v);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[.\s-]*\s*([A-Za-zÀ-ÿ]{3,}\.?)[\s.-]*(\d{2,4})$/.exec(v);
  if (m) {
    const month = monthNumber(m[2]);
    return month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
  }
  m = /^([A-Za-zÀ-ÿ]{3,}\.?)\s+(\d{1,2}),?\s+(\d{2,4})$/.exec(v);
  if (m) {
    const month = monthNumber(m[1]);
    return month ? isoDate(Number(m[3]), month, Number(m[2])) : null;
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(v);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = Number(m[3]);
    if (a > 12) return isoDate(year, b, a);
    if (b > 12) return isoDate(year, a, b);
    return opts.monthFirst ? isoDate(year, a, b) : isoDate(year, b, a);
  }
  return null;
}

/** True when a file's numeric dates put the month first (some value has a day above 12 in second place). */
function monthFirstIn(values: string[]): boolean {
  let monthFirst = false;
  for (const v of values) {
    const m = /^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}$/.exec(v.trim());
    if (!m) continue;
    if (Number(m[1]) > 12) return false;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  return monthFirst;
}

// ------------------------------------------------------------------ columns

/** Most of the non-empty values of column `col` pass `test` (and there is at least one). */
function columnShare(rows: string[][], col: number, test: (v: string) => boolean): number {
  let seen = 0;
  let hit = 0;
  for (const r of rows) {
    const v = (r[col] ?? "").trim();
    if (!v) continue;
    seen++;
    if (test(v)) hit++;
  }
  return seen ? hit / seen : 0;
}

function findColumns(header: string[], sample: string[][]): { columns: Partial<Record<Field, number>>; by: "names" | "positions" } | null {
  const width = Math.max(header.length, ...sample.map((r) => r.length));
  // The URL column: where the rows hold profile URLs.
  let url = -1;
  let best = 0;
  for (let c = 0; c < width; c++) {
    const share = columnShare(sample, c, (v) => PROFILE_URL.test(v));
    if (share > best) {
      best = share;
      url = c;
    }
  }
  if (url < 0) return null;

  const byName: Partial<Record<Field, number>> = { url };
  const names = header.map(normHeader);
  for (const field of Object.keys(HEADER_NAMES) as Field[]) {
    if (field === "url") continue;
    const i = names.findIndex((n, idx) => idx !== url && HEADER_NAMES[field].includes(n));
    if (i >= 0 && !Object.values(byName).includes(i)) byName[field] = i;
  }
  const named = ["firstName", "lastName", "company", "position", "connectedOn"].every((f) => byName[f as Field] !== undefined);
  if (named) return { columns: byName, by: "names" };

  // By position, LinkedIn's order around the URL column, with the date and email columns found by content.
  const cols: Partial<Record<Field, number>> = { url };
  const others = Array.from({ length: width }, (_, i) => i).filter((i) => i !== url);
  const dateShare = (c: number) => columnShare(sample, c, (v) => parseConnectedOn(v) !== null);
  const emailShare = (c: number) => columnShare(sample, c, (v) => EMAIL_LIKE.test(v));
  const date = others.filter((c) => c > url && dateShare(c) >= 0.6).pop();
  if (date !== undefined) cols.connectedOn = date;
  const email = byName.email ?? others.find((c) => c !== date && emailShare(c) >= 0.5);
  if (email !== undefined) cols.email = email;
  const before = others.filter((c) => c < url);
  if (before.length >= 2) {
    cols.firstName = before[before.length - 2];
    cols.lastName = before[before.length - 1];
  } else if (before.length === 1) {
    cols.firstName = before[0];
  }
  // After the URL: the email column (when the file has one), then Company and Position, then the date.
  const end = date ?? width;
  let after = others.filter((c) => c > url && c < end && c !== email);
  if (email === undefined && after.length >= 3) after = after.slice(1); // an Email Address column that is empty in every row
  if (after[0] !== undefined) cols.company = after[0];
  if (after[1] !== undefined) cols.position = after[1];
  return { columns: cols, by: "positions" };
}

// ------------------------------------------------------------------ the parser

function clean(value: string | undefined, max: number): string {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  if (!v || EMAIL_LIKE.test(v)) return "";
  return v.length > max ? v.slice(0, max).trim() : v;
}

/** Reads Connections.csv text. Never throws: a file it cannot use comes back with `error`. */
export function parseConnectionsCsv(text: string): ParsedConnections {
  const empty = (error: string): ParsedConnections => ({ rows: [], total: 0, skipped: { noUrl: 0, duplicate: 0, overLimit: 0 }, columnsBy: "names", headerRow: 0, error });
  if (typeof text !== "string" || !text.trim()) return empty("The file is empty.");
  for (const delimiter of [",", ";", "\t"] as CsvDelimiter[]) {
    const records = parseCsv(text, { delimiter });
    const firstUrl = records.findIndex(hasProfileUrl);
    if (firstUrl < 0) continue;
    // The header: the nearest row above the first profile URL that names two known columns, else the
    // nearest row above it that is not blank. Rows in between are connections without a profile URL.
    let h = firstUrl - 1;
    while (h >= 0 && blank(records[h])) h--;
    for (let k = h; k >= 0; k--) {
      if (records[k].filter((c) => KNOWN_HEADER.has(normHeader(c))).length >= 2) {
        h = k;
        break;
      }
    }
    if (h < 0 || hasProfileUrl(records[h]) || records[h].filter((c) => c.trim()).length < 2) continue;
    const header = records[h].map((c) => c.trim());
    const data = records.slice(h + 1).filter((r) => !blank(r));
    const found = findColumns(header, data.slice(0, 200));
    if (!found) continue;
    const { columns } = found;
    const dates = columns.connectedOn === undefined ? [] : data.slice(0, 500).map((r) => r[columns.connectedOn!] ?? "");
    const monthFirst = monthFirstIn(dates);
    const rows: ConnectionRow[] = [];
    const seen = new Set<string>();
    const skipped = { noUrl: 0, duplicate: 0, overLimit: 0 };
    for (const r of data) {
      const slug = linkedinSlug(r[columns.url!] ?? "");
      if (!slug) {
        skipped.noUrl++;
        continue;
      }
      if (seen.has(slug)) {
        skipped.duplicate++;
        continue;
      }
      if (rows.length >= CONNECTIONS_MAX) {
        skipped.overLimit++;
        continue;
      }
      seen.add(slug);
      const at = (f: Field) => (columns[f] === undefined ? "" : r[columns[f]!]);
      rows.push({
        slug,
        firstName: clean(at("firstName"), FIELD_MAX.name),
        lastName: clean(at("lastName"), FIELD_MAX.name),
        company: clean(at("company"), FIELD_MAX.company),
        position: clean(at("position"), FIELD_MAX.position),
        connectedOn: columns.connectedOn === undefined ? null : parseConnectedOn(r[columns.connectedOn], { monthFirst }),
      });
    }
    return {
      rows,
      total: data.length,
      skipped,
      columnsBy: found.by,
      headerRow: h + 1,
      error: rows.length ? null : "No connection in the file has a LinkedIn profile URL.",
    };
  }
  return empty("This does not look like LinkedIn's Connections.csv: no row has a linkedin.com/in/ profile URL.");
}

/** Rows as the upload's tuples: [slug, firstName, lastName, company, position, connectedOn]. */
export function connectionTuples(rows: ReadonlyArray<ConnectionRow>): ConnectionTuple[] {
  return rows.map((r) => [r.slug, r.firstName, r.lastName, r.company, r.position, r.connectedOn]);
}

/** Splits rows into upload parts of at most `size` (5,000), at most 6 parts. */
export function splitIntoParts<T>(items: ReadonlyArray<T>, size: number = CONNECTIONS_ROWS_PER_PART): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length && parts.length < CONNECTIONS_MAX_PARTS; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
