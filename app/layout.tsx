import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "SafePrint — print without handing over your documents",
  description:
    "Share a document with a photocopy shop for one print — no download, no copy left behind.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading request headers renders pages per request, which is what lets
  // Next stamp each response's CSP nonce (see middleware.ts) on its scripts.
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
