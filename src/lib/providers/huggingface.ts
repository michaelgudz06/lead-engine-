import "server-only";
import { optionalEnv, type EnvKey } from "../env";
import { HttpError } from "../http";
import type { ProviderStatus } from "../types";

/**
 * Hugging Face Hub (public API, no key): find a company's or person's account,
 * list their models and datasets, and flag fine-tunes of models Abstract serves.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 *
 * Endpoints (response shapes checked live, Nov 2026):
 * - GET /api/quicksearch?q=&type=org&type=user&limit=(max 20)
 *     -> { orgs: [{ name, fullname }], users: [{ user, fullname }], ... }
 *   It matches the start of handles and display names, so a legal suffix ("Black Forest Labs, Inc.")
 *   finds nothing: queries are cleaned first, with one shorter retry ("1X Technologies" -> "1X").
 * - GET /api/models?author=&sort=lastModified&direction=-1&expand[]=...
 *   Base models come from three places, merged: expand[]=baseModels
 *   ({ relation: "finetune" | "adapter" | "quantized" | "merge", models: [{ id }] }), the
 *   "base_model:<relation>:<id>" tags, and the raw cardData.base_model (string or list).
 * - GET /api/datasets?author=&sort=lastModified&direction=-1&expand[]=...
 * Anonymous calls are rate-limited per IP (the `ratelimit-policy` header says 500 per 5 minutes),
 * and serverless hosts share egress IPs. An optional HF_TOKEN (any free account's read token)
 * gives a per-account limit instead. After a 429 the provider pauses until the window resets and
 * hubStatus reports it as off, so a research run skips Hugging Face cleanly instead of recording
 * "no account found".
 */

export interface HubAccount {
  id: string;
  type: "org" | "user";
  url: string;
  fullName: string | null;
}

export interface HubModel {
  id: string;
  url: string;
  lastModified: string | null;
  downloads: number | null;
  likes: number | null;
  baseModels: string[];
  /** Set when a base model is one Abstract serves (see SERVED_BASE_MODELS). */
  servedBase: string | null;
  tags: string[];
}

export interface HubDataset {
  id: string;
  url: string;
  lastModified: string | null;
  tags: string[];
}

/** Base checkpoints whose fine-tunes Abstract can deploy (docs.abstract.inc/robots/deployments). */
export const SERVED_BASE_MODELS: string[] = [
  "allenai/MolmoAct2-BimanualYAM",
  "lerobot/pi05_base",
  "vernerobotics/v0.5-base",
  "runwayml/praxis-1-yam",
  "microsoft/rho-yam-box",
  "black-forest-labs/flux-3-action-droid",
  "PerceptronAI/Isaac-0.5",
];

/** Accounts whose handle or display name matches the text: orgs first, then users. Throws on HTTP errors. */
export async function searchHubAccounts(queryText: string): Promise<HubAccount[]> {
  const q = hubQuery(queryText);
  if (!q) return [];
  const found = await quicksearch(q);
  if (found.length) return found;
  // "1X Technologies" finds nothing, "1X" finds the 1x-technologies org: retry once without
  // trailing descriptor words. Callers still match names strictly, so the wider net is safe.
  const shorter = withoutDescriptors(q);
  return shorter && shorter !== q ? quicksearch(shorter) : [];
}

/**
 * Public models of one account. Reads up to 100 of the most recently updated, then returns
 * fine-tunes of served bases first (the strongest outreach signal), then the rest, newest
 * first, up to `limit`. Throws on HTTP errors and on an invalid account id.
 */
export async function getHubModels(author: string, limit?: number): Promise<HubModel[]> {
  const id = accountId(author);
  const max = clampInt(limit, 1, LIST_FETCH, DEFAULT_LIMIT);
  const params = listParams(id, ["lastModified", "downloads", "likes", "tags", "baseModels", "cardData"]);
  const rows = await hubGet("/api/models", params);
  if (!Array.isArray(rows)) throw new Error("Hugging Face returned an unexpected model list");
  const parsed = rows.map(parseModelRow).filter((m): m is ParsedModel => m !== null);
  resolveServedBases(parsed);
  const models = parsed.map((p) => p.model);
  return [...models.filter((m) => m.servedBase), ...models.filter((m) => !m.servedBase)].slice(0, max);
}

/**
 * Public datasets of one account: robotics and LeRobot datasets first, then the rest, newest
 * first, up to `limit`. Throws on HTTP errors and on an invalid account id.
 */
export async function getHubDatasets(author: string, limit?: number): Promise<HubDataset[]> {
  const id = accountId(author);
  const max = clampInt(limit, 1, LIST_FETCH, DEFAULT_LIMIT);
  const rows = await hubGet("/api/datasets", listParams(id, ["lastModified", "tags"]));
  if (!Array.isArray(rows)) throw new Error("Hugging Face returned an unexpected dataset list");
  const datasets: HubDataset[] = [];
  for (const row of rows) {
    if (!isRec(row)) continue;
    const dsId = repoId(row.id);
    if (!dsId) continue;
    datasets.push({ id: dsId, url: `${HUB}/datasets/${dsId}`, lastModified: isoDate(row.lastModified), tags: strings(row.tags) });
  }
  const robotics = (d: HubDataset) => d.tags.some((t) => ROBOTICS_TAG.test(t));
  return [...datasets.filter(robotics), ...datasets.filter((d) => !robotics(d))].slice(0, max);
}

export function hubStatus(): ProviderStatus {
  const paused = Date.now() < pausedUntil;
  return {
    id: "huggingface",
    label: "Hugging Face",
    configured: !paused,
    detail: paused
      ? `Paused: ${pauseReason()}`
      : `Public accounts, models and datasets, and fine-tunes of the base models Abstract serves. ${
          tokenRejected
            ? "HF_TOKEN was rejected (401), so calls are anonymous: fix or remove it."
            : hubToken()
              ? "Uses HF_TOKEN."
              : "No key needed (HF_TOKEN optional, for a higher rate limit)."
        }`,
  };
}

/** True when the repo id is one of SERVED_BASE_MODELS (case-insensitive); returns the canonical id. */
export function servedBaseOf(repo: string): string | null {
  const want = repo.trim().toLowerCase();
  return SERVED_BASE_MODELS.find((s) => s.toLowerCase() === want) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Queries

const HUB = "https://huggingface.co";
/** The Hub answers in well under a second; a slow answer is not retried (callers have budgets). */
const TIMEOUT_MS = 12_000;
const QUICKSEARCH_LIMIT = 10; // per type; the endpoint refuses more than 20
const LIST_FETCH = 100;
const DEFAULT_LIMIT = 20;
const ROBOTICS_TAG = /^(task_categories:)?robotics$|lerobot/i;

/** Legal forms that end company names and stop quicksearch from matching anything. */
const LEGAL_SUFFIX =
  /[\s,]+(inc|incorporated|llc|l\.l\.c|ltd|limited|gmbh|corp|corporation|co|plc|sa|sas|ag|bv|nv|ab|oy|pte|pty|srl|spa|kk)\.?$/i;
/** Generic words dropped for the one retry: "1X Technologies" -> "1X", "Dyna Robotics" -> "Dyna". */
const DESCRIPTOR = /\s+(ai|a\.i\.|robotics|robot|robots|technologies|technology|tech|labs|lab|systems|research|intelligence)$/i;

/**
 * Text for quicksearch. A Hub URL gives its account; a website or domain gives its first label
 * ("allenai.org" -> "allenai"), which is often the Hub handle; a name loses legal suffixes.
 */
export function hubQuery(text: unknown): string | null {
  if (typeof text !== "string") return null;
  let t = text.trim();
  if (!t) return null;
  const hub = t.match(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/(?:(?:datasets|spaces)\/)?([^/?#\s]+)/i);
  if (hub) return validId(hub[1]) ? hub[1] : null;
  if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) && !/\s/.test(t)) {
    const host = t.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase().replace(/^www\./, "");
    const label = host.split(".")[0];
    return label.length >= 2 ? label : null;
  }
  t = t.replace(/["“”()[\]{}]/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && LEGAL_SUFFIX.test(t); i++) t = t.replace(LEGAL_SUFFIX, "").trim();
  t = t.replace(/[\s,.;:]+$/, "").slice(0, 100).trim();
  return t.length >= 2 ? t : null;
}

function withoutDescriptors(q: string): string | null {
  let t = q;
  for (let i = 0; i < 3 && DESCRIPTOR.test(t); i++) t = t.replace(DESCRIPTOR, "").trim();
  return t.length >= 2 ? t : null;
}

async function quicksearch(q: string): Promise<HubAccount[]> {
  const params = new URLSearchParams({ q });
  params.append("type", "org");
  params.append("type", "user");
  params.set("limit", String(QUICKSEARCH_LIMIT));
  const body = await hubGet("/api/quicksearch", params);
  if (!isRec(body)) throw new Error("Hugging Face returned an unexpected search response");
  const out: HubAccount[] = [];
  const seen = new Set<string>();
  const add = (id: string | null, type: HubAccount["type"], fullName: string | null) => {
    if (!id || !validId(id) || seen.has(id.toLowerCase())) return;
    seen.add(id.toLowerCase());
    out.push({ id, type, url: `${HUB}/${id}`, fullName });
  };
  for (const o of Array.isArray(body.orgs) ? body.orgs : []) if (isRec(o)) add(str(o.name), "org", str(o.fullname));
  for (const u of Array.isArray(body.users) ? body.users : []) if (isRec(u)) add(str(u.user), "user", str(u.fullname));
  return out;
}

function listParams(author: string, fields: string[]): URLSearchParams {
  const params = new URLSearchParams({ author, sort: "lastModified", direction: "-1", limit: String(LIST_FETCH) });
  for (const f of fields) params.append("expand[]", f);
  return params;
}

/** A bare account id ("allenai"); also accepts a Hub URL or "org/repo" and keeps the account. */
function accountId(author: unknown): string {
  const raw = typeof author === "string" ? author.trim().replace(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\//i, "") : "";
  const id = raw.split("/")[0];
  if (!validId(id)) throw new Error(`Not a valid Hugging Face account id: "${String(author).slice(0, 60)}"`);
  return id;
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id);
}

// ---------------------------------------------------------------------------------------------
// Base models

interface BaseRef {
  id: string;
  /** "finetune", "adapter", "quantized", "merge", or null when the source does not say. */
  relation: string | null;
}

interface ParsedModel {
  model: HubModel;
  bases: BaseRef[];
}

/** A quantized or merged copy is not the team's own training run, so it does not count as a fine-tune. */
const NOT_A_FINETUNE = new Set(["quantized", "merge"]);

function parseModelRow(row: unknown): ParsedModel | null {
  if (!isRec(row)) return null;
  const id = repoId(row.id);
  if (!id) return null;
  const tags = strings(row.tags);
  const bases = baseRefs(row, tags, id);
  const served = bases.find((b) => !NOT_A_FINETUNE.has(b.relation ?? "") && servedBaseOf(b.id));
  return {
    model: {
      id,
      url: `${HUB}/${id}`,
      lastModified: isoDate(row.lastModified),
      downloads: count(row.downloads),
      likes: count(row.likes),
      baseModels: bases.map((b) => b.id),
      servedBase: served ? servedBaseOf(served.id) : null,
      tags,
    },
    bases,
  };
}

/** Merges the three sources of base models, keeping the first spelling seen and any relation given. */
export function baseRefs(row: Record<string, unknown>, tags: string[], selfId: string): BaseRef[] {
  const refs: BaseRef[] = [];
  const add = (value: unknown, relation: string | null) => {
    const id = repoId(value);
    if (!id || id.toLowerCase() === selfId.toLowerCase()) return;
    const known = refs.find((r) => r.id.toLowerCase() === id.toLowerCase());
    if (known) known.relation = known.relation ?? relation;
    else refs.push({ id, relation });
  };
  // 1. expand[]=baseModels: the Hub's own parsed relation, canonical ids.
  if (isRec(row.baseModels)) {
    const relation = str(row.baseModels.relation)?.toLowerCase() ?? null;
    for (const m of Array.isArray(row.baseModels.models) ? row.baseModels.models : []) add(isRec(m) ? m.id : m, relation);
  }
  // 2. Tags: "base_model:<id>" and "base_model:<relation>:<id>" (a repo id never contains ":").
  for (const t of tags) {
    if (!t.startsWith("base_model:")) continue;
    const parts = t.slice("base_model:".length).split(":");
    add(parts[parts.length - 1], parts.length > 1 ? parts[0].toLowerCase() : null);
  }
  // 3. The card's raw base_model: a fallback when the Hub made no tag from it.
  const card = isRec(row.cardData) ? row.cardData.base_model : null;
  for (const v of Array.isArray(card) ? card : [card]) add(v, null);
  return refs;
}

/**
 * A fine-tune of the team's own fine-tune of a served base (both in the list) inherits the
 * served base: same architecture, same lane. Resolved within the list, so it costs no calls.
 */
function resolveServedBases(models: ParsedModel[]): void {
  const byId = new Map(models.map((m) => [m.model.id.toLowerCase(), m]));
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const m of models) {
      if (m.model.servedBase) continue;
      for (const b of m.bases) {
        if (NOT_A_FINETUNE.has(b.relation ?? "")) continue;
        const parent = byId.get(b.id.toLowerCase());
        if (parent?.model.servedBase) {
          m.model.servedBase = parent.model.servedBase;
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP: one retry on 5xx and network errors, none on timeouts, and a pause after a 429.

let pausedUntil = 0;

/**
 * HF_TOKEN is not in env.ts KEYS yet (foundation change requested), hence the cast; it is still
 * read through optionalEnv. Unset, every call is anonymous, exactly as before.
 */
const HF_TOKEN_KEY = "HF_TOKEN" as EnvKey;
/** Set after the Hub answers 401 to the token: calls go on anonymously and the status says why. */
let tokenRejected = false;

function hubToken(): string | undefined {
  return tokenRejected ? undefined : optionalEnv(HF_TOKEN_KEY);
}

function pauseReason(): string {
  const s = Math.max(1, Math.ceil((pausedUntil - Date.now()) / 1000));
  const wait = s >= 90 ? `about ${Math.ceil(s / 60)} min` : `${s} s`;
  return hubToken()
    ? `Hugging Face is rate-limiting this account (HF_TOKEN). Back in ${wait}.`
    : `Hugging Face is rate-limiting this server's IP (anonymous API, 500 requests per 5 minutes; HF_TOKEN raises it). Back in ${wait}.`;
}

async function hubGet(path: string, params: URLSearchParams): Promise<unknown> {
  const url = `${HUB}${path}?${params.toString()}`;
  if (Date.now() < pausedUntil) throw new HttpError(429, pauseReason(), url);
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    let res: Response;
    const token = hubToken();
    try {
      res = await fetch(url, {
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (err) {
      last = err;
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) break;
      continue;
    }
    const text = await res.text().catch(() => "");
    if (res.status === 401 && token) {
      // A revoked or mistyped token must not cost the research its Hub data: go anonymous.
      tokenRejected = true;
      continue;
    }
    if (res.status === 429) {
      pausedUntil = Date.now() + resetSeconds(res.headers) * 1000;
      throw new HttpError(429, pauseReason(), url);
    }
    if (res.status >= 500) {
      last = new HttpError(res.status, hubError(text), url);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, hubError(text), url);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Hugging Face returned an unreadable response for ${path}`);
    }
  }
  if (last instanceof HttpError) throw last;
  if (last instanceof Error && (last.name === "TimeoutError" || last.name === "AbortError")) {
    throw new Error(`Hugging Face did not answer within ${TIMEOUT_MS / 1000} s`);
  }
  const reason = last instanceof Error ? `${last.message}${last.cause instanceof Error ? ` (${last.cause.message})` : ""}` : String(last);
  throw new Error(`Could not reach Hugging Face: ${reason}`);
}

/** Seconds until the rate-limit window resets: `ratelimit: "api";r=0;t=68`, else Retry-After, else 60. */
function resetSeconds(headers: Headers): number {
  const t = headers.get("ratelimit")?.match(/\bt=(\d+)/)?.[1];
  const retryAfter = headers.get("retry-after");
  const s = t ? Number(t) : retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) : 60;
  return Math.max(5, Math.min(600, s));
}

/** The Hub's JSON errors are { "error": "..." }. */
function hubError(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (isRec(body) && typeof body.error === "string") return body.error.slice(0, 300);
  } catch {
    // not JSON
  }
  return text.trim().slice(0, 300);
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** "org/name", also from a Hub URL. Null for anything else. */
function repoId(v: unknown): string | null {
  const s = str(v)?.replace(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\//i, "").replace(/\/+$/, "");
  if (!s || s.length > 200) return null;
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(s) ? s : null;
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (value == null || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
