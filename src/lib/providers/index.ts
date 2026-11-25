import "server-only";
import type { ProviderStatus } from "../types";
import { abstractStatus } from "./abstract";
import { apolloStatus } from "./apollo";
import { exaStatus } from "./exa";
import { hubStatus } from "./huggingface";
import { hubspotStatus } from "./hubspot";
import { hunterStatus } from "./hunter";
import { linkedinStatus } from "./linkedin";
import { xGraphStatus } from "./xgraph";
import { xStatus } from "./xsearch";

/** One row per integration for the Settings page. Never throws. */
export function providerStatuses(): ProviderStatus[] {
  const fns: Array<[string, () => ProviderStatus]> = [
    ["linkedin", linkedinStatus],
    ["exa", exaStatus],
    ["apollo", apolloStatus],
    ["hunter", hunterStatus],
    ["x", xStatus],
    ["huggingface", hubStatus],
    ["abstract", abstractStatus],
    ["hubspot", hubspotStatus],
    ["twitterapi", xGraphStatus],
  ];
  return fns.map(([id, fn]) => {
    try {
      return fn();
    } catch (err) {
      return { id, label: id, configured: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });
}
