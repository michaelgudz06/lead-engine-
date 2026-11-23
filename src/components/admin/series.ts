/**
 * Provider names and chart colours for the admin panel. Client-safe.
 *
 * Colours follow the provider, never its rank, so a provider keeps its colour whatever the
 * window or the data. They are the first six slots of the validated categorical palette, in
 * slot order (the order is what keeps neighbouring stack segments apart for colour-blind
 * readers); providers that never cost anything fold into a neutral "Other".
 */
import type { UsageProvider } from "@/lib/usage/types";

export const SHORT_LABELS: Record<UsageProvider, string> = {
  anthropic: "Anthropic",
  exa: "Exa",
  unipile: "Unipile",
  apify: "Apify",
  apollo: "Apollo",
  hunter: "Hunter",
  openrouter: "OpenRouter",
  huggingface: "Hugging Face",
  abstract: "Abstract",
  hubspot: "HubSpot",
};

export type SeriesId = "anthropic" | "exa" | "openrouter" | "apify" | "apollo" | "hunter" | "other";

/** Stack order, bottom first: the palette's slot order. */
export const SERIES: ReadonlyArray<{ id: SeriesId; label: string; color: string }> = [
  { id: "anthropic", label: "Anthropic", color: "#2a78d6" },
  { id: "exa", label: "Exa", color: "#eb6834" },
  { id: "openrouter", label: "OpenRouter", color: "#1baf7a" },
  { id: "apify", label: "Apify", color: "#eda100" },
  { id: "apollo", label: "Apollo", color: "#e87ba4" },
  { id: "hunter", label: "Hunter", color: "#008300" },
  { id: "other", label: "Other", color: "#898781" },
];

export function seriesOf(provider: UsageProvider): SeriesId {
  switch (provider) {
    case "anthropic":
    case "exa":
    case "openrouter":
    case "apify":
    case "apollo":
    case "hunter":
      return provider;
    default:
      return "other";
  }
}
