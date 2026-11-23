/**
 * Client instrumentation: Next.js runs this file in the browser before the app hydrates.
 *
 * It starts PostHog product analytics when NEXT_PUBLIC_POSTHOG_KEY was set at build time,
 * and does nothing at all otherwise: no download, no request, no error. What is tracked,
 * how, and the privacy rules all live in src/lib/analytics.ts.
 */
import { analyticsKey, attachAnalytics, posthogInitOptions, trackNavigationStart } from "@/lib/analytics";

const key = analyticsKey();

if (key) {
  // posthog-js is its own chunk, fetched only when analytics is on. Next.js does not wait for
  // it, so analytics never delays the page; track() holds the few events sent before it is up.
  import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(key, posthogInitOptions());
      attachAnalytics(posthog);
    })
    .catch(() => {
      // Blocked or failed to load: the app works the same without analytics.
    });
}

/** A client-side navigation is starting: the visitor is leaving the current page. */
export function onRouterTransitionStart(url: string, navigationType: "push" | "replace" | "traverse"): void {
  trackNavigationStart(url, navigationType);
}
