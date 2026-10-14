import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers for every page: a nonce-based Content-Security-Policy
 * (Next stamps the nonce onto its own scripts when it sees it in the request's
 * CSP header), no framing, no referrer, HSTS in production.
 *
 * The only third-party origin is the self-hosted ONLYOFFICE Document Server
 * (Word editor script + iframe), and only when it is configured.
 */
function onlyofficeOrigin(): string {
  try {
    return process.env.ONLYOFFICE_URL ? new URL(process.env.ONLYOFFICE_URL).origin : "";
  } catch {
    return "";
  }
}

export function middleware(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";
  const oo = onlyofficeOrigin();

  const csp = [
    "default-src 'self'",
    // 'strict-dynamic': scripts our nonce'd scripts load (pdf.js chunks, the
    // ONLYOFFICE api.js) are trusted; nothing injected into the page is.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${oo ? ` ${oo}` : ""}${isDev ? " 'unsafe-eval'" : ""}`,
    // React style attributes and the editors' positioned overlays.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${oo ? ` ${oo}` : ""}${isDev ? " ws:" : ""}`,
    "worker-src 'self' blob:",
    `frame-src ${oo || "'none'"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (!isDev) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

export const config = {
  // Pages only; API routes set their own no-store/no-frame headers, and
  // static assets need none.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico).*)",
      missing: [{ type: "header", key: "next-router-prefetch" }],
    },
  ],
};
