/**
 * Which Unipile account does what. Pure: src/lib/providers/linkedin.ts picks the account with it
 * before every research read, and src/lib/usage/balances.ts names the same account on the Usage
 * tab, so the two can never disagree.
 *
 * Two roles:
 * - research: the separate LinkedIn account research reads profiles, posts and company pages
 *   with. UNIPILE_ACCOUNT_ID pins it. When it is not pinned and the owner's account is not set
 *   up, the one LinkedIn account in the workspace is used. Nothing is guessed when two or more
 *   accounts are left, or when UNIPILE_NETWORK_ACCOUNT_ID is set without a pin: a slip in that
 *   variable (the research account's id) would otherwise leave the owner's account as "the other
 *   one". Research then falls back as it does when Unipile is unavailable.
 * - network: the owner's own LinkedIn (UNIPILE_NETWORK_ACCOUNT_ID), used only for warm paths.
 *   Research never reads through it, pinned or not.
 */

export interface UnipileAccountInfo {
  id: string;
  /** Upper case, e.g. "LINKEDIN". */
  type: string;
  /** The sources' statuses, upper case: OK, STOPPED, ERROR, CREDENTIALS, PERMISSIONS, CONNECTING. */
  statuses: string[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The accounts of GET /api/v1/accounts, in the order Unipile lists them. Unknown shapes give []. */
export function unipileAccountsFrom(list: unknown): UnipileAccountInfo[] {
  const items = isObj(list) && Array.isArray(list.items) ? list.items : [];
  return items.filter(isObj).flatMap((a) => {
    const id = typeof a.id === "string" ? a.id.trim() : "";
    if (!id) return [];
    const statuses = (Array.isArray(a.sources) ? a.sources : []).filter(isObj).map((s) => {
      const v = String(s.status ?? "UNKNOWN").toUpperCase();
      return /^[A-Z_]{2,30}$/.test(v) ? v : "UNKNOWN";
    });
    return [{ id, type: String(a.type ?? "").toUpperCase(), statuses }];
  });
}

const isLinkedIn = (a: UnipileAccountInfo) => a.type === "LINKEDIN";
const someOk = (a: UnipileAccountInfo) => a.statuses.includes("OK");
const statusText = (statuses: string[]) => [...new Set(statuses)].join("/") || "unknown";

export type ResearchAccountChoice =
  | { ok: true; id: string }
  | {
      ok: false;
      code: "pinned_missing" | "pinned_not_linkedin" | "pinned_not_running" | "pinned_is_network" | "none" | "only_network" | "ambiguous" | "not_running";
      /** One plain sentence; names environment variables, never an account id or name. */
      message: string;
    };

/**
 * The research account: UNIPILE_ACCOUNT_ID when set (never the owner's network account), else the
 * one LinkedIn account in the workspace. Refuses to guess between two or more, and to pick by
 * elimination once the owner's account (UNIPILE_NETWORK_ACCOUNT_ID) is set: then only the pin counts.
 */
export function chooseResearchAccount(
  accounts: UnipileAccountInfo[],
  opts: { pinned?: string | null; network?: string | null },
): ResearchAccountChoice {
  const pinned = opts.pinned?.trim() || null;
  const network = opts.network?.trim() || null;
  if (pinned) {
    if (network && pinned === network) {
      return {
        ok: false,
        code: "pinned_is_network",
        message: "UNIPILE_ACCOUNT_ID is the same account as UNIPILE_NETWORK_ACCOUNT_ID. Research never reads LinkedIn as the owner: pin the separate research account",
      };
    }
    const acc = accounts.find((a) => a.id === pinned);
    if (!acc) return { ok: false, code: "pinned_missing", message: "UNIPILE_ACCOUNT_ID does not match any account in this Unipile workspace" };
    if (!isLinkedIn(acc)) return { ok: false, code: "pinned_not_linkedin", message: "UNIPILE_ACCOUNT_ID is not a LinkedIn account" };
    if (!someOk(acc)) {
      return {
        ok: false,
        code: "pinned_not_running",
        message: `The pinned Unipile LinkedIn account is not running (status ${statusText(acc.statuses)}); reconnect it in the Unipile dashboard`,
      };
    }
    return { ok: true, id: pinned };
  }
  const linkedin = accounts.filter(isLinkedIn);
  if (!linkedin.length) return { ok: false, code: "none", message: "No LinkedIn account is connected in Unipile" };
  const others = linkedin.filter((a) => a.id !== network);
  if (!others.length) {
    return {
      ok: false,
      code: "only_network",
      message: "The only LinkedIn account in Unipile is the owner's own (UNIPILE_NETWORK_ACCOUNT_ID), which research never uses",
    };
  }
  // With the owner's account set up, research is never picked by elimination: a wrong
  // UNIPILE_NETWORK_ACCOUNT_ID (the research account's id) would leave the owner's as "the other one".
  if (network) {
    return {
      ok: false,
      code: "ambiguous",
      message: "UNIPILE_NETWORK_ACCOUNT_ID is set: pin UNIPILE_ACCOUNT_ID to the research account too, so research never guesses",
    };
  }
  if (others.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: "Several LinkedIn accounts are connected in Unipile: set UNIPILE_ACCOUNT_ID to the research account, so research never guesses",
    };
  }
  const only = others[0];
  if (!someOk(only)) {
    return {
      ok: false,
      code: "not_running",
      message: `No connected LinkedIn account is running in Unipile (status ${statusText(only.statuses)}); reconnect it in the Unipile dashboard`,
    };
  }
  return { ok: true, id: only.id };
}

export type NetworkAccountState = "connected" | "needs_reconnect" | "missing" | "not_linkedin";

/** The owner's own account (UNIPILE_NETWORK_ACCOUNT_ID) in the accounts list: running, or what is wrong. */
export function networkAccountState(accounts: UnipileAccountInfo[], networkId: string): { state: NetworkAccountState; statuses: string[] } {
  const acc = accounts.find((a) => a.id === networkId.trim());
  if (!acc) return { state: "missing", statuses: [] };
  if (!isLinkedIn(acc)) return { state: "not_linkedin", statuses: acc.statuses };
  return { state: someOk(acc) ? "connected" : "needs_reconnect", statuses: acc.statuses };
}
