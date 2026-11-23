import "server-only";
import type { ProviderStatus } from "../types";

/**
 * Abstract's checkpoint inspect (POST https://api.abstract.inc/v1/models/inspect).
 * Needs ABSTRACT_API_KEY; without it, return configured:false and do nothing.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 */
export interface InspectResult {
  configured: boolean;
  servable: boolean | null;
  /** The Abstract model lane that would run it, e.g. allenai/molmoact2. */
  model: string | null;
  problems: string[];
  checkpointUri: string | null;
  estimatedVramGib: number | null;
  error?: string;
}

/** repoId like "acme/yam-towels" or "hf://acme/yam-towels@main". Never throws. */
export async function inspectCheckpoint(repoId: string): Promise<InspectResult> {
  void repoId;
  throw new Error("not implemented");
}

export function abstractStatus(): ProviderStatus {
  throw new Error("not implemented");
}
