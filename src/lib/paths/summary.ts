/**
 * le_leads.warm_path: the list chip's few fields, from a lead's ranked paths. Pure and client-safe.
 */

import { firstNameOf, summaryLabel } from "./copy";
import { isConfirmedDirect, pathNetwork } from "./score";
import type { WarmPath, WarmPathSummary } from "./types";

/**
 * The summary of a lead's best path when it is Strong or Medium, else null. `paths` are ranked,
 * best first; `leadName` words the label ("LinkedIn 1st degree", "Medium path via Priya Shah").
 */
export function summarizePaths(paths: ReadonlyArray<Pick<WarmPath, "hops" | "links" | "strength" | "connector">>, leadName: string | null, checkedAt: string): WarmPathSummary | null {
  // A weak direct overlap (the same school) ranks before every two-hop path: look past it.
  const good = (p: { strength: WarmPath["strength"] }) => p.strength === "strong" || p.strength === "medium";
  const best = paths[0] && good(paths[0]) ? paths[0] : (paths.find((p) => p.strength === "strong") ?? paths.find(good));
  if (!best || (best.strength !== "strong" && best.strength !== "medium")) return null;
  return {
    strength: best.strength,
    hops: best.hops,
    via: best.hops === 2 ? (best.connector?.name ?? null) : null,
    network: pathNetwork(best),
    connected: isConfirmedDirect(best),
    label: summaryLabel(best, firstNameOf(leadName)),
    checkedAt,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored summary as WarmPathSummary, or null when it is missing or not in that shape. */
export function cleanWarmPathSummary(v: unknown): WarmPathSummary | null {
  if (!isObj(v)) return null;
  const strength = v.strength === "strong" || v.strength === "medium" ? v.strength : null;
  const hops = v.hops === 1 || v.hops === 2 ? v.hops : null;
  const network = v.network === "linkedin" || v.network === "x" || v.network === "mixed" ? v.network : null;
  if (!strength || !hops || !network) return null;
  return {
    strength,
    hops,
    via: typeof v.via === "string" && v.via.trim() ? v.via : null,
    network,
    connected: v.connected === true,
    label: typeof v.label === "string" ? v.label : "",
    checkedAt: typeof v.checkedAt === "string" ? v.checkedAt : "",
  };
}
