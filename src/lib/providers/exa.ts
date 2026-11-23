import "server-only";
import type { ProviderStatus } from "../types";

/**
 * Exa: web search, people search (category "people") and page contents.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 */

export interface ExaResult {
  url: string;
  title: string | null;
  publishedDate: string | null;
  author: string | null;
  /** Page text, capped by textChars. */
  text: string | null;
  highlights: string[];
}

export type ExaCategory = "people" | "company" | "news" | "research paper" | "pdf" | "personal site" | "financial report";

/** Throws on HTTP/config errors so callers can log them. */
export async function exaSearch(
  query: string,
  opts?: {
    numResults?: number;
    category?: ExaCategory;
    includeDomains?: string[];
    excludeDomains?: string[];
    /** ISO date; only results published on or after it. */
    startPublishedDate?: string;
    textChars?: number;
  },
): Promise<ExaResult[]> {
  void query;
  void opts;
  throw new Error("not implemented");
}

/** Fetches page text for known URLs. Throws on HTTP/config errors. */
export async function exaContents(urls: string[], opts?: { textChars?: number }): Promise<ExaResult[]> {
  void urls;
  void opts;
  throw new Error("not implemented");
}

export function exaStatus(): ProviderStatus {
  throw new Error("not implemented");
}
