import "server-only";
import type { ProviderStatus } from "../types";

/**
 * Hugging Face Hub (public API, no key): find a company's or person's account,
 * list their models and datasets, and flag fine-tunes of models Abstract serves.
 * CONTRACT: signatures fixed; owned by the exa-hub agent.
 */

export interface HubAccount {
  id: string;
  type: "org" | "user";
  url: string;
  fullName: string | null;
}

export interface HubModel {
  id: string;
  url: string;
  lastModified: string | null;
  downloads: number | null;
  likes: number | null;
  baseModels: string[];
  /** Set when a base model is one Abstract serves (see SERVED_BASE_MODELS). */
  servedBase: string | null;
  tags: string[];
}

export interface HubDataset {
  id: string;
  url: string;
  lastModified: string | null;
  tags: string[];
}

/** Base checkpoints whose fine-tunes Abstract can deploy (docs.abstract.inc/robots/deployments). */
export const SERVED_BASE_MODELS: string[] = [
  "allenai/MolmoAct2-BimanualYAM",
  "lerobot/pi05_base",
  "vernerobotics/v0.5-base",
  "runwayml/praxis-1-yam",
  "microsoft/rho-yam-box",
  "black-forest-labs/flux-3-action-droid",
  "PerceptronAI/Isaac-0.5",
];

export async function searchHubAccounts(queryText: string): Promise<HubAccount[]> {
  void queryText;
  throw new Error("not implemented");
}

export async function getHubModels(author: string, limit?: number): Promise<HubModel[]> {
  void author;
  void limit;
  throw new Error("not implemented");
}

export async function getHubDatasets(author: string, limit?: number): Promise<HubDataset[]> {
  void author;
  void limit;
  throw new Error("not implemented");
}

export function hubStatus(): ProviderStatus {
  throw new Error("not implemented");
}
