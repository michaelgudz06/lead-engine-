import "server-only";
import { note, type RunContext } from "../research/context";
import { errorMessage } from "../research/util";
import { findWarmPaths, type FindWarmPathsResult } from "./engine";

/**
 * Warm paths inside a research run (never in a steer run). Started right after gather, when the
 * profile (roles, schools, member id) and a verified X handle are known; it runs alongside extract,
 * the agent and writing, and the run awaits it just before it finishes. Capped at
 * min(60 s, time left - 20 s) from its start, so the run never waits longer than that, and it
 * never throws. It logs one 'tool' event with the outcome.
 */

export const RESEARCH_WARM_PATHS_CAP_MS = 60_000;
/** Kept back for the rest of the run when the check starts. */
const RESERVE_MS = 20_000;
/** Below this there is no point starting. */
const MIN_BUDGET_MS = 5_000;

export interface WarmPathsTask {
  /** Waits for the check (at most until its cap) and logs its one event. Never throws. */
  settle(): Promise<FindWarmPathsResult | null>;
}

type Finder = typeof findWarmPaths;

/** Starts the check for a run. `find` is for tests (a fake engine). */
export function startWarmPaths(ctx: RunContext, opts: { find?: Finder; now?: () => number } = {}): WarmPathsTask {
  const now = opts.now ?? Date.now;
  const find = opts.find ?? findWarmPaths;
  const budget = Math.min(RESEARCH_WARM_PATHS_CAP_MS, ctx.deadline.remaining() - RESERVE_MS);
  if (budget < MIN_BUDGET_MS) {
    let logged = false;
    return {
      async settle() {
        if (!logged) {
          logged = true;
          await note(ctx.leadId, "tool", "Warm paths skipped: no time left in this run");
        }
        return null;
      },
    };
  }
  const startedAt = now();
  const work: Promise<FindWarmPathsResult | null> = (async () => {
    try {
      return await find(ctx.leadId, {
        trigger: "research",
        budgetMs: budget,
        profile: ctx.profile,
        company: ctx.company,
        profileRead: true,
        now,
      });
    } catch (err) {
      // findWarmPaths never throws; this is the second net.
      return {
        outcome: "error",
        paths: null,
        message: `Warm paths: could not check (${errorMessage(err).slice(0, 160)})`,
        live: { setUp: [], overBudget: [], failed: [] },
        spent: { xCredits: 0, xUsd: 0, linkedinRequests: 0 },
      } satisfies FindWarmPathsResult;
    }
  })();
  let settled: Promise<FindWarmPathsResult | null> | null = null;
  return {
    settle() {
      settled ??= (async () => {
        const left = Math.max(0, startedAt + budget + 1000 - now());
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), left);
        });
        const res = await Promise.race([work, timeout]);
        clearTimeout(timer);
        if (res === "timeout") {
          await note(ctx.leadId, "tool", "Warm paths: still checking when the run ended. The panel shows the result when it is ready.");
          return null;
        }
        if (res && res.outcome !== "lead_missing") await note(ctx.leadId, "tool", res.message, { warmPaths: res.outcome, xCredits: res.spent.xCredits, linkedinRequests: res.spent.linkedinRequests });
        return res;
      })();
      return settled;
    },
  };
}
