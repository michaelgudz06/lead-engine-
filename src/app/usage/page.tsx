import type { Metadata } from "next";
import { UsageDashboard } from "@/components/usage/dashboard";
import { DEFAULT_WINDOW, isUsageWindow } from "@/lib/usage/view";

export const metadata: Metadata = { title: "Usage" };

/**
 * /usage: what each key has spent and how long its calls took, per provider, per request,
 * per research run and per lead. Open to everyone who can open the app (src/proxy.ts).
 * ?window= picks the opening view.
 */
export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const requested = (await searchParams).window;
  return <UsageDashboard initialWindow={isUsageWindow(requested) ? requested : DEFAULT_WINDOW} />;
}
