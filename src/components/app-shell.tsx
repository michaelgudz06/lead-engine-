"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getStatusCached, logout } from "@/lib/api-client";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Leads" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/settings", label: "Settings" },
];

function isActive(pathname: string, href: string): boolean {
  // Lead pages belong to "Leads".
  if (href === "/") return pathname === "/" || pathname.startsWith("/leads");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const onLogin = pathname.startsWith("/login");
  const [authEnabled, setAuthEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // "Log out" only makes sense when the password gate is on (APP_PASSWORD set).
  useEffect(() => {
    if (onLogin) return;
    let alive = true;
    getStatusCached()
      .then((s) => alive && setAuthEnabled(s.authEnabled))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [onLogin]);

  if (onLogin) return <>{children}</>;

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } catch {
      // Even if the call failed, the login page is the right place to land.
    }
    // A full navigation, so no cached page data survives the session.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/login");
  }

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-white">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-hairline bg-paper">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
          <Link href="/" className="shrink-0 rounded font-serif text-[21px] leading-none tracking-[-0.01em]">
            Lead Engine
          </Link>
          <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            {authEnabled && (
              <button type="button" onClick={handleLogout} disabled={loggingOut} className="btn btn-ghost btn-sm text-quiet hover:text-ink">
                {loggingOut ? "Logging out…" : "Log out"}
              </button>
            )}
            <Link href="/leads/new" className="btn btn-primary">
              <span aria-hidden className="-mt-px text-[16px] leading-none">
                +
              </span>
              New lead
            </Link>
          </div>
        </div>
        {/* Phone: the nav moves to its own row so nothing is squeezed. */}
        <nav aria-label="Main" className="flex items-center gap-1 border-t border-hairline px-3 py-1.5 sm:hidden">
          {NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-20 pt-8 sm:px-6 sm:pt-10">
        {children}
      </main>
    </div>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx("rounded-md px-2.5 py-1.5 text-[14px] transition-colors", active ? "font-medium text-ink" : "text-quiet hover:bg-wash hover:text-ink")}
    >
      {label}
    </Link>
  );
}
