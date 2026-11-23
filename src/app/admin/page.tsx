import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { adminAllowed } from "@/lib/admin/access";
import { DEFAULT_WINDOW, isUsageWindow } from "@/lib/admin/types";
import { AdminDashboard } from "@/components/admin/dashboard";

/**
 * /admin: the usage panel (see layout.tsx for who may open it). The layout has checked
 * already; the page checks once more, as it costs nothing. ?window= picks the opening view.
 */
export default async function AdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!adminAllowed({ headers: await headers() })) notFound();
  const requested = (await searchParams).window;
  return <AdminDashboard initialWindow={isUsageWindow(requested) ? requested : DEFAULT_WINDOW} />;
}
