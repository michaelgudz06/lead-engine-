/**
 * Pure helpers for the research pipeline. No I/O and no server-only imports, so
 * scripts/test-research.ts can unit-test them directly.
 */

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === "string" ? err : "Unknown error";
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${Math.round(ms / 1000)}s`);
    this.name = "TimeoutError";
  }
}

/**
 * Rejects when `work` takes longer than `ms`. The underlying work cannot be
 * cancelled here (providers set their own fetch timeouts); this only guarantees
 * that the pipeline moves on.
 */
export function withTimeout<T>(work: Promise<T> | (() => Promise<T>), ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), Math.max(1, ms));
    let p: Promise<T>;
    try {
      p = typeof work === "function" ? work() : work;
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * A wall-clock budget for one run. The API routes run research inside a
 * serverless function capped at 300 s, so every phase asks how much time is left
 * and later phases are skipped rather than letting the platform kill the run
 * before anything is saved.
 */
export class Deadline {
  private readonly endsAt: number;
  constructor(
    totalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.endsAt = this.now() + totalMs;
  }
  remaining(): number {
    return Math.max(0, this.endsAt - this.now());
  }
  /** Time a phase may use: at most `capMs`, and always leaving `reserveMs` for later phases. */
  budget(capMs: number, reserveMs = 0): number {
    return Math.max(0, Math.min(capMs, this.remaining() - reserveMs));
  }
}

export function truncate(text: string | null | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+\n/g, "\n").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function clamp01(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function isoDateMonthsAgo(months: number, from: Date = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, from.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

/** Accepts "2026", "2026-03", "2026-03-14" or a full ISO timestamp; anything else becomes null. */
export function cleanDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  const m = v.match(/^(\d{4})(-(\d{2})(-(\d{2}))?)?/);
  if (!m) return null;
  const year = Number(m[1]);
  if (year < 1950 || year > new Date().getUTCFullYear() + 1) return null;
  if (m[3] && (Number(m[3]) < 1 || Number(m[3]) > 12)) return null;
  if (m[5] && (Number(m[5]) < 1 || Number(m[5]) > 31)) return null;
  return m[0];
}

/** http(s) URLs only. Returns the trimmed URL or null. */
export function cleanUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!/^https?:\/\//i.test(v)) return null;
  try {
    return new URL(v).toString();
  } catch {
    return null;
  }
}

/** Comparison key for URLs: host without www, path without trailing slash, no query or hash. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./i, "").toLowerCase()}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/** Hosts that are never a company's own website. */
const NOT_A_COMPANY_SITE = [
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "github.com",
  "huggingface.co",
  "crunchbase.com",
  "pitchbook.com",
  "wikipedia.org",
  "bloomberg.com",
  "techcrunch.com",
  "medium.com",
  "substack.com",
  "ycombinator.com",
  "glassdoor.com",
  "indeed.com",
  "wellfound.com",
  "zoominfo.com",
  "rocketreach.co",
  "apollo.io",
  "tracxn.com",
  "cbinsights.com",
  "g2.com",
  "bit.ly",
  "linktr.ee",
  "google.com",
  "notion.site",
];

/** "https://www.Acme.ai/about" -> "acme.ai". Null for junk, social networks and aggregators. */
export function domainFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const host = new URL(v).hostname.toLowerCase().replace(/^www\./, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    if (NOT_A_COMPANY_SITE.some((d) => host === d || host.endsWith(`.${d}`))) return null;
    return host;
  } catch {
    return null;
  }
}

/** Lowercase letters and digits only: "Acme Robotics, Inc." -> "acmerobotics". */
export function normaliseName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(inc|llc|ltd|gmbh|corp|co|company|corporation|limited|plc|sas|bv|ab)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** True when a domain plausibly belongs to the company ("figure.ai" for "Figure AI"). */
export function domainMatchesCompany(domain: string, company: string): boolean {
  const core = normaliseName(company);
  const label = domain.split(".").slice(0, -1).join("").replace(/[^a-z0-9]/g, "");
  const whole = domain.replace(/[^a-z0-9]/g, "");
  if (!core || !label) return false;
  if (label === core || whole === core) return true;
  // First word of the company ("physical" for "Physical Intelligence") is too loose on its own,
  // so require one side to contain the other and the shorter to be at least 4 characters.
  const [short, long] = label.length <= core.length ? [label, core] : [core, label];
  return short.length >= 4 && long.includes(short);
}

/**
 * A readable name from a LinkedIn slug, used only when the profile cannot be read.
 * "jane-doe-phd-1a2b3c45" -> "Jane Doe Phd". Returns null when the slug has no
 * usable words (for example "ACoAAB...").
 */
export function nameFromSlug(slug: string | null | undefined): string | null {
  if (!slug) return null;
  const parts = slug
    .split(/[-_.]+/)
    .filter(Boolean)
    // LinkedIn appends a hex or numeric id to make slugs unique.
    .filter((p, i, all) => !(i === all.length - 1 && all.length > 1 && /\d/.test(p)))
    .filter((p) => /^[a-zÀ-ɏ]+$/i.test(p));
  if (!parts.length || parts.join("").length < 3) return null;
  return parts
    .slice(0, 4)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

export function splitName(full: string | null | undefined): { first: string | null; last: string | null } {
  const parts = (full ?? "")
    .replace(/\(.*?\)/g, " ")
    .replace(/,.*$/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts[parts.length - 1] };
}

/**
 * Reads a search-result title for a LinkedIn profile, e.g.
 * "Jane Doe - CTO at Acme Robotics | LinkedIn" -> { name, title, company }.
 */
export function parseLinkedInTitle(raw: string | null | undefined): {
  name: string | null;
  title: string | null;
  company: string | null;
} {
  const empty = { name: null, title: null, company: null };
  if (!raw) return empty;
  const cleaned = raw.replace(/\s*[|·]\s*LinkedIn.*$/i, "").trim();
  if (!cleaned) return empty;
  const [namePart, ...rest] = cleaned.split(/\s+[-–—|]\s+/);
  const name = namePart?.trim() || null;
  const headline = rest.join(" - ").trim();
  if (!headline) return { name, title: null, company: null };
  const at = headline.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
  if (at) return { name, title: at[1].trim() || null, company: at[2].split(/\s+[-–—|]\s+/)[0].trim() || null };
  // "Jane Doe - Acme Robotics" (LinkedIn's short form): the remainder is the company.
  return rest.length === 1 && headline.split(" ").length <= 4
    ? { name, title: null, company: headline }
    : { name, title: headline, company: null };
}

/** "@Jane_Doe", "https://x.com/jane_doe/status/1" -> "jane_doe". */
export function cleanXHandle(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim();
  const m = v.match(/(?:twitter\.com|x\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i);
  if (m) v = m[1];
  v = v.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(v)) return null;
  if (["home", "share", "intent", "search", "i", "hashtag"].includes(v.toLowerCase())) return null;
  return v;
}

/**
 * Wraps untrusted text (web pages, posts, profiles) for a prompt. The closing tag
 * is neutralised inside the payload so the text cannot "close" its own block and
 * continue as instructions.
 */
export function wrapData(tag: string, payload: unknown, maxChars = 24_000): string {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload, null, 1);
  const safe = truncate(raw ?? "", maxChars).replace(new RegExp(`</\\s*${tag}`, "gi"), `<\\/${tag}`);
  return `<${tag}>\n${safe}\n</${tag}>`;
}

/** Collects every http(s) URL that appears anywhere in a JSON-like value. */
export function collectUrls(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") {
    for (const m of value.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) out.add(urlKey(m[0].replace(/[.,;:!?]+$/, "")));
  } else if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out, depth + 1);
  } else if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) collectUrls(v, out, depth + 1);
  }
  return out;
}

/** Cuts a message to `max` characters at a sentence or word boundary. */
export function fitToLimit(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentenceEnd = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  if (sentenceEnd >= max * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 0 ? space : max - 1).replace(/[,;:\s]+$/, "")}…`.slice(0, max);
}

export function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function compact<T>(items: Array<T | null | undefined | false | "">): T[] {
  return items.filter(Boolean) as T[];
}

const STOPWORDS = new Set(
  "a an and are as at be been by for from has have he her his in is it its of on or she that the their they this to was were which who with also about into than then per via according says said".split(" "),
);

/** Content words of a sentence, lowercased, for comparing two facts. */
export function contentTokens(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of (text ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9.]+/)) {
    const t = raw.replace(/^\.+|\.+$/g, "");
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * True when two facts say the same thing in different words: most of the shorter
 * one's content words appear in the longer one (80% by default). Short facts are never
 * matched this way (too few words to tell).
 */
export function sameFact(a: string | null | undefined, b: string | null | undefined, threshold = 0.8): boolean {
  const x = contentTokens(a);
  const y = contentTokens(b);
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size < 5) return false;
  let shared = 0;
  for (const t of small) if (large.has(t)) shared++;
  return shared / small.size >= threshold;
}
