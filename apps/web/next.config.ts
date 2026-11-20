import type { NextConfig } from "next";
import withPWAInit, { runtimeCaching as defaultRuntimeCaching } from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  workboxOptions: {
    // Account-link pages are never stored by the service worker (the default
    // "pages" rule would cache them for 24h). This rule must come first: the
    // first matching route wins. The function is serialized into sw.js, so it
    // must not reference anything outside its own body.
    runtimeCaching: [
      {
        urlPattern: ({ url, sameOrigin }) =>
          sameOrigin && /^\/(?:forgot-password|reset-password|activate)\/?$/.test(url.pathname),
        handler: "NetworkOnly",
        method: "GET",
      },
      ...defaultRuntimeCaching,
    ],
  },
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@campusgate/shared"],
  // Always inline the (optional) Sentry DSN, as "" when unset, so webpack can
  // drop the guarded `import("@sentry/nextjs")` branches entirely. Otherwise the
  // SDK chunks are still emitted and land in the PWA precache with no DSN.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "" },
  // Account-link pages carry a one-time token in the URL fragment: never send a
  // Referer, never cache, never frame.
  async headers() {
    const headers = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Frame-Options", value: "DENY" },
    ];
    return ["/forgot-password", "/reset-password", "/activate"].map((source) => ({ source, headers }));
  },
};

export default withPWA(nextConfig);
