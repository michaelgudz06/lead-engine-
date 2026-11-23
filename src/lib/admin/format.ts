/**
 * Money, counts and unit wording for the owner's usage panel. Pure and client-safe: the
 * server writes balance summaries with it and the panel's components render with it.
 */
import type { UsageProvider, UsageUnits } from "../usage/types";

/**
 * US dollars at a precision that suits the amount. A single call costs fractions of a cent,
 * so amounts under a dollar keep up to four decimals: "$0", "<$0.0001", "$0.007", "$0.1012",
 * "$0.42", then "$12.35" and "$1,234.50". "–" for null or not-a-number.
 */
export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  if (value === 0) return "$0";
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (v < 0.0001) return `${sign}<$0.0001`;
  if (v < 1) {
    // Four decimals, trailing zeros dropped down to two ("0.4200" -> "0.42", "0.0070" -> "0.007").
    const text = v.toFixed(4).replace(/(\.\d\d\d*?)0+$/, "$1");
    return `${sign}$${text}`;
  }
  return `${sign}$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 940, 12.3K, 590K, 1.3M: at most three significant digits and one decimal. */
export function compactCount(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const v = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (v < 1000) return `${sign}${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  const [scaled, suffix] = v < 1e6 ? [v / 1e3, "K"] : v < 1e9 ? [v / 1e6, "M"] : [v / 1e9, "B"];
  // 999,950 would round to "1000K": say "1M" instead.
  if (Number(scaled.toFixed(scaled < 100 ? 1 : 0)) >= 1000 && suffix !== "B") return `${sign}1${suffix === "K" ? "M" : "B"}`;
  const text = scaled < 100 ? scaled.toFixed(1).replace(/\.0$/, "") : Math.round(scaled).toString();
  return `${sign}${text}${suffix}`;
}

/** Whole counts in full below 10,000 ("1,204", "0.5"), compact above ("12.3K"). */
export function formatCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "–";
  if (Math.abs(value) < 10_000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return compactCount(value);
}

/** "1 call", "12 calls", "1 search", "3 searches". */
export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** A 0..1 share as a percentage: "26%", "<1%" for a sliver, "100%". */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  if (share < 1 && Math.round(share * 100) === 100) return "99%";
  return `${Math.round(Math.min(1, share) * 100)}%`;
}

/** How long a call took: "340 ms", "2.3 s", "45 s", "2 min 5 s"; "" when unknown. */
export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

// ------------------------------------------------------------------ units

/** Words for the unit names writers use (src/lib/usage/types.ts), in display order. */
const UNIT_WORDS: ReadonlyArray<[key: string, one: string, many: string]> = [
  ["inputTokens", "input token", "input tokens"],
  ["outputTokens", "output token", "output tokens"],
  ["cacheReadTokens", "cache-read token", "cache-read tokens"],
  ["cacheWriteTokens", "cache-write token", "cache-write tokens"],
  ["searches", "search", "searches"],
  ["contents", "page read", "pages read"],
  ["results", "result", "results"],
  ["requests", "request", "requests"],
  ["runs", "run", "runs"],
  ["items", "item", "items"],
  ["lookups", "lookup", "lookups"],
  ["credits", "credit", "credits"],
  ["xPosts", "X post", "X posts"],
  ["xProfiles", "X profile", "X profiles"],
  ["promptTokens", "prompt token", "prompt tokens"],
  ["completionTokens", "completion token", "completion tokens"],
];
const KNOWN_UNITS = new Set(UNIT_WORDS.map(([key]) => key));

const n = (units: UsageUnits, key: string): number => {
  const v = units?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

/** Every non-zero unit of one ledger row, e.g. "411 input tokens · 26 output tokens". "" when none. */
export function unitsLine(units: UsageUnits): string {
  const parts = UNIT_WORDS.filter(([key]) => n(units, key) !== 0).map(([key, one, many]) => plural(n(units, key), one, many));
  const extra = Object.keys(units ?? {})
    .filter((key) => !KNOWN_UNITS.has(key) && n(units, key) !== 0)
    .sort()
    .map((key) => `${formatCount(n(units, key))} ${key}`);
  return [...parts, ...extra].join(" · ");
}

/** Which units a provider card shows, in order. Anthropic is worded separately. */
const KEY_UNITS: Record<Exclude<UsageProvider, "anthropic">, string[]> = {
  exa: ["searches", "contents"],
  unipile: ["requests"],
  apify: ["runs", "items"],
  apollo: ["credits"],
  hunter: ["lookups", "credits"],
  openrouter: ["requests", "xPosts"],
  huggingface: ["requests"],
  abstract: ["requests"],
  hubspot: ["requests"],
};

/** The units that matter for a provider over a window: "590K in · 84.5K out tokens", "27 searches · 3 pages read". */
export function keyUnitsLine(provider: UsageProvider, units: UsageUnits): string {
  if (provider === "anthropic") {
    const input = n(units, "inputTokens");
    const output = n(units, "outputTokens");
    const cached = n(units, "cacheReadTokens") + n(units, "cacheWriteTokens");
    if (input + output + cached === 0) return "";
    return `${compactCount(input)} in · ${compactCount(output)} out${cached > 0 ? ` · ${compactCount(cached)} cached` : ""} tokens`;
  }
  const words = new Map(UNIT_WORDS.map(([key, one, many]) => [key, [one, many] as const]));
  return KEY_UNITS[provider]
    .filter((key) => n(units, key) !== 0)
    .map((key) => {
      const [one, many] = provider === "openrouter" && key === "requests" ? (["X search", "X searches"] as const) : (words.get(key) ?? [key, key]);
      return plural(n(units, key), one, many);
    })
    .join(" · ");
}

/** The one unit that best sums up a provider's work for a lead, for the per-lead table. */
export function mainUnit(provider: UsageProvider, units: UsageUnits): string {
  switch (provider) {
    case "anthropic": {
      const tokens = n(units, "inputTokens") + n(units, "outputTokens") + n(units, "cacheReadTokens") + n(units, "cacheWriteTokens");
      return tokens > 0 ? `${compactCount(tokens)} tokens` : "";
    }
    case "exa":
      if (n(units, "searches") > 0) return plural(n(units, "searches"), "search", "searches");
      return n(units, "contents") > 0 ? plural(n(units, "contents"), "page read", "pages read") : "";
    case "apify":
      if (n(units, "items") > 0) return plural(n(units, "items"), "item");
      return n(units, "runs") > 0 ? plural(n(units, "runs"), "run") : "";
    case "apollo":
      return n(units, "credits") > 0 ? plural(n(units, "credits"), "credit") : "";
    case "hunter":
      return n(units, "lookups") > 0 ? plural(n(units, "lookups"), "lookup") : "";
    case "openrouter":
      return n(units, "requests") > 0 ? plural(n(units, "requests"), "X search", "X searches") : "";
    default:
      return n(units, "requests") > 0 ? plural(n(units, "requests"), "request") : "";
  }
}
