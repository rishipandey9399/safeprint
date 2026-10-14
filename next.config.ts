import type { NextConfig } from "next";

const noStoreHeaders = [
  { key: "Cache-Control", value: "no-store, no-cache, must-revalidate, max-age=0" },
  { key: "Pragma", value: "no-cache" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // SafePrint serves no optimized images; switching the optimizer off removes
  // the /_next/image endpoint and its attack surface entirely.
  images: { unoptimized: true },
  // Keep the GCS SDK out of the bundle — it's require()d at runtime only
  // when STORAGE_DRIVER=gcs, and isn't installed for local dev.
  serverExternalPackages: ["@google-cloud/storage"],
  async headers() {
    return [
      { source: "/shop", headers: noStoreHeaders },
      {
        source: "/api/:path*",
        // API responses are data, never documents to render or frame.
        headers: [...noStoreHeaders, { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" }],
      },
    ];
  },
};

export default nextConfig;
