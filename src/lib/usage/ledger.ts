import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { json, query } from "../db";
import { roundUsd } from "./prices";
import type { CostBasis, UsageProvider, UsageUnits } from "./types";

/**
 * Write side of the usage ledger: one row in le_usage per call to an outside API.
 *
 * - recordUsage() is synchronous for the caller: it starts the insert and returns. It
 *   never throws and never rejects, so accounting cannot fail or slow a research step.
 * - The lead comes from an AsyncLocalStorage context opened with withUsageContext(leadId, fn).
 *   Everything awaited inside fn (providers, Claude, tool callbacks) inherits it.
 * - Each context tracks its unfinished inserts; flushUsage() awaits them. A serverless
 *   function is frozen once its work is done, so a run must flush before it returns:
 *   withUsageContext() does that itself when fn settles.
 * - Calls outside any context are recorded with lead_id null and tracked in a process-wide
 *   set; flushUsage() called outside a context awaits that set.
 */

export interface UsageEntry {
  provider: UsageProvider;
  /** Short and low-cardinality, e.g. "search", "profile", "messages.parse". No ids, no queries. */
  operation: string;
  /** Unit names per provider are documented in types.ts. */
  units?: UsageUnits;
  costUsd?: number | null;
  costBasis?: CostBasis;
  ok?: boolean;
  ms?: number | null;
  /** Overrides the context's lead. Only for callers that know the lead but run outside a context. */
  leadId?: string | null;
}

interface UsageContext {
  leadId: string | null;
  pending: Set<Promise<void>>;
}

const storage = new AsyncLocalStorage<UsageContext>();
/** Inserts started outside any context. */
const loose = new Set<Promise<void>>();

/** How long flushUsage() waits for slow inserts before giving up, so a run always ends. */
const FLUSH_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let warned = 0;
function warn(err: unknown): void {
  // A few lines are enough to notice a broken ledger; never the row itself.
  if (warned++ < 3) console.warn(`[usage] could not record a ledger row: ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"}`);
}

/** The lead of the current usage context, or null outside one. */
export function currentUsageLeadId(): string | null {
  return storage.getStore()?.leadId ?? null;
}

/**
 * Runs fn with every recordUsage() inside it tagged to the lead, then waits for the
 * ledger rows to be written. Returns (or throws) exactly what fn does.
 */
export async function withUsageContext<T>(leadId: string | null, fn: () => Promise<T>): Promise<T> {
  const ctx: UsageContext = { leadId: leadId && UUID.test(leadId) ? leadId : null, pending: new Set() };
  try {
    return await storage.run(ctx, fn);
  } finally {
    await drain(ctx.pending);
  }
}

/** Waits until the rows recorded so far (in this context, or outside any) are written. Never throws. */
export async function flushUsage(): Promise<void> {
  await drain(storage.getStore()?.pending ?? loose);
}

async function drain(pending: Set<Promise<void>>): Promise<void> {
  const stopAt = Date.now() + FLUSH_TIMEOUT_MS;
  // Loop: a row may be recorded while earlier ones are still being awaited.
  while (pending.size && Date.now() < stopAt) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, stopAt - Date.now()));
    });
    await Promise.race([Promise.all([...pending]).then(() => undefined), timeout]);
    clearTimeout(timer);
  }
}

/** Records one outside call. Fire-and-forget: returns at once, never throws. */
export function recordUsage(entry: UsageEntry): void {
  try {
    const ctx = storage.getStore();
    const override = typeof entry.leadId === "string" && UUID.test(entry.leadId) ? entry.leadId : null;
    const leadId = override ?? ctx?.leadId ?? null;
    const pending = ctx?.pending ?? loose;
    const task: Promise<void> = insert(leadId, entry)
      .catch(warn)
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  } catch (err) {
    warn(err);
  }
}

function cleanUnits(units: UsageUnits | undefined): UsageUnits {
  const out: UsageUnits = {};
  for (const [k, v] of Object.entries(units ?? {})) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function insert(leadId: string | null, e: UsageEntry): Promise<void> {
  const cost = typeof e.costUsd === "number" && Number.isFinite(e.costUsd) && e.costUsd >= 0 ? roundUsd(e.costUsd) : null;
  const basis: CostBasis = e.costBasis ?? (cost === null ? "unknown" : "estimated");
  const ms = typeof e.ms === "number" && Number.isFinite(e.ms) ? Math.max(0, Math.min(2_147_483_647, Math.round(e.ms))) : null;
  // The subselects make a deleted lead a null lead_id instead of a foreign-key error. The
  // name snapshot is never null for a tagged row, so "lead deleted" (lead_id null, name
  // kept) can be told apart from "never tied to a lead" (both null).
  await query(
    `insert into le_usage (lead_id, lead_name, provider, operation, units, cost_usd, cost_basis, ok, ms)
     values (
       (select id from le_leads where id = $1::uuid),
       (select coalesce(nullif(btrim(name), ''), linkedin_slug, 'Unnamed lead') from le_leads where id = $1::uuid),
       $2, $3, $4::jsonb, $5::numeric, $6, $7, $8::integer
     )`,
    [leadId, e.provider, String(e.operation).slice(0, 80), json(cleanUnits(e.units)), cost, basis, e.ok !== false, ms],
  );
}

export interface Metered {
  units?: UsageUnits;
  costUsd?: number | null;
  costBasis?: CostBasis;
}

/**
 * Wraps one outside request: times it, records one ledger row, and passes the result or
 * the error through untouched. `onOk` reads units and cost from the answer; `onFail` says
 * what a failed call used (default: nothing known). Neither may change the result.
 */
export async function metered<T>(
  spec: {
    provider: UsageProvider;
    operation: string;
    onOk: (result: T) => Metered;
    onFail?: (err: unknown) => Metered;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    let used: Metered = {};
    try {
      used = spec.onFail?.(err) ?? {};
    } catch {
      // Accounting only.
    }
    recordUsage({ provider: spec.provider, operation: spec.operation, ...used, ok: false, ms: Date.now() - started });
    throw err;
  }
  let used: Metered = {};
  try {
    used = spec.onOk(result);
  } catch {
    // Accounting only.
  }
  recordUsage({ provider: spec.provider, operation: spec.operation, ...used, ok: true, ms: Date.now() - started });
  return result;
}
