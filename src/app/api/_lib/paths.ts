import "server-only";
import { isPathId } from "@/lib/paths/ids";
import { UUID_RE } from "./api";

/**
 * Route params for /api/leads/[id]/paths/[pathId]/... (warm paths). Private folder: no route here.
 *
 * A path id is opaque: "direct", or "li-" or "x-" and 12 hex characters (src/lib/paths/ids.ts), so
 * no name, slug or handle is ever in a URL or a request log. Anything else is refused, so an id
 * can never end like a static file (the proxy's matcher skips those paths).
 */

export type PathRouteContext = { params: Promise<{ id: string; pathId: string }> };

export { isPathId };

/** The lead id (a UUID, lower case) and the path id, or null for either when it is malformed. */
export async function pathParamsFrom(ctx: PathRouteContext): Promise<{ id: string | null; pathId: string | null }> {
  const { id, pathId } = await ctx.params;
  return {
    id: typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null,
    pathId: isPathId(pathId) ? pathId : null,
  };
}
