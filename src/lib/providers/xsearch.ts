import "server-only";
import type { ProviderStatus } from "../types";

/**
 * X (Twitter) through OpenRouter: a Grok model with the openrouter:web_search
 * server tool, engine "native", and x_search opted in. X search is billed per
 * post and per profile returned, so every call is pinned to one handle and a
 * date window. CONTRACT: signatures fixed; owned by the x agent.
 */

export interface XPost {
  url: string | null;
  text: string;
  postedAt: string | null;
}

/**
 * Finds the person's X handle. Returns null unless Grok can show evidence that
 * the account belongs to this person (bio names the company, links match, etc.).
 */
export async function findXHandle(input: {
  name: string;
  company?: string | null;
  title?: string | null;
  /** URLs already known to belong to the person (personal site, GitHub, LinkedIn). */
  hints?: string[];
}): Promise<{ handle: string | null; confidence: number; evidence: string | null; error?: string }> {
  void input;
  throw new Error("not implemented");
}

/** Recent posts from one handle, newest first. Never throws. */
export async function getXPosts(
  handle: string,
  opts?: { fromDate?: string; focus?: string; maxPosts?: number },
): Promise<{ posts: XPost[]; summary: string | null; error?: string }> {
  void handle;
  void opts;
  throw new Error("not implemented");
}

export function xStatus(): ProviderStatus {
  throw new Error("not implemented");
}
