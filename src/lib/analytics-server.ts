import "server-only";
import { after } from "next/server";
import { PostHog } from "posthog-node";
import { posthogHosts, sanitizeProps } from "./analytics";
import { query } from "./db";
import { optionalEnv } from "./env";
import { listEvents } from "./repo/events";
import { getLead } from "./repo/leads";
import type { LeadEvent } from "./types";

/**
 * Product analytics (PostHog), server side: how research and steer runs end, which only the
 * server sees. Off, and touching nothing, unless NEXT_PUBLIC_POSTHOG_KEY holds a public
 * "phc_" project key.
 *
 * - Every server event uses one fixed distinct id with $process_person_profile false: no
 *   person profile, and nothing about who clicked.
 * - Properties go through the browser's sanitiser (src/lib/analytics.ts): ids, counts,
 *   durations, enums and booleans. Never names, emails, notes, drafts, instructions or URLs.
 * - Each event goes out with captureImmediate, awaited inside the route's after() task, so it
 *   is sent before the function ends. Reporting is capped at a few seconds and never throws:
 *   a slow or broken PostHog cannot hold up or break a run.
 */

export const SERVER_DISTINCT_ID = "lead-engine-server";

/** The longest a run's report may take, database reads included. */
const REPORT_TIMEOUT_MS = 8_000;

interface ResearchOutcome {
  leadId: string;
  /** done | error | running (the final status was not saved) | crashed (the run threw). */
  status: string;
  durationMs: number;
  findings: number;
  /** Findings that pass the criteria, the ones the brief and drafts may use. */
  findingsUsed: number;
  angles: number;
  hasBrief: boolean;
  /** Everything the usage ledger has recorded for the lead (all runs). Absent when unknown. */
  costUsd?: number;
}

interface SteerOutcome {
  leadId: string;
  mode: "rewrite" | "research" | "unknown";
  status: string;
  ok: boolean;
  durationMs: number;
  angles: number;
  newFindings?: number;
}

export interface ServerEventProps {
  research_completed: ResearchOutcome;
  research_failed: ResearchOutcome;
  steer_completed: SteerOutcome;
}

export type ServerEvent = keyof ServerEventProps;

// ------------------------------------------------------------------ the client

/** The public project key, or null when analytics is off. */
function projectKey(): string | null {
  const key = optionalEnv("NEXT_PUBLIC_POSTHOG_KEY");
  return key && /^phc_[A-Za-z0-9_-]+$/.test(key) ? key : null;
}

export function serverAnalyticsEnabled(): boolean {
  return projectKey() !== null;
}

let cached: { id: string; client: PostHog } | null = null;

function serverClient(): PostHog | null {
  const key = projectKey();
  if (!key) return null;
  // The server talks to PostHog's ingestion host directly; /ingest is for browsers.
  const host = posthogHosts(optionalEnv("NEXT_PUBLIC_POSTHOG_HOST")).api;
  const id = `${key}@${host}`;
  if (cached?.id !== id) {
    const old = cached?.client;
    if (old) void old.shutdown().catch(() => {});
    cached = {
      id,
      client: new PostHog(key, {
        host,
        // Send each event at once: a serverless function may freeze as soon as its work ends.
        flushAt: 1,
        flushInterval: 0,
        requestTimeout: 5_000,
        captureMaxRetries: 1,
        disableGeoip: true,
      }),
    };
  }
  return cached.client;
}

/** Sends what is queued and closes the client (scripts and tests; routes need not call it). */
export async function shutdownServerAnalytics(): Promise<void> {
  const client = cached?.client;
  cached = null;
  if (client) await client.shutdown().catch(() => {});
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function brief(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 160) : "unknown error";
}

/**
 * Sends one server event and waits until PostHog has it (or the time cap). A no-op when
 * analytics is off. Rejects on failure; the run reporters below catch it.
 */
export async function captureServerEvent<E extends ServerEvent>(event: E, props: ServerEventProps[E]): Promise<void> {
  const client = serverClient();
  if (!client) return;
  const properties = { ...sanitizeProps(props as unknown as Record<string, unknown>), $process_person_profile: false };
  await withTimeout(client.captureImmediate({ distinctId: SERVER_DISTINCT_ID, event, properties, disableGeoip: true }), REPORT_TIMEOUT_MS);
}

// ------------------------------------------------------------------ run outcomes

/** After the current after() task when inside a request; at once otherwise (scripts). */
function later(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

async function findingCounts(leadId: string): Promise<{ total: number; used: number }> {
  const rows = await query<{ total: number | string; used: number | string }>(
    "select count(*)::int as total, count(*) filter (where passes_criteria)::int as used from le_findings where lead_id = $1",
    [leadId],
  );
  return { total: Number(rows[0]?.total ?? 0) || 0, used: Number(rows[0]?.used ?? 0) || 0 };
}

/** leadCostUsd() from the usage ledger (src/lib/usage/queries.ts) when it exists; null when it does not or fails. */
async function ledgerCostUsd(leadId: string): Promise<number | null> {
  try {
    const ledger = (await import("./usage/queries")) as unknown as Record<string, unknown>;
    const leadCostUsd = ledger.leadCostUsd;
    if (typeof leadCostUsd !== "function") return null;
    const value: unknown = await (leadCostUsd as (id: string) => Promise<unknown>)(leadId);
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  } catch {
    return null;
  }
}

async function reportResearch(leadId: string, started: number, ended: number, crashed: boolean): Promise<void> {
  try {
    await withTimeout(
      (async () => {
        const lead = await getLead(leadId);
        if (!lead) return; // deleted during the run: nothing left to report on
        const [counts, costUsd] = await Promise.all([findingCounts(leadId), ledgerCostUsd(leadId)]);
        const status = crashed ? "crashed" : lead.researchStatus;
        await captureServerEvent(status === "done" ? "research_completed" : "research_failed", {
          leadId,
          status,
          durationMs: Math.max(0, ended - started),
          findings: counts.total,
          findingsUsed: counts.used,
          angles: lead.angles.length,
          hasBrief: Boolean(lead.brief),
          ...(costUsd === null ? {} : { costUsd }),
        });
      })(),
      REPORT_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn(`[analytics] could not report the research run for lead ${leadId}: ${brief(err)}`);
  }
}

const STEER_MODES: ReadonlySet<string> = new Set(["rewrite", "research"]);

function field(data: unknown, key: string): unknown {
  return data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
}

function steerMode(data: unknown): "rewrite" | "research" | null {
  const mode = field(data, "mode");
  return typeof mode === "string" && STEER_MODES.has(mode) ? (mode as "rewrite" | "research") : null;
}

/**
 * What a steer run decided, from the events it logged: the "done" event (mode, newFindings)
 * or, when the run failed before that, the "steer" event (mode). Only events from this run
 * count (2 s of slack for clock skew between app and database). Reads the mode and a count
 * only: the steer event also holds the instruction text, which never leaves. Pure.
 */
export function steerOutcomeFrom(
  events: readonly Pick<LeadEvent, "type" | "data" | "createdAt">[],
  startedAt: number,
): { mode: SteerOutcome["mode"]; newFindings?: number } {
  const mine = events.filter((e) => Date.parse(e.createdAt) >= startedAt - 2_000);
  const done = mine.find((e) => e.type === "done" && steerMode(e.data));
  const decided = mine.find((e) => e.type === "steer" && steerMode(e.data));
  const mode = steerMode(done?.data) ?? steerMode(decided?.data) ?? "unknown";
  const newFindings = field(done?.data, "newFindings");
  return typeof newFindings === "number" && Number.isFinite(newFindings) ? { mode, newFindings } : { mode };
}

async function reportSteer(leadId: string, started: number, ended: number, crashed: boolean): Promise<void> {
  try {
    await withTimeout(
      (async () => {
        const [lead, events] = await Promise.all([getLead(leadId), listEvents(leadId, 30)]);
        if (!lead) return;
        const outcome = steerOutcomeFrom(events, started);
        const status = crashed ? "crashed" : lead.researchStatus;
        await captureServerEvent("steer_completed", {
          leadId,
          ...outcome,
          status,
          ok: status === "done",
          durationMs: Math.max(0, ended - started),
          angles: lead.angles.length,
        });
      })(),
      REPORT_TIMEOUT_MS,
    );
  } catch (err) {
    console.warn(`[analytics] could not report the steer run for lead ${leadId}: ${brief(err)}`);
  }
}

type Reporter = (leadId: string, started: number, ended: number, crashed: boolean) => Promise<void>;

async function runAndReport(leadId: string, run: () => Promise<void>, report: Reporter): Promise<void> {
  if (!serverAnalyticsEnabled()) return run();
  const started = Date.now();
  try {
    await run();
  } catch (err) {
    // The route's safety net records the failure on the lead; report once it has.
    const ended = Date.now();
    later(() => report(leadId, started, ended, true));
    throw err;
  }
  await report(leadId, started, Date.now(), false);
}

/**
 * Wraps a research run inside the route's after() task: awaits it, then sends
 * research_completed or research_failed. Settles exactly as `run` does. With analytics
 * off it is just run().
 */
export function trackResearchRun(leadId: string, run: () => Promise<void>): Promise<void> {
  return runAndReport(leadId, run, reportResearch);
}

/** The same for a steer run: awaits it, then sends steer_completed with the mode the agent chose. */
export function trackSteerRun(leadId: string, run: () => Promise<void>): Promise<void> {
  return runAndReport(leadId, run, reportSteer);
}
