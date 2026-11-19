// Server/edge Sentry (Next.js instrumentation hook). No-op unless
// NEXT_PUBLIC_SENTRY_DSN is set; the SDK is only loaded when it is. The guards
// are `if (dsn) { ... }` blocks so the build drops them when the DSN is "".
export async function register() {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    if (process.env.NEXT_RUNTIME === "nodejs" || process.env.NEXT_RUNTIME === "edge") {
      const [Sentry, { sentryOptions }] = await Promise.all([
        import("@sentry/nextjs"),
        import("./lib/sentryOptions"),
      ]);
      Sentry.init(sentryOptions());
    }
  }
}

// Captures errors from Server Components, route handlers and middleware.
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(...args);
  }
}
