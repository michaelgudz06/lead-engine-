import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { adminAllowed } from "@/lib/admin/access";

/**
 * The owner's usage panel. Not linked from anywhere, and no password: it only opens on the
 * owner's own computer, run with `npm run admin` (http://127.0.0.1:3001/admin) or
 * `npm run dev`. src/proxy.ts turns every other request away first; this layout checks again
 * on every render, so a page under /admin never renders for anyone else even if the proxy
 * were skipped. Refused requests get the usual 404 page.
 */

async function allowed(): Promise<boolean> {
  return adminAllowed({ headers: await headers() });
}

export async function generateMetadata(): Promise<Metadata> {
  // Nothing about the panel, not even its title, for a request that may not see it.
  if (!(await allowed())) return {};
  return {
    title: "Usage",
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
    referrer: "same-origin",
  };
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await allowed())) notFound();
  return children;
}
