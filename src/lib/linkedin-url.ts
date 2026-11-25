/**
 * LinkedIn profile URLs: the slug the app keys leads (and the owner's connections) by. Pure and
 * client-safe, so the browser reads a Connections.csv export with the same rules the server uses.
 * src/lib/http.ts re-exports both functions for the server code that imports them from there.
 */

/**
 * Normalises a LinkedIn profile URL and returns its public slug, or null.
 * Vanity slugs are case-insensitive and lowercased; member-id slugs (ACoAA..., ADoAA...)
 * are case-sensitive and kept as they are. A malformed %-escape returns null, not a throw.
 */
export function linkedinSlug(url: string): string | null {
  const m = String(url ?? "").trim().match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).trim();
  } catch {
    return null;
  }
  if (!slug) return null;
  return /^A[CD]o[A-Za-z0-9_-]{8,}$/.test(slug) ? slug : slug.toLowerCase();
}

export function normaliseLinkedinUrl(url: string): string | null {
  const slug = linkedinSlug(url);
  return slug ? `https://www.linkedin.com/in/${slug}` : null;
}
