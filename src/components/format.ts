/** Small, pure display helpers shared by the pages. Client-safe. */
import type { Lead } from "@/lib/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parse(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  const t = parse(iso);
  if (t === null) return "";
  const diff = now - t;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return formatDate(iso);
}

function dayLabel(d: Date): string {
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/**
 * "Nov 23, 2026" (the year is dropped for dates in the current year). Date-only values,
 * as findings carry them ("2026", "2026-03", "2026-03-14"), are calendar dates: never
 * shifted by the time zone, and never shown more precisely than they are ("Mar 2026").
 */
export function formatDate(iso: string | null | undefined): string {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso?.trim() ?? "");
  if (m) {
    const [, y, mo, d] = m;
    if (!mo) return y;
    const date = new Date(Number(y), Number(mo) - 1, d ? Number(d) : 1);
    // "2026-13" or "2026-02-30" roll over into another month: not a real date.
    if (date.getMonth() !== Number(mo) - 1) return "";
    return d ? dayLabel(date) : date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
  }
  const t = parse(iso);
  return t === null ? "" : dayLabel(new Date(t));
}

export function formatDateTime(iso: string | null | undefined): string {
  const t = parse(iso);
  if (t === null) return "";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "1:42" style elapsed time for the research panel. */
export function elapsed(sinceIso: string | null | undefined, now: number): string {
  const t = parse(sinceIso);
  if (t === null) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** ISO timestamp -> value for <input type="date"> in local time. */
export function toDateInput(iso: string | null | undefined): string {
  const t = parse(iso);
  if (t === null) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** <input type="date"> value -> ISO at 9:00 local, so "due" flips in the morning. */
export function fromDateInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Same window as claimResearch: a run still 'running' after this was lost (function killed or server restarted). */
const STALE_RUN_MS = 15 * MINUTE;

/** True while a research run is live. A lost run is not, and the server accepts a new run for it. */
export function isRunning(lead: Pick<Lead, "researchStatus" | "researchStartedAt">, now: number = Date.now()): boolean {
  if (lead.researchStatus !== "running") return false;
  const started = parse(lead.researchStartedAt);
  return !(started !== null && now - started > STALE_RUN_MS);
}

/** Shows a lost run as the failed run it is, the way the server records it once it notices. */
export function settleLostRun(lead: Lead): Lead {
  return lead.researchStatus === "running" && !isRunning(lead) ? { ...lead, researchStatus: "error" } : lead;
}

/** The best name we have: the person's name, else the LinkedIn slug, else a placeholder. */
export function leadName(lead: Pick<Lead, "name" | "linkedinSlug">): string {
  return lead.name?.trim() || lead.linkedinSlug?.trim() || "Unnamed lead";
}

/** "Head of Robotics at Acme", or whichever half is known. */
export function titleAtCompany(lead: Pick<Lead, "title" | "companyName">): string {
  const title = lead.title?.trim();
  const company = lead.companyName?.trim();
  if (title && company) return `${title} at ${company}`;
  return title || company || "";
}

/** Only http(s) links are rendered as links: finding URLs come from the open web. */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function hostOf(url: string | null | undefined): string {
  const safe = safeUrl(url);
  if (!safe) return "";
  return new URL(safe).hostname.replace(/^www\./, "");
}

/** "claude-haiku-5-5" -> "Claude Haiku 5.5". Unknown shapes are shown as they are. */
export function modelLabel(name: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(name.trim().toLowerCase());
  if (!m) return name || "Claude";
  const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
  return `Claude ${family} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Accepts a LinkedIn profile URL (with or without scheme) and returns it normalised, or null. */
export function normalizeLinkedinUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
    const m = /^\/in\/([^/?#]+)/.exec(u.pathname);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1]}/`;
  } catch {
    return null;
  }
}
