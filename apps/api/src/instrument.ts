/**
 * Optional Sentry error tracking. Imported FIRST in server.ts.
 *
 * With no SENTRY_DSN this module does nothing: the SDK is not even loaded, so
 * there is no network traffic and no behavior change. With SENTRY_DSN set,
 * unhandled 5xx errors are reported (the Fastify integration skips 3xx/4xx by
 * default) after passing through the PII scrubber in sentry-scrub.ts.
 */
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub.js";

type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | undefined;

if (process.env.SENTRY_DSN) {
  sentry = await import("@sentry/node");
  sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: 0, // errors only
    // Captures route/hook errors; 3xx/4xx (400/401/403/404/409/422/429) are
    // skipped by the integration's default shouldHandleError.
    integrations: [sentry.fastifyIntegration()],
    // v11 replacement for `sendDefaultPii: false`: collect no user info,
    // cookies, headers, bodies, query params or DB payloads automatically.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
    },
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
  });
}

export const sentryEnabled = sentry !== undefined;

/** Attach only the opaque user id to subsequent events of this request. */
export function setSentryUserId(userId: string | undefined): void {
  if (sentry && userId) sentry.getIsolationScope().setUser({ id: userId });
}
