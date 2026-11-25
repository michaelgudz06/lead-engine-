import "server-only";
import { createHash } from "node:crypto";

/**
 * Path ids as routes and the page see them. A path is built under an internal key: "direct", or
 * "li:<LinkedIn slug or member id>" for a LinkedIn person, "x:<numeric X id>" for an X-only person
 * (src/lib/paths/build.ts). Slugs are usually names, and route URLs reach request logs, so the id a
 * path is stored and served under is opaque: "direct", or the network ("li" or "x") and 12 hex
 * characters of a hash of the lead id and the key. It is stable across checks (intro drafts and
 * "asked" dates are kept by it), differs from lead to lead, and names nobody. The network part
 * lets a removal of your connections or X lists drop the right paths and drafts.
 */

/** A stored or served path id: "direct", "li-<12 hex>" or "x-<12 hex>". */
export const PATH_ID_RE = /^(?:direct|li-[0-9a-f]{12}|x-[0-9a-f]{12})$/;

/** The opaque id of a path built under `key` for this lead. */
export function publicPathId(leadId: string, key: string): string {
  if (key === "direct") return key;
  const network = key.startsWith("x:") ? "x" : "li";
  const hash = createHash("sha256").update(`warm-path\n${leadId.toLowerCase()}\n${key}`).digest("hex").slice(0, 12);
  return `${network}-${hash}`;
}

/** True for an id a route accepts. */
export function isPathId(value: unknown): value is string {
  return typeof value === "string" && PATH_ID_RE.test(value);
}
