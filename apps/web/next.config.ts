import type { NextConfig } from "next";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@campusgate/shared"],
  // Always inline the (optional) Sentry DSN, as "" when unset, so webpack can
  // drop the guarded `import("@sentry/nextjs")` branches entirely. Otherwise the
  // SDK chunks are still emitted and land in the PWA precache with no DSN.
  env: { NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN ?? "" },
};

export default withPWA(nextConfig);
