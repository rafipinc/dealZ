import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { buildLog } from "../lib/data.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "DealZ build log", template: "%s · DealZ build log" },
  description: "How DealZ is built: every architecture decision, who made it, and the stage of every component.",
};

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/decisions/", label: "Decisions" },
  { href: "/build-map/", label: "Build map" },
  { href: "/timeline/", label: "Timeline" },
  { href: "/journeys/", label: "Journeys" },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand">
              DealZ <span>build log</span>
            </Link>
            <nav aria-label="Sections">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href}>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
        <footer className="wrap site-footer">
          Generated from the repository&apos;s decision records, registries and commit history on{" "}
          {buildLog.generatedAt.slice(0, 10)}.
        </footer>
      </body>
    </html>
  );
}
