import "server-only";
import { hasEnv, optionalEnv } from "../env";
import { fetchJson, HttpError } from "../http";
import { metered } from "../usage/ledger";
import { FREE } from "../usage/prices";
import type { ProviderStatus } from "../types";

/**
 * Abstract's checkpoint inspect (POST https://api.abstract.inc/v1/models/inspect).
 * Needs ABSTRACT_API_KEY; without it, return configured:false and do nothing.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 *
 * Docs: https://docs.abstract.inc/api-reference/deployments/inspect-a-checkpoint.md
 * - Bearer auth; body { checkpoint_uri: "hf://<org>/<repo>@<revision>" } (a branch or tag is
 *   resolved to its commit; `main` when none is given).
 * - It reads the repo's file list, config.json and normalization file anonymously: no weights are
 *   downloaded and no GPU is started, so it is safe to call during research.
 * - Any checkpoint it can name is answered 200, servable or not: `servable` is true exactly when
 *   `problems` is empty, and each problem has a `code` from a closed list (repo_not_found,
 *   gated_repo, missing_norm_stats, insufficient_vram, ...).
 * - Errors: 400 invalid_checkpoint_uri / invalid_body, 401 invalid_api_key, 503 hub_unavailable
 *   (retryable; fetchJson retries once).
 */
export interface InspectResult {
  configured: boolean;
  servable: boolean | null;
  /** The Abstract model lane that would run it, e.g. allenai/molmoact2. */
  model: string | null;
  problems: string[];
  checkpointUri: string | null;
  estimatedVramGib: number | null;
  error?: string;
}

/** repoId like "acme/yam-towels" or "hf://acme/yam-towels@main". Never throws. */
export async function inspectCheckpoint(repoId: string): Promise<InspectResult> {
  const key = optionalEnv("ABSTRACT_API_KEY");
  if (!key) return { ...EMPTY, configured: false };
  try {
    const uri = toCheckpointUri(repoId);
    if (!uri) return { ...EMPTY, error: `Not a Hugging Face model repo id: "${String(repoId ?? "").slice(0, 120)}"` };
    let body: unknown;
    try {
      body = await post(key, uri, true);
    } catch (err) {
      // The pinned version keeps the answer's shape stable. Should the API ever stop answering
      // it, ask once more under the API's newest version rather than fail every inspect.
      if (!(err instanceof HttpError && err.status === 400 && errorInfo(err).code === "unsupported_api_version")) throw err;
      body = await post(key, uri, false);
    }
    return mapInspection(body);
  } catch (err) {
    return { ...EMPTY, error: describeError(err) };
  }
}

export function abstractStatus(): ProviderStatus {
  const configured = hasEnv("ABSTRACT_API_KEY");
  return {
    id: "abstract",
    label: "Abstract inspect",
    configured,
    detail: configured
      ? "Checks whether a lead's public Hugging Face checkpoints can be deployed on Abstract (reads repo metadata only: no weights, no GPU)."
      : "Off: set ABSTRACT_API_KEY to check whether a lead's fine-tunes can be deployed on Abstract.",
  };
}

/**
 * "acme/yam-towels", "acme/yam-towels@v2", "hf://acme/yam-towels", or a Hub model URL
 * (".../tree/<branch>" keeps the branch) -> "hf://acme/yam-towels@main". Null for anything else,
 * including dataset and Space URLs.
 */
export function toCheckpointUri(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let repo = input.trim();
  let revision: string | null = null;
  const web = repo.match(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/([^?#]+)/i);
  if (web) {
    const parts = web[1].split("/").filter(Boolean);
    if (parts.length < 2 || parts[0] === "datasets" || parts[0] === "spaces") return null;
    repo = `${parts[0]}/${parts[1]}`;
    if (parts[2] === "tree" && parts[3]) revision = safeDecode(parts[3]);
  } else {
    repo = repo.replace(/^hf:\/\//i, "");
    const at = repo.indexOf("@");
    if (at >= 0) {
      revision = repo.slice(at + 1);
      repo = repo.slice(0, at);
    }
  }
  repo = repo.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/.test(repo)) return null;
  const rev = revision?.trim() || "main";
  if (!/^[\w.\/-]{1,128}$/.test(rev)) return null;
  return `hf://${repo}@${rev}`;
}

// ---------------------------------------------------------------------------------------------

const ENDPOINT = "https://api.abstract.inc/v1/models/inspect";
/** The API version this code was written against (docs: newest as of Nov 2026). */
const API_VERSION = "2026-11-17";
/** Per attempt. The check reads three small files from the Hub; fetchJson retries once on 503. */
const TIMEOUT_MS = 20_000;

const EMPTY: InspectResult = {
  configured: true,
  servable: null,
  model: null,
  problems: [],
  checkpointUri: null,
  estimatedVramGib: null,
};

function post(key: string, checkpointUri: string, pinVersion: boolean): Promise<unknown> {
  // Usage ledger: inspect calls are free; requests are counted.
  const used = () => ({ units: { requests: 1 }, ...FREE });
  return metered({ provider: "abstract", operation: "inspect", onOk: used, onFail: used }, () =>
    fetchJson<unknown>(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, ...(pinVersion ? { "abstract-version": API_VERSION } : {}) },
      body: { checkpoint_uri: checkpointUri },
      timeoutMs: TIMEOUT_MS,
    }),
  );
}

/** Maps a CheckpointInspection. servable is null only together with an error. */
export function mapInspection(body: unknown): InspectResult {
  if (!isRec(body)) return { ...EMPTY, error: "Abstract returned an unexpected inspect response" };
  const problems = (Array.isArray(body.problems) ? body.problems : [])
    .map((p) => (isRec(p) ? str(p.code) : str(p)))
    .filter((c): c is string => c !== null);
  // The docs define servable as "problems is empty"; derive it if the flag is ever missing.
  const servable = typeof body.servable === "boolean" ? body.servable : Array.isArray(body.problems) ? problems.length === 0 : null;
  const memory = isRec(body.memory) ? body.memory : null;
  const vram = memory && typeof memory.estimated_vram_gib === "number" && Number.isFinite(memory.estimated_vram_gib) ? memory.estimated_vram_gib : null;
  return {
    configured: true,
    servable,
    model: str(body.model),
    problems,
    checkpointUri: str(body.checkpoint_uri),
    estimatedVramGib: vram,
    ...(servable === null ? { error: "Abstract's inspect answer did not say whether the checkpoint is servable" } : {}),
  };
}

/** { error: { code, message } }, Abstract's error envelope. */
function errorInfo(err: HttpError): { code: string | null; message: string | null } {
  try {
    const body: unknown = JSON.parse(err.bodySnippet);
    if (isRec(body) && isRec(body.error)) return { code: str(body.error.code), message: str(body.error.message) };
  } catch {
    // not JSON
  }
  return { code: null, message: err.bodySnippet.trim().slice(0, 200) || null };
}

function describeError(err: unknown): string {
  if (err instanceof HttpError) {
    const { code, message } = errorInfo(err);
    const tag = `${err.status}${code ? ` ${code}` : ""}`;
    const said = message ? `: ${message.slice(0, 200)}` : "";
    if (err.status === 401) return `Abstract rejected the API key (${tag}). Check ABSTRACT_API_KEY.`;
    if (code === "hub_unavailable") return "Abstract could not read the Hugging Face Hub just now (503 hub_unavailable). Try again.";
    if (err.status === 429) return `Abstract rate limit reached (${tag}). Try again shortly.`;
    if (err.status >= 500) return `Abstract inspect is unavailable right now (${tag}).`;
    return `Abstract could not inspect the checkpoint (${tag})${said}`;
  }
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return `Abstract inspect timed out after ${TIMEOUT_MS / 1000} s`;
    if (err instanceof SyntaxError) return "Abstract returned an unreadable inspect response";
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `Could not reach Abstract: ${err.message}${cause}`;
  }
  return `Abstract inspect failed: ${String(err)}`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}
