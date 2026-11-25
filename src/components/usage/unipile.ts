/** The Unipile card's two LinkedIn accounts, as pure helpers. Client-safe. */
import { formatCount, plural } from "@/lib/usage/format";
import type { OperationStats, ProviderBalance } from "@/lib/usage/types";

/**
 * Unipile serves two LinkedIn accounts once warm paths use your own (UNIPILE_NETWORK_ACCOUNT_ID):
 * the research account and yours. The balance then carries today's counts for each, and they are
 * shown as rows instead of one long line. Null when your account is not set up (the plain summary
 * is shown) or the research count is unknown.
 */
export function unipileSplit(balance: Pick<ProviderBalance, "provider" | "numbers">): Array<{ label: string; value: string }> | null {
  const n = balance.numbers;
  if (balance.provider !== "unipile" || typeof n.networkRequestsToday !== "number" || typeof n.linkedinRequestsToday !== "number") return null;
  const rows = [
    { label: "Research account", value: `${formatCount(n.linkedinRequestsToday)} of ~${formatCount(n.dailyGuidance ?? 100)} requests today` },
    { label: "Your account", value: `${plural(n.networkRequestsToday, "request")} today` },
  ];
  if (typeof n.warmPathChecksToday === "number" && typeof n.warmPathChecksLimit === "number") {
    rows.push({ label: "Warm-path checks", value: n.warmPathChecksLimit > 0 ? `${formatCount(n.warmPathChecksToday)} of ${formatCount(n.warmPathChecksLimit)} today` : "Paused" });
  }
  return rows;
}

/** Calls in the window made on your own LinkedIn account (Unipile's network-* operations, for warm paths). */
export function ownAccountCalls(operations: ReadonlyArray<Pick<OperationStats, "provider" | "operation" | "calls">>): number {
  return operations.filter((o) => o.provider === "unipile" && o.operation.startsWith("network-")).reduce((sum, o) => sum + o.calls, 0);
}
