import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DealZ",
  description: "Price history and curated deals for consumer tech in Australia.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-AU" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
