import type { Metadata, Viewport } from "next";
import { Inter, Newsreader } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], display: "swap" });
const newsreader = Newsreader({ variable: "--font-newsreader", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: "Lead Engine", template: "%s · Lead Engine" },
  description: "Research one lead deeply, then write outreach worth sending.",
  // Private team tool: keep it out of search engines even if the URL leaks.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${newsreader.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
