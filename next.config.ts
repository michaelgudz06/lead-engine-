import type { NextConfig } from "next";

/**
 * PostHog's upstream hosts for NEXT_PUBLIC_POSTHOG_HOST: US Cloud by default, EU Cloud when
 * the host names it (eu.i.posthog.com), and any other http(s) origin as a self-hosted
 * instance. Mirrors posthogHosts() in src/lib/analytics.ts (this file imports nothing from
 * src/); scripts/test-analytics.ts checks that the two agree.
 */
function posthogUpstream(raw: string | undefined): { api: string; assets: string } {
  const us = { api: "https://us.i.posthog.com", assets: "https://us-assets.i.posthog.com" };
  const eu = { api: "https://eu.i.posthog.com", assets: "https://eu-assets.i.posthog.com" };
  const value = raw?.trim();
  if (!value) return us;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "posthog.com" || host.endsWith(".posthog.com")) return /^eu[.-]/.test(host) ? eu : us;
    if (url.protocol === "https:" || url.protocol === "http:") return { api: url.origin, assets: url.origin };
  } catch {
    // Not a URL: fall back to US Cloud.
  }
  return us;
}

// Cache Components and partial prefetching are off on purpose: every page here
// shows live, per-lead data that changes while research runs, so nothing is
// worth prerendering, and the classic dynamic model keeps the code simple.
const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },

  // posthog-node (src/lib/analytics-server.ts) loads from node_modules instead of the bundle:
  // it lazily imports optional extras (email rendering, OpenTelemetry) that are not installed.
  serverExternalPackages: ["posthog-node"],

  // Product analytics (src/lib/analytics.ts) reaches PostHog through /ingest on this site, a
  // same-origin reverse proxy, so the browser never calls posthog.com itself. PostHog's API
  // paths end with a slash (/e/, /flags/), which Next.js would otherwise answer with a 308.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    // Analytics off (no public "phc_" project key at build time): no proxy at all.
    if (!/^phc_[A-Za-z0-9_-]+$/.test(process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim() ?? "")) return [];
    const { api, assets } = posthogUpstream(process.env.NEXT_PUBLIC_POSTHOG_HOST);
    // Order matters: the asset routes must come before the catch-all.
    return [
      { source: "/ingest/static/:path*", destination: `${assets}/static/:path*` },
      { source: "/ingest/array/:path*", destination: `${assets}/array/:path*` },
      { source: "/ingest/:path*", destination: `${api}/:path*` },
    ];
  },
};

export default nextConfig;
